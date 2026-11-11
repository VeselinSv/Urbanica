import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { BALANCE, hashString, parseKey, tileKey, type TileMap, type TileState } from '@gce/shared';
import { REAL_PLACES, type WorldGenerator } from '@gce/world-generation';
import { CHUNK, paintChunk, paintCountry, paintStats, tunnelKind, type ChunkCanvas, type CityActor } from './paint';
import { TH, TW, getSprite } from './sprites';
import { CityLife, type IssueMarker, type NeedBadge } from './life';
import { Atmosphere, type DayMode, type Weather } from './atmosphere';
import type { Season } from './sprites';
import type { PaintJob, PaintReply } from './paint.worker';

export { TW, TH };
const PARCEL = BALANCE.world.parcelSize;

/** Изометрична проекция: горният връх на плочката (x, y). */
export function toScreen(x: number, y: number) {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}
export function toTile(px: number, py: number) {
  const a = px / (TW / 2);
  const b = py / (TH / 2);
  return { x: Math.floor((a + b) / 2), y: Math.floor((b - a) / 2) };
}

function mix(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function diamond(g: Graphics, x: number, y: number, size = 1, inset = 0) {
  const p = toScreen(x, y);
  const w = (TW / 2) * size;
  const h = (TH / 2) * size;
  g.poly([p.x, p.y + inset, p.x + w - inset * 2, p.y + h, p.x, p.y + 2 * h - inset, p.x - w + inset * 2, p.y + h]);
}

export interface CityRender {
  id: string;
  ownerId: string;
  name: string;
  tiles: TileMap;
  originX: number;
  originY: number;
}

export type LayerData = Record<string, number> | null;

/** Нива на детайлност: държава (една текстура), регион (чанкове с ниска резолюция), близо (пълен детайл). */
type Lod = 'mid' | 'near';
const LOD_FAR = 0.1;
const LOD_NEAR = 0.42;
const LOD_RES: Record<Lod, number> = { mid: 0.3, near: 1 };
const CACHE_CAP: Record<Lod, number> = { mid: 90, near: 24 };
const MIN_SCALE = 0.03;
const MAX_SCALE = 2.2;

interface ChunkEntry {
  sprite: Sprite | null;
  stale: boolean;
  used: number;
  /** Сградите на чанка като отделни спрайтове (само при близък изглед). */
  actors?: Sprite[];
}

/** Текстура за всяко платно на спрайт (платната са кеширани в sprites.ts – текстурите се споделят). */
const actorTex = new WeakMap<HTMLCanvasElement, Texture>();
function texFor(c: HTMLCanvasElement) {
  let t = actorTex.get(c);
  if (!t) actorTex.set(c, (t = Texture.from(c)));
  return t;
}

/**
 * Изометричен рендерер (PixiJS 8). Земята, пътищата, сградите и растителността на всеки чанк 32×32 се
 * рисуват веднъж в Canvas 2D (paint.ts) и се показват като една текстура – малко draw call-ове и плавна
 * работа и на телефон. Чанковете се изграждат прогресивно (бюджет на кадър), с кеш по ниво на детайлност
 * и инвалидиране само на засегнатите чанкове при промяна в града. Далечният изглед е една текстура на държавата.
 */
export class IsoRenderer {
  app = new Application();
  world = new Container();
  farLayer = new Container();
  chunkLayer = new Container();
  regionLayer = new Graphics();
  parcelLayer = new Graphics();
  overlayLayer = new Graphics();
  resourceLayer = new Graphics();
  cityFarLayer = new Graphics();
  uiLayer = new Graphics();
  labelLayer = new Container();
  private gen: WorldGenerator | null = null;
  private cityTiles = new Map<string, TileState>();
  private cityJson = new Map<string, string>();
  private cityList: CityRender[] = [];
  private chunks: Record<Lod, Map<string, ChunkEntry>> = { mid: new Map(), near: new Map() };
  private queue = new Map<string, { lod: Lod; cx: number; cy: number }>();
  private frame = 0;
  private target: { scale: number; x: number; y: number } | null = null;
  private labels: { t: Text; x: number; y: number; min: number; max: number }[] = [];
  private cityLabels = new Map<string, Text>();
  private zoning = false;
  private territory = new Set<string>();
  private lastResourcesKey = '';
  readonly stats = paintStats;
  life: CityLife | null = null;
  /** Текстурата на цялата държава – за мини-картата. */
  far: ChunkCanvas | null = null;
  readonly borderLayer = new Graphics();
  /** Магистрали между градовете. */
  readonly linkLayer = new Graphics();
  private issues: IssueMarker[] = [];
  ready = false;
  myUserId: string | null = null;
  activeCityId: string | null = null;
  showResources = false;
  showBorders = true;
  atmo: Atmosphere | null = null;
  season: Season = 'summer';
  /** Извиква се, когато камерата се е преместила (за презареждане на региона от сървъра). */
  onCameraChange: (() => void) | null = null;

  async init(el: HTMLElement) {
    await this.app.init({ resizeTo: el, background: 0x1c4a73, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
    el.appendChild(this.app.canvas);
    this.chunkLayer.sortableChildren = true;
    this.world.addChild(
      this.farLayer,
      this.chunkLayer,
      this.cityFarLayer,
      this.regionLayer,
      this.borderLayer,
      this.linkLayer,
      this.parcelLayer,
      this.overlayLayer,
      this.resourceLayer,
      this.uiLayer,
      this.labelLayer,
    );
    this.app.stage.addChild(this.world);
    this.app.ticker.add(() => this.tick());
    this.ready = true;
  }

  destroy() {
    this.painter?.terminate();
    this.painter = null;
    if (this.ready) this.app.destroy(true, { children: true, texture: true });
    this.ready = false;
  }

  setWorld(gen: WorldGenerator) {
    this.gen = gen;
    this.startPainter(gen.seed);
    // далечен изглед – цялата държава в една текстура
    const far = paintCountry(gen, 0.1);
    this.far = far;
    const sp = new Sprite(Texture.from(far.canvas));
    sp.position.set(far.sx, far.sy);
    sp.scale.set(1 / far.res);
    this.farLayer.addChild(sp);
    this.drawRegionBorders();
    this.buildLabels();
    // жив слой: коли, дим, облаци, сигнали
    this.life = new CityLife(gen.size);
    const life = this.life;
    this.world.addChildAt(life.ground, this.world.getChildIndex(this.chunkLayer) + 1);
    this.world.addChildAt(life.water, this.world.getChildIndex(life.ground));
    this.world.addChildAt(life.cars, this.world.getChildIndex(life.ground) + 1);
    this.world.addChildAt(life.smoke, this.world.getChildIndex(this.uiLayer));
    this.world.addChildAt(life.clouds, this.world.getChildIndex(this.uiLayer));
    this.world.addChildAt(life.markers, this.world.getChildIndex(this.labelLayer));
    life.setTiles(this.cityTiles);
    life.setIssues(this.issues);
    life.setNeeds(this.needs);
    // ден/нощ и време: затъмняване над сградите и колите, светлини отгоре, валежи над всичко
    const atmo = new Atmosphere(gen.size);
    this.atmo = atmo;
    this.world.addChildAt(atmo.dark, this.world.getChildIndex(life.cars) + 1);
    this.world.addChildAt(atmo.lights, this.world.getChildIndex(atmo.dark) + 1);
    this.app.stage.addChild(atmo.weatherLayer);
    life.traffic.lights = atmo.lights;
    atmo.setTiles(this.cityTiles);
  }

  /** Сезон – прерисува чанковете (сняг, есенни дървета). */
  setSeason(season: Season) {
    if (season === this.season) return;
    this.season = season;
    this.resetTerrain();
  }
  setWeather(w: Weather) {
    if (this.atmo) this.atmo.weather = w;
    if (this.life) this.life.traffic.snowing = w === 'snow';
  }
  /** Магистрали между градовете: тъмна лента с жълта ос, от център до център. */
  setLinks(links: { a: { originX: number; originY: number }; b: { originX: number; originY: number } }[]) {
    const g = this.linkLayer;
    g.clear();
    for (const pass of [0, 1, 2]) {
      for (const l of links) {
        const a = toScreen(l.a.originX + 0.5, l.a.originY + 0.5);
        const b = toScreen(l.b.originX + 0.5, l.b.originY + 0.5);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
        if (pass === 0) g.stroke({ width: 22, color: 0x2f3237, alpha: 0.35, cap: 'round' });
        else if (pass === 1) g.stroke({ width: 14, color: 0x4a4d52, alpha: 0.9, cap: 'round' });
        else g.stroke({ width: 1.6, color: 0xe8c547, alpha: 0.9 });
      }
    }
  }

  setTrafficLoad(t: Record<string, number> | undefined) {
    this.life?.traffic.setLoad(t);
  }
  setDayMode(m: DayMode) {
    if (this.atmo) this.atmo.mode = m;
  }

  get scale() {
    return this.world.scale.x;
  }

  // ------------------------------------------------------------ камера
  /** Центрира камерата върху плочка (плавно, ако animate). */
  centerOn(x: number, y: number, scale?: number, animate = false) {
    const s = scale ?? this.scale;
    const p = toScreen(x + 0.5, y + 0.5);
    const pos = { x: this.app.screen.width / 2 - p.x * s, y: this.app.screen.height / 2 - p.y * s };
    if (animate) this.target = { scale: s, ...pos };
    else {
      this.target = null;
      this.world.scale.set(s);
      this.world.position.set(pos.x, pos.y);
    }
  }

  screenToTile(sx: number, sy: number) {
    return toTile((sx - this.world.x) / this.scale, (sy - this.world.y) / this.scale);
  }

  /** Плавно мащабиране около точка на екрана. */
  zoomAt(sx: number, sy: number, factor: number) {
    const cur = this.target ?? { scale: this.scale, x: this.world.x, y: this.world.y };
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cur.scale * factor));
    const wx = (sx - cur.x) / cur.scale;
    const wy = (sy - cur.y) / cur.scale;
    this.target = { scale: s1, x: sx - wx * s1, y: sy - wy * s1 };
  }

  /** Незабавно мащабиране (жест с два пръста). */
  zoomNow(sx: number, sy: number, factor: number) {
    this.target = null;
    const s0 = this.scale;
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * factor));
    const wx = (sx - this.world.x) / s0;
    const wy = (sy - this.world.y) / s0;
    this.world.scale.set(s1);
    this.world.position.set(sx - wx * s1, sy - wy * s1);
  }

  pan(dx: number, dy: number) {
    this.world.position.set(this.world.x + dx, this.world.y + dy);
    if (this.target) {
      this.target.x += dx;
      this.target.y += dy;
    }
  }

  /** Видим правоъгълник в плочки (обвиваща кутия на четирите ъгъла на екрана). */
  visibleTiles() {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const pts = [this.screenToTile(0, 0), this.screenToTile(w, 0), this.screenToTile(0, h), this.screenToTile(w, h + 300)];
    const size = this.gen?.size ?? BALANCE.world.size;
    const clampV = (v: number) => Math.max(0, Math.min(size - 1, v));
    return {
      x0: clampV(Math.min(...pts.map((p) => p.x)) - 2),
      y0: clampV(Math.min(...pts.map((p) => p.y)) - 2),
      x1: clampV(Math.max(...pts.map((p) => p.x)) + 2),
      y1: clampV(Math.max(...pts.map((p) => p.y)) + 2),
    };
  }

  private tick() {
    this.frame++;
    const dt = Math.min(0.1, this.app.ticker.deltaMS / 1000);
    this.life?.update(dt, this.scale);
    if (this.atmo) {
      this.atmo.update(dt, this.scale, this.app.screen.width, this.app.screen.height);
      if (this.life) this.life.traffic.night = this.atmo.night;
    }
    // отблясъци по видимата вода
    if (this.life && this.gen && this.scale >= 0.18 && this.frame % 2 === 0) {
      const v = this.visibleTiles();
      for (let i = 0; i < 4; i++) {
        const x = v.x0 + Math.floor(Math.random() * (v.x1 - v.x0 + 1));
        const y = v.y0 + Math.floor(Math.random() * (v.y1 - v.y0 + 1));
        if (this.gen.country.water[y * this.gen.size + x]) this.life.glint(x + Math.random(), y + Math.random());
      }
    }
    if (this.target) {
      const t = this.target;
      const k = 0.28;
      const s = this.scale + (t.scale - this.scale) * k;
      this.world.scale.set(s);
      this.world.position.set(this.world.x + (t.x - this.world.x) * k, this.world.y + (t.y - this.world.y) * k);
      if (Math.abs(t.scale - s) / t.scale < 0.002 && Math.abs(t.x - this.world.x) < 0.5 && Math.abs(t.y - this.world.y) < 0.5) {
        this.world.scale.set(t.scale);
        this.world.position.set(t.x, t.y);
        this.target = null;
        this.onCameraChange?.();
      }
      this.updateTerrain();
    }
    this.processQueue();
    this.updateLabels();
  }

  // ------------------------------------------------------------ чанкове
  private lookup = (x: number, y: number): TileState | undefined => {
    const k = tileKey(x, y);
    return this.cityTiles.get(k);
  };

  private currentLod(): Lod | null {
    const s = this.scale;
    if (s < LOD_FAR) return null;
    return s < LOD_NEAR ? 'mid' : 'near';
  }

  /** Обновява видимите чанкове: показва готовите, поръчва липсващите, освобождава старите. */
  updateTerrain() {
    if (!this.gen) return;
    const lod = this.currentLod();
    const s = this.scale;
    this.farLayer.alpha = 1;
    this.cityFarLayer.visible = s < LOD_FAR * 1.3;
    for (const l of ['mid', 'near'] as Lod[]) for (const e of this.chunks[l].values()) if (e.sprite) e.sprite.visible = false;
    this.queue.clear();
    if (lod) {
      const v = this.visibleTiles();
      const want: { cx: number; cy: number; d: number }[] = [];
      const ccx = (v.x0 + v.x1) / 2 / CHUNK;
      const ccy = (v.y0 + v.y1) / 2 / CHUNK;
      for (let cy = Math.floor(v.y0 / CHUNK); cy <= Math.floor(v.y1 / CHUNK); cy++)
        for (let cx = Math.floor(v.x0 / CHUNK); cx <= Math.floor(v.x1 / CHUNK); cx++) {
          if (!this.chunkOnScreen(cx, cy)) continue;
          want.push({ cx, cy, d: (cx + 0.5 - ccx) ** 2 + (cy + 0.5 - ccy) ** 2 });
        }
      want.sort((a, b) => a.d - b.d);
      for (const { cx, cy } of want) {
        const key = `${cx},${cy}`;
        const e = this.chunks[lod].get(key);
        if (e?.sprite) {
          e.sprite.visible = true;
          e.used = this.frame;
          if (e.stale) this.queue.set(`${lod}:${key}`, { lod, cx, cy });
          continue;
        }
        this.queue.set(`${lod}:${key}`, { lod, cx, cy });
        // резервен по-груб вариант, докато подробният се изгражда
        if (lod === 'near') {
          const m = this.chunks.mid.get(key);
          if (m?.sprite) {
            m.sprite.visible = true;
            m.used = this.frame;
          } else this.queue.set(`mid:${key}`, { lod: 'mid', cx, cy });
        }
      }
    }
    this.syncActors();
    this.evict();
    this.drawResources();
  }

  /** Сградите-спрайтове се виждат само когато се вижда близкият чанк, към който принадлежат. */
  private syncActors() {
    for (const e of this.chunks.near.values()) {
      if (!e.actors) continue;
      const v = !!e.sprite?.visible;
      for (const a of e.actors) a.visible = v;
    }
  }

  /** Дали ромбът на чанка (с поле за високите сгради) пресича екрана. */
  private chunkOnScreen(cx: number, cy: number) {
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const s = this.scale;
    const left = ((x0 - y0) * 32 - CHUNK * 32) * s + this.world.x;
    const right = ((x0 - y0) * 32 + CHUNK * 32) * s + this.world.x;
    const top = ((x0 + y0) * 16 - 300) * s + this.world.y;
    const bottom = ((x0 + y0) * 16 + CHUNK * 32) * s + this.world.y;
    return right > 0 && left < this.app.screen.width && bottom > 0 && top < this.app.screen.height;
  }

  private processQueue() {
    if (!this.gen || !this.queue.size) return;
    if (this.painter && this.painterReady) {
      const jobs = [...this.queue.entries()].sort((a, b) => (a[1].lod === b[1].lod ? 0 : a[1].lod === 'mid' ? -1 : 1));
      for (const [k, job] of jobs) {
        if (this.inFlight.size >= 3) break;
        this.queue.delete(k);
        this.sendJob(job.lod, job.cx, job.cy);
      }
      return;
    }
    const t0 = performance.now();
    // първо грубите (бързи) чанкове, после подробните
    const jobs = [...this.queue.entries()].sort((a, b) => (a[1].lod === b[1].lod ? 0 : a[1].lod === 'mid' ? -1 : 1));
    for (const [k, job] of jobs) {
      if (performance.now() - t0 > 12) break;
      this.queue.delete(k);
      this.buildChunk(job.lod, job.cx, job.cy);
    }
  }

  private buildChunk(lod: Lod, cx: number, cy: number) {
    const actors: CityActor[] | undefined = lod === 'near' && this.life ? [] : undefined;
    const cc: ChunkCanvas = paintChunk(this.gen!, this.lookup, cx, cy, {
      res: LOD_RES[lod],
      zoning: this.zoning,
      detail: lod === 'near' ? 2 : 1,
      cleared: (x, y) => this.territory.has(`${Math.floor(x / PARCEL)},${Math.floor(y / PARCEL)}`),
      actors,
      season: this.season,
    });
    this.installChunk(lod, cx, cy, Texture.from(cc.canvas), cc.sx, cc.sy, cc.res, actors);
  }

  // ------------------------------------------------------------ рисуване във фонова нишка
  private painter: Worker | null = null;
  private painterReady = false;
  private inFlight = new Map<number, { lod: Lod; cx: number; cy: number; stamp: number }>();
  private jobId = 0;
  /** Брояч на промените по чанк – резултат от стара поръчка се игнорира. */
  private stamps = new Map<string, number>();

  private startPainter(seed: string) {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
    try {
      const w = new Worker(new URL('./paint.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<PaintReply>) => this.onPainted(e.data);
      w.onerror = () => {
        // при проблем – рисуване в главната нишка
        this.painterReady = false;
        this.painter = null;
        this.inFlight.clear();
        this.updateTerrain();
      };
      w.postMessage({ type: 'init', seed });
      this.painter = w;
    } catch {
      this.painter = null;
    }
  }

  private onPainted(m: PaintReply) {
    if (m.type === 'ready') {
      this.painterReady = true;
      return;
    }
    const job = this.inFlight.get(m.id);
    this.inFlight.delete(m.id);
    if (!job) return;
    const key = `${job.cx},${job.cy}`;
    if (m.type === 'error') {
      this.buildChunk(job.lod, job.cx, job.cy);
      return;
    }
    if ((this.stamps.get(key) ?? 0) !== job.stamp) {
      m.bmp.close();
      this.updateTerrain();
      return;
    }
    this.installChunk(job.lod, job.cx, job.cy, Texture.from(m.bmp), m.sx, m.sy, m.res, m.actors);
  }

  private sendJob(lod: Lod, cx: number, cy: number) {
    const x0 = cx * CHUNK - 3;
    const y0 = cy * CHUNK - 3;
    const x1 = (cx + 1) * CHUNK + 3;
    const y1 = (cy + 1) * CHUNK + 3;
    const tiles: [string, TileState][] = [];
    for (const [k, t] of this.cityTiles) {
      const [x, y] = parseKey(k);
      if (x >= x0 && x < x1 && y >= y0 && y < y1) tiles.push([k, t]);
    }
    const id = ++this.jobId;
    const key = `${cx},${cy}`;
    this.inFlight.set(id, { lod, cx, cy, stamp: this.stamps.get(key) ?? 0 });
    const job: PaintJob = {
      type: 'paint',
      id,
      cx,
      cy,
      res: LOD_RES[lod],
      detail: lod === 'near' ? 2 : 1,
      zoning: this.zoning,
      season: this.season,
      wantActors: lod === 'near' && !!this.life,
      tiles,
      cleared: [...this.territory],
      parcel: PARCEL,
    };
    this.painter!.postMessage(job);
  }

  private installChunk(lod: Lod, cx: number, cy: number, tex: Texture, sx: number, sy: number, res0: number, actors?: CityActor[]) {
    const key = `${cx},${cy}`;
    const map = this.chunks[lod];
    const old = map.get(key);
    const cc = { sx, sy, res: res0 };
    const sp = new Sprite(tex);
    sp.position.set(cc.sx, cc.sy);
    sp.scale.set(1 / cc.res);
    sp.zIndex = (cx + cy) * 2 + (lod === 'near' ? 1 : 0);
    const visible = this.currentLod() === lod || (this.currentLod() === 'near' && !this.chunks.near.get(key)?.sprite);
    sp.visible = visible && this.chunkOnScreen(cx, cy);
    this.chunkLayer.addChild(sp);
    if (old?.sprite) {
      old.sprite.destroy({ texture: true, textureSource: true });
    }
    for (const a of old?.actors ?? []) a.destroy();
    let actorSprites: Sprite[] | undefined;
    if (actors && this.life) {
      actorSprites = [];
      const res = LOD_RES[lod];
      for (const a of actors) {
        const spr = getSprite(a.key, res);
        const as = new Sprite(texFor(spr.canvas));
        const p = toScreen(a.wx, a.wy);
        as.position.set(p.x - spr.ax / res, p.y - spr.ay / res);
        as.scale.set(1 / res);
        as.zIndex = a.d;
        as.visible = sp.visible;
        this.life.cars.addChild(as);
        actorSprites.push(as);
      }
    }
    map.set(key, { sprite: sp, stale: false, used: this.frame, actors: actorSprites });
    if (lod === 'near') {
      const m = this.chunks.mid.get(key);
      if (m?.sprite) m.sprite.visible = false;
    }
  }

  private evict() {
    for (const lod of ['mid', 'near'] as Lod[]) {
      const map = this.chunks[lod];
      if (map.size <= CACHE_CAP[lod]) continue;
      const list = [...map.entries()].filter(([, e]) => !e.sprite?.visible).sort((a, b) => a[1].used - b[1].used);
      for (const [k, e] of list) {
        if (map.size <= CACHE_CAP[lod] * 0.8) break;
        e.sprite?.destroy({ texture: true, textureSource: true });
        for (const a of e.actors ?? []) a.destroy();
        map.delete(k);
      }
    }
  }

  /** Маркира засегнатите чанкове за прерисуване (старата картина остава, докато новата е готова). */
  private invalidate(keys: Iterable<string>) {
    const touched = new Set<string>();
    for (const k of keys) {
      const [x, y] = parseKey(k);
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        touched.add(`${Math.floor((x + dx * 2) / CHUNK)},${Math.floor((y + dy * 2) / CHUNK)}`);
      }
    }
    for (const c of touched) this.stamps.set(c, (this.stamps.get(c) ?? 0) + 1);
    for (const lod of ['mid', 'near'] as Lod[])
      for (const c of touched) {
        const e = this.chunks[lod].get(c);
        if (e) e.stale = true;
      }
    this.updateTerrain();
  }

  resetTerrain() {
    for (const lod of ['mid', 'near'] as Lod[])
      for (const [k, e] of this.chunks[lod]) {
        e.stale = true;
        this.stamps.set(k, (this.stamps.get(k) ?? 0) + 1);
      }
    for (const j of this.inFlight.values()) this.stamps.set(`${j.cx},${j.cy}`, (this.stamps.get(`${j.cx},${j.cy}`) ?? 0) + 1);
    this.updateTerrain();
  }

  // ------------------------------------------------------------ градове на играчите
  /** Сградите, пътищата и зоните на градовете във видимия регион; прерисуват се само променените чанкове. */
  drawCities(cities: CityRender[], showZoning: boolean) {
    this.cityList = cities;
    const changed: string[] = [];
    const next = new Map<string, string>();
    for (const c of cities) for (const [k, t] of Object.entries(c.tiles)) next.set(k, JSON.stringify(t));
    for (const [k, j] of next) if (this.cityJson.get(k) !== j) changed.push(k);
    for (const k of this.cityJson.keys()) if (!next.has(k)) changed.push(k);
    this.cityJson = next;
    this.cityTiles.clear();
    for (const c of cities) for (const [k, t] of Object.entries(c.tiles)) this.cityTiles.set(k, t);
    if (showZoning !== this.zoning) {
      this.zoning = showZoning;
      this.resetTerrain();
    } else if (changed.length) this.invalidate(changed);
    this.drawCitiesFar();
    this.updateCityLabels();
    if (changed.length) {
      if (this.life && this.gen) {
        const hidden = new Set<string>();
        for (const k of this.cityTiles.keys()) {
          const [x, y] = parseKey(k);
          if (tunnelKind(this.gen, this.lookup, x, y) === 'inside') hidden.add(k);
        }
        this.life.traffic.hidden = hidden;
      }
      this.life?.setTiles(this.cityTiles);
      this.atmo?.setTiles(this.cityTiles);
    }
  }

  /** При далечен изглед градовете на играчите се показват като градска тъкан върху текстурата на държавата. */
  private drawCitiesFar() {
    const g = this.cityFarLayer;
    g.clear();
    for (const c of this.cityList)
      for (const [k, t] of Object.entries(c.tiles)) {
        const [x, y] = parseKey(k);
        diamond(g, x, y);
        g.fill(t.t === 'road' ? 0x7d7b78 : t.t === 'zone' ? (t.z === 'R' ? 0xc08060 : t.z === 'I' || t.z === 'L' ? 0x9c9a96 : 0xd2cdc2) : 0xd8d2c6);
      }
  }

  // ------------------------------------------------------------ надписи
  private buildLabels() {
    const gen = this.gen!;
    for (const l of this.labels) l.t.destroy();
    this.labels = [];
    const style = (size: number, weight: 'bold' | 'normal', color = 0xffffff, italic = false) => ({
      fontFamily: 'system-ui, Segoe UI, sans-serif',
      fontSize: size,
      fontWeight: weight,
      fontStyle: italic ? ('italic' as const) : ('normal' as const),
      fill: color,
      stroke: { color: 0x10202c, width: Math.max(2, size / 5) },
      letterSpacing: italic ? 1 : 0,
    });
    // имена на областите (при далечен изглед)
    for (const r of gen.regions) {
      const t = new Text({ text: r.name.replace('Област ', '').toUpperCase(), style: style(11, 'normal', 0xf3ead2, true) });
      t.anchor.set(0.5, 0.5);
      t.alpha = 0.7;
      const p = toScreen(r.cx + 0.5, r.cy + 0.5);
      this.labels.push({ t, x: p.x, y: p.y + 14, min: 0, max: 0.12 });
      this.labelLayer.addChild(t);
    }
    // реалните градове – само имена за ориентация (на картата не са построени)
    for (const pl of REAL_PLACES) {
      const cap = pl.tier === 'capital';
      const t = new Text({
        text: `${cap ? '★' : '•'} ${pl.name}`,
        style: style(cap ? 15 : pl.tier === 'city' ? 13 : 11, cap ? 'bold' : 'normal', cap ? 0xfde68a : 0xe2e8f0),
      });
      t.anchor.set(0.5, 1);
      t.alpha = 0.9;
      const p = toScreen(pl.x + 0.5, pl.y + 0.5);
      this.labels.push({ t, x: p.x, y: p.y, min: pl.tier === 'town' ? 0.07 : 0, max: 0.9 });
      this.labelLayer.addChild(t);
    }
  }

  private updateCityLabels() {
    const seen = new Set<string>();
    for (const c of this.cityList) {
      seen.add(c.id);
      let t = this.cityLabels.get(c.id);
      if (!t) {
        t = new Text({
          text: c.name,
          style: {
            fontFamily: 'system-ui, Segoe UI, sans-serif',
            fontSize: 15,
            fontWeight: 'bold',
            fill: c.ownerId === this.myUserId ? 0xfde68a : 0xdbeafe,
            stroke: { color: 0x10202c, width: 3 },
          },
        });
        t.anchor.set(0.5, 1);
        this.labelLayer.addChild(t);
        this.cityLabels.set(c.id, t);
      }
      const p = toScreen(c.originX + 0.5, c.originY + 0.5);
      t.position.set(p.x, p.y - 12);
    }
    for (const [id, t] of this.cityLabels)
      if (!seen.has(id)) {
        t.destroy();
        this.cityLabels.delete(id);
      }
  }

  private updateLabels() {
    const s = this.scale;
    const inv = 1 / s;
    for (const l of this.labels) {
      const vis = s >= l.min && s < l.max;
      l.t.visible = vis;
      if (vis) {
        l.t.position.set(l.x, l.y);
        l.t.scale.set(inv * (s > 0.6 ? 0.85 : 1));
      }
    }
    // В изгледа на държавата – само собствените градове (иначе надписите на другите играчи затрупват картата).
    const own = new Set(this.cityList.filter((c) => c.ownerId === this.myUserId).map((c) => c.id));
    for (const [id, t] of this.cityLabels) {
      t.visible = own.has(id) || s >= 0.09;
      t.scale.set(inv);
    }
    this.regionLayer.visible = this.showBorders;
  }

  // ------------------------------------------------------------ административни граници
  private drawRegionBorders() {
    const gen = this.gen!;
    const g = this.regionLayer;
    g.clear();
    const N = gen.size;
    const R = gen.country.region;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = R[y * N + x];
        if (a === 255) continue;
        if (x + 1 < N) {
          const b = R[y * N + x + 1];
          if (b !== 255 && b !== a) {
            const p = toScreen(x + 1, y);
            const q = toScreen(x + 1, y + 1);
            g.moveTo(p.x, p.y).lineTo(q.x, q.y);
          }
        }
        if (y + 1 < N) {
          const b = R[(y + 1) * N + x];
          if (b !== 255 && b !== a) {
            const p = toScreen(x, y + 1);
            const q = toScreen(x + 1, y + 1);
            g.moveTo(p.x, p.y).lineTo(q.x, q.y);
          }
        }
      }
    g.stroke({ width: 1, color: 0xf5e6c8, alpha: 0.45, pixelLine: true });
    // държавна граница на България – ярка линия
    const b = this.borderLayer;
    b.clear();
    const W = gen.country.water;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const k = y * N + x;
        const a = R[k];
        if (x + 1 < N && (a === 255) !== (R[k + 1] === 255) && !(W[k] === 1 && W[k + 1] === 1) && W[k] !== 1 && W[k + 1] !== 1) {
          const p = toScreen(x + 1, y);
          const q = toScreen(x + 1, y + 1);
          b.moveTo(p.x, p.y).lineTo(q.x, q.y);
        }
        if (y + 1 < N && (a === 255) !== (R[k + N] === 255) && W[k] !== 1 && W[k + N] !== 1) {
          const p = toScreen(x, y + 1);
          const q = toScreen(x + 1, y + 1);
          b.moveTo(p.x, p.y).lineTo(q.x, q.y);
        }
      }
    b.stroke({ width: 1, color: 0xfbbf24, alpha: 0.95, pixelLine: true });
  }

  /** Сигнали на гражданите – маркери и следи на картата. */
  private needs: NeedBadge[] = [];
  setNeeds(list: NeedBadge[]) {
    this.needs = list;
    this.life?.setNeeds(list);
  }

  setIssues(issues: IssueMarker[]) {
    this.issues = issues;
    this.life?.setIssues(issues);
  }

  /** id на сигнал под екранна точка (за клик върху маркер). */
  issueAtScreen(sx: number, sy: number): string | null {
    if (!this.life) return null;
    return this.life.issueAt((sx - this.world.x) / this.scale, (sy - this.world.y) / this.scale, this.scale);
  }

  /** Камера към цяла България (плавно). */
  fitCountry(animate = true) {
    const gen = this.gen;
    if (!gen) return;
    const N = gen.size;
    const R = gen.country.region;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let y = 0; y < N; y += 2)
      for (let x = 0; x < N; x += 2) {
        if (R[y * N + x] === 255) continue;
        const p = toScreen(x, y);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((w * 0.62) / (maxX - minX), (h * 0.62) / (maxY - minY))));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const pos = { scale: s, x: w / 2 - cx * s - w * 0.06, y: h / 2 - cy * s + h * 0.02 };
    if (animate) this.target = pos;
    else {
      this.world.scale.set(s);
      this.world.position.set(pos.x, pos.y);
    }
  }

  setBorders(on: boolean) {
    this.showBorders = on;
    this.regionLayer.visible = on;
  }

  // ------------------------------------------------------------ слоеве и курсор
  private drawResources() {
    const g = this.resourceLayer;
    if (!this.showResources || !this.gen || this.scale < LOD_FAR) {
      if (this.lastResourcesKey) g.clear();
      this.lastResourcesKey = '';
      return;
    }
    const v = this.visibleTiles();
    const key = `${v.x0},${v.y0},${v.x1},${v.y1}`;
    if (key === this.lastResourcesKey) return;
    this.lastResourcesKey = key;
    g.clear();
    const step = this.scale < 0.25 ? 2 : 1;
    for (let y = v.y0; y <= v.y1; y += step)
      for (let x = v.x0; x <= v.x1; x += step) {
        const t = this.gen.tileAt(x, y);
        if (t.deposit === 'none' && t.fertility < 0.55) continue;
        const p = toScreen(x + 0.5, y + 0.5);
        if (t.deposit !== 'none') g.circle(p.x, p.y, 6 * step).fill({ color: t.deposit === 'iron' ? 0xd97706 : 0x111827, alpha: 0.85 });
        else g.circle(p.x, p.y, 3 * step).fill({ color: 0xa3e635, alpha: 0.55 });
      }
  }

  /** Парцели – показват се само в режим „Собственост“ или при инструмент за земя/строителство (тънки контури). */
  drawParcels(parcels: { px: number; py: number; cityId: string }[], cities: CityRender[], highlightOwnership: boolean, subtle = false) {
    // територията на градовете (без гори) – прерисуват се само чанковете с променени парцели
    const next = new Set(parcels.map((p) => `${p.px},${p.py}`));
    const changed: string[] = [];
    for (const k of next) if (!this.territory.has(k)) changed.push(k);
    for (const k of this.territory) if (!next.has(k)) changed.push(k);
    this.territory = next;
    if (changed.length)
      this.invalidate(
        changed.flatMap((k) => {
          const [px, py] = k.split(',').map(Number);
          return [tileKey(px * PARCEL, py * PARCEL), tileKey(px * PARCEL + PARCEL - 1, py * PARCEL + PARCEL - 1)];
        }),
      );
    const g = this.parcelLayer;
    g.clear();
    if (!highlightOwnership && !subtle) return;
    const owner = new Map(cities.map((c) => [c.id, c.ownerId]));
    for (const p of parcels) {
      const o = owner.get(p.cityId);
      const mine = o === this.myUserId;
      if (subtle && p.cityId !== this.activeCityId) continue;
      const color = mine ? (p.cityId === this.activeCityId ? 0xfbbf24 : 0xf59e0b) : 0x60a5fa ^ (hashString(o ?? '') & 0x3f3f3f);
      const a = toScreen(p.px * PARCEL, p.py * PARCEL);
      const b = toScreen(p.px * PARCEL + PARCEL, p.py * PARCEL);
      const c = toScreen(p.px * PARCEL + PARCEL, p.py * PARCEL + PARCEL);
      const d = toScreen(p.px * PARCEL, p.py * PARCEL + PARCEL);
      g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
      if (highlightOwnership) g.fill({ color, alpha: 0.22 });
      g.stroke({ width: 1, color, alpha: subtle ? 0.45 : 0.8, pixelLine: true });
    }
  }

  /** Слой с данни (стойност на земята, замърсяване, трафик...) – цветна скала върху плочките. */
  drawOverlay(data: LayerData, kind: string) {
    const g = this.overlayLayer;
    g.clear();
    if (!data) return;
    let max = 0;
    for (const v of Object.values(data)) max = Math.max(max, v);
    if (max <= 0) max = 1;
    for (const [k, v] of Object.entries(data)) {
      const [x, y] = parseKey(k);
      let color: number;
      let t = Math.min(1, v / max);
      if (kind === 'landValue') {
        t = Math.min(1, v / 2);
        color = mix(0xef4444, 0x22c55e, t);
      } else if (kind === 'power' || kind === 'water') color = v > 0 ? (kind === 'power' ? 0xfacc15 : 0x38bdf8) : 0xef4444;
      else if (kind === 'pollution') color = mix(0xfef08a, 0x7f1d1d, t);
      else if (kind === 'traffic') {
        t = Math.min(1, v);
        color = mix(0x22c55e, 0xdc2626, t);
      } else color = mix(0x1e40af, 0xf472b6, t);
      diamond(g, x, y);
      g.fill({ color, alpha: kind === 'power' || kind === 'water' ? 0.5 : 0.2 + 0.45 * t });
    }
  }

  /** Подсветка на курсора и преглед на действие с влачене. */
  drawCursor(tiles: { x: number; y: number }[], color: number, valid: boolean) {
    const g = this.uiLayer;
    g.clear();
    for (const t of tiles.slice(0, 2000)) {
      diamond(g, t.x, t.y);
      g.fill({ color: valid ? color : 0xef4444, alpha: 0.32 });
      diamond(g, t.x, t.y);
      g.stroke({ width: 1, color: 0xffffff, alpha: 0.85, pixelLine: true });
    }
  }

  /** Преглед на нов град: 3×3 парцела (зелено – може, червено – не може). */
  drawFoundCursor(px0: number, py0: number, n: number, ok: boolean) {
    const g = this.uiLayer;
    g.clear();
    const a = toScreen(px0 * PARCEL, py0 * PARCEL);
    const b = toScreen((px0 + n) * PARCEL, py0 * PARCEL);
    const c = toScreen((px0 + n) * PARCEL, (py0 + n) * PARCEL);
    const d = toScreen(px0 * PARCEL, (py0 + n) * PARCEL);
    g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y])
      .fill({ color: ok ? 0x22c55e : 0xef4444, alpha: 0.28 })
      .stroke({ width: 2, color: ok ? 0x86efac : 0xfca5a5, pixelLine: true });
    for (let i = 1; i < n; i++) {
      const p = toScreen((px0 + i) * PARCEL, py0 * PARCEL);
      const q = toScreen((px0 + i) * PARCEL, (py0 + n) * PARCEL);
      const u = toScreen(px0 * PARCEL, (py0 + i) * PARCEL);
      const v = toScreen((px0 + n) * PARCEL, (py0 + i) * PARCEL);
      g.moveTo(p.x, p.y).lineTo(q.x, q.y).moveTo(u.x, u.y).lineTo(v.x, v.y);
    }
    g.stroke({ width: 1, color: 0xffffff, alpha: 0.35, pixelLine: true });
  }

  drawParcelCursor(px: number, py: number, ok: boolean) {
    const g = this.uiLayer;
    g.clear();
    const a = toScreen(px * PARCEL, py * PARCEL);
    const b = toScreen(px * PARCEL + PARCEL, py * PARCEL);
    const c = toScreen(px * PARCEL + PARCEL, py * PARCEL + PARCEL);
    const d = toScreen(px * PARCEL, py * PARCEL + PARCEL);
    g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y])
      .fill({ color: ok ? 0x22c55e : 0xef4444, alpha: 0.3 })
      .stroke({ width: 2, color: 0xffffff, pixelLine: true });
  }
}
