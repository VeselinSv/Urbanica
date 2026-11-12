/**
 * 3D изглед на картата (Three.js). Има същите методи като 2D рисувача (IsoRenderer), затова картата
 * (MapView) ползва едни и същи инструменти, панели и заявки и в двата изгледа.
 *
 * Камера: цел върху терена, разстояние, завъртане (Q/E или бутоните) и наклон. Слънце със сенки,
 * денонощие по игровия ден, светещи прозорци и улични лампи нощем, дъжд и сняг.
 */
import * as THREE from 'three';
import { BALANCE, ISSUE_TYPES, type TileMap } from '@gce/shared';
import type { WorldGenerator } from '@gce/world-generation';
import { dayFraction } from '../store';
import { issueObject } from './issues3d';
import type { CityRender, LayerData } from '../map/renderer';
import type { IssueMarker, NeedBadge } from '../map/life';
import type { DayMode, Weather } from '../map/atmosphere';
import type { Season } from '../map/sprites';
import { Terrain3D } from './terrain';
import { Nature3D } from './nature';
import { City3D, lampMaterial } from './city3d';
import { Traffic3D } from './traffic3d';
import { facadeMaterials } from './buildings';

const PARCEL = BALANCE.world.parcelSize;
const PITCH = 0.92;

function labelTexture(text: string, bg = 'rgba(15,23,42,0.85)', border = '#facc15', font = 28): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = `700 ${font}px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w;
  c.height = font + 22;
  g.font = `700 ${font}px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif`;
  g.fillStyle = bg;
  g.strokeStyle = border;
  g.lineWidth = 4;
  const r = c.height / 2;
  g.beginPath();
  g.roundRect(2, 2, w - 4, c.height - 4, r - 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  g.fillText(text, 14, c.height / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Renderer3D {
  readonly is3d = true;
  readonly app = { screen: { width: 1, height: 1 } };
  readonly far = undefined;
  onCameraChange: (() => void) | null = null;
  myUserId: string | null = null;
  activeCityId: string | null = null;
  showResources = false;

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.05, 3000);
  private host: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private gen: WorldGenerator | null = null;
  private terrain: Terrain3D | null = null;
  private terrainGroup: THREE.Group | null = null;
  private nature: Nature3D | null = null;
  private city: City3D | null = null;
  private traffic = new Traffic3D();
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5d6b45, 0.7);
  private overlay = new THREE.Group();
  private cursor = new THREE.Group();
  private borders = new THREE.Group();
  private markers = new THREE.Group();
  private decals = new THREE.Group();
  private linksGroup = new THREE.Group();
  private labels = new THREE.Group();
  private precip: THREE.Points | null = null;
  private rotors: THREE.Object3D[] = [];
  private issueSprites: { id: string; pos: THREE.Vector3 }[] = [];
  private territory = new Set<string>();
  private trafficLoad = 1;

  private target = new THREE.Vector3(256, 0, 256);
  private dist = 40;
  private yaw = Math.PI / 4;
  private anim: { target: THREE.Vector3; dist: number } | null = null;
  private season: Season = 'summer';
  private weather: Weather = 'clear';
  private dayMode: DayMode = 'auto';
  private last = performance.now();

  get scale() {
    return 34 / this.dist;
  }

  async init(el: HTMLElement) {
    this.host = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const cv = this.renderer.domElement;
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.display = 'block';
    el.appendChild(cv);
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.scene.background = new THREE.Color(0x9cc9ec);
    this.scene.fog = new THREE.Fog(0x9cc9ec, 120, 900);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(
      this.sun,
      this.sun.target,
      this.hemi,
      this.overlay,
      this.cursor,
      this.borders,
      this.markers,
      this.decals,
      this.linksGroup,
      this.labels,
      this.traffic.group,
    );
    window.addEventListener('keydown', this.onKey);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    this.renderer?.setAnimationLoop(null);
    this.ro?.disconnect();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    if (e.key === 'q' || e.key === 'Q' || e.key === 'й' || e.key === 'Й') this.rotate(-Math.PI / 8);
    if (e.key === 'e' || e.key === 'E' || e.key === 'е' || e.key === 'Е') this.rotate(Math.PI / 8);
  };

  /** Завъртане на камерата около целта. */
  rotate(a: number) {
    this.yaw += a;
    this.onCameraChange?.();
  }

  private resize() {
    if (!this.host || !this.renderer) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.app.screen.width = w;
    this.app.screen.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWorld(gen: WorldGenerator) {
    this.gen = gen;
    this.terrain = new Terrain3D(gen);
    this.terrainGroup = this.terrain.build(this.season3());
    this.scene.add(this.terrainGroup);
    this.nature = new Nature3D(gen, this.terrain);
    this.nature.cleared = (x, y) => this.territory.has(`${Math.floor(x / PARCEL)},${Math.floor(y / PARCEL)}`);
    this.nature.season = this.season3();
    this.scene.add(this.nature.group);
    this.city = new City3D(gen, this.terrain);
    this.scene.add(this.city.group);
    this.traffic.roadY = (x, z) => this.roadY(x, z);
    this.traffic.hidden = (x, y) => !!this.city && this.city.tunnel(x, y) !== null;
    this.target.y = this.terrain.heightAt(this.target.x, this.target.z);
  }

  private season3() {
    return this.season;
  }

  /** Височина на платното (мост или терен). */
  private roadY(x: number, z: number) {
    if (!this.terrain || !this.gen) return 0;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (this.city?.isBridge(tx, tz)) return this.city.deck(tx, tz);
    return this.terrain.heightAt(x, z) + 0.035;
  }

  // ------------------------------------------------------------------ камера
  private placeCamera() {
    const t = this.target;
    const cp = Math.cos(PITCH);
    this.camera.position.set(t.x + Math.sin(this.yaw) * cp * this.dist, t.y + Math.sin(PITCH) * this.dist, t.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(t);
    this.camera.near = Math.max(0.03, this.dist * 0.01);
    this.camera.far = Math.max(400, this.dist * 6);
    this.camera.updateProjectionMatrix();
  }

  centerOn(x: number, y: number, scale?: number, animate = false) {
    const t = new THREE.Vector3(x + 0.5, this.terrain?.heightAt(x + 0.5, y + 0.5) ?? 0, y + 0.5);
    const d = scale ? Math.max(2.5, Math.min(700, 34 / scale)) : this.dist;
    if (animate) this.anim = { target: t, dist: d };
    else {
      this.target.copy(t);
      this.dist = d;
      this.anim = null;
    }
    this.onCameraChange?.();
  }

  fitCountry(animate = true) {
    const n = this.gen?.size ?? 512;
    this.centerOn(n / 2, n / 2, 34 / 520, animate);
  }

  pan(dx: number, dy: number) {
    const k = (this.dist * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.app.screen.height;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * k);
    this.target.addScaledVector(fwd, (dy * k) / Math.sin(PITCH));
    const n = this.gen?.size ?? 512;
    this.target.x = Math.max(0, Math.min(n, this.target.x));
    this.target.z = Math.max(0, Math.min(n, this.target.z));
    if (this.terrain) this.target.y = this.terrain.heightAt(this.target.x, this.target.z);
    this.anim = null;
    this.onCameraChange?.();
  }

  zoomAt(sx: number, sy: number, f: number) {
    const hit = this.pick(sx, sy);
    const nd = Math.max(2.5, Math.min(700, this.dist / f));
    if (hit) {
      const k = 1 - nd / this.dist;
      this.target.x += (hit.x - this.target.x) * k;
      this.target.z += (hit.z - this.target.z) * k;
      if (this.terrain) this.target.y = this.terrain.heightAt(this.target.x, this.target.z);
    }
    this.dist = nd;
    this.anim = null;
    this.onCameraChange?.();
  }

  zoomNow(sx: number, sy: number, f: number) {
    this.zoomAt(sx, sy, f);
  }

  /** Точка от терена под пиксела (лъч срещу височинната карта). */
  private pick(sx: number, sy: number): THREE.Vector3 | null {
    if (!this.terrain) return null;
    this.placeCamera();
    const ndc = new THREE.Vector2((sx / this.app.screen.width) * 2 - 1, -(sy / this.app.screen.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    let t = 0;
    let prev = 0;
    const maxT = this.dist * 8 + 200;
    while (t < maxT) {
      const p = o.clone().addScaledVector(d, t);
      const h = Math.max(this.terrain.heightAt(p.x, p.z), this.waterAt(p.x, p.z));
      if (p.y <= h) {
        // уточняване
        let a = prev;
        let b = t;
        for (let i = 0; i < 12; i++) {
          const m = (a + b) / 2;
          const q = o.clone().addScaledVector(d, m);
          if (q.y <= Math.max(this.terrain.heightAt(q.x, q.z), this.waterAt(q.x, q.z))) b = m;
          else a = m;
        }
        return o.clone().addScaledVector(d, b);
      }
      prev = t;
      t += Math.max(0.05, t * 0.004);
    }
    return null;
  }

  private waterAt(x: number, z: number) {
    const l = this.terrain?.waterLevel(Math.floor(x), Math.floor(z));
    return l === undefined || Number.isNaN(l) ? -1e9 : l;
  }

  screenToTile(sx: number, sy: number) {
    const p = this.pick(sx, sy);
    if (!p) return { x: Math.floor(this.target.x), y: Math.floor(this.target.z) };
    return { x: Math.floor(p.x), y: Math.floor(p.z) };
  }

  visibleTiles() {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const n = this.gen?.size ?? 512;
    const pts = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
      [w / 2, h / 2],
    ]
      .map(([x, y]) => this.pick(x, y))
      .filter((p): p is THREE.Vector3 => !!p);
    const r = this.dist * 1.6;
    const xs = pts.length >= 3 ? pts.map((p) => p.x) : [this.target.x - r, this.target.x + r];
    const zs = pts.length >= 3 ? pts.map((p) => p.z) : [this.target.z - r, this.target.z + r];
    const c = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v)));
    return { x0: c(Math.min(...xs) - 2), y0: c(Math.min(...zs) - 2), x1: c(Math.max(...xs) + 2), y1: c(Math.max(...zs) + 2) };
  }

  updateTerrain() {
    this.nature?.update(this.target.x, this.target.z);
  }

  resetTerrain() {
    this.terrain?.recolor(this.season);
    this.nature?.setSeason(this.season);
  }

  // ------------------------------------------------------------------ градове
  drawParcels(parcels: { px: number; py: number; cityId: string }[], cities: CityRender[], highlightOwnership: boolean, subtle = false) {
    const terr = new Set(parcels.map((p) => `${p.px},${p.py}`));
    const changed = terr.size !== this.territory.size || [...terr].some((k) => !this.territory.has(k));
    this.territory = terr;
    if (changed) this.nature?.refresh();
    for (const c of this.borders.children) (c as THREE.LineSegments).geometry.dispose();
    this.borders.clear();
    if (!this.terrain) return;
    const owner = new Map(parcels.map((p) => [`${p.px},${p.py}`, p.cityId]));
    const byCity = new Map(cities.map((c) => [c.id, c]));
    const groups = new Map<number, number[]>();
    const add = (color: number, ax: number, az: number, bx: number, bz: number) => {
      const arr = groups.get(color) ?? [];
      // по ръба – през всяка плочка, следвайки терена
      const steps = PARCEL;
      for (let i = 0; i < steps; i++) {
        const x0 = ax + ((bx - ax) * i) / steps;
        const z0 = az + ((bz - az) * i) / steps;
        const x1 = ax + ((bx - ax) * (i + 1)) / steps;
        const z1 = az + ((bz - az) * (i + 1)) / steps;
        arr.push(x0, this.terrain!.heightAt(x0, z0) + 0.08, z0, x1, this.terrain!.heightAt(x1, z1) + 0.08, z1);
      }
      groups.set(color, arr);
    };
    for (const p of parcels) {
      const id = p.cityId;
      const city = byCity.get(id);
      const mine = city?.ownerId === this.myUserId;
      const color = id === this.activeCityId ? 0xfacc15 : mine ? 0x86efac : 0xf8fafc;
      const x0 = p.px * PARCEL;
      const z0 = p.py * PARCEL;
      const x1 = x0 + PARCEL;
      const z1 = z0 + PARCEL;
      if (owner.get(`${p.px},${p.py - 1}`) !== id) add(color, x0, z0, x1, z0);
      if (owner.get(`${p.px},${p.py + 1}`) !== id) add(color, x0, z1, x1, z1);
      if (owner.get(`${p.px - 1},${p.py}`) !== id) add(color, x0, z0, x0, z1);
      if (owner.get(`${p.px + 1},${p.py}`) !== id) add(color, x1, z0, x1, z1);
      if (highlightOwnership) {
        const fill = new THREE.Mesh(
          new THREE.PlaneGeometry(PARCEL, PARCEL),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }),
        );
        fill.rotation.x = -Math.PI / 2;
        fill.position.set(x0 + PARCEL / 2, this.terrain.heightAt(x0 + 4, z0 + 4) + 0.3, z0 + PARCEL / 2);
        this.borders.add(fill);
      }
    }
    for (const [color, arr] of groups) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      this.borders.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: subtle ? 0.45 : 0.9 })));
    }
  }

  drawCities(cities: CityRender[], showZoning: boolean) {
    if (!this.city) return;
    const all: TileMap = {};
    for (const c of cities) Object.assign(all, c.tiles);
    this.city.setTiles(all, this.season, showZoning);
    this.rotors = [];
    this.city.group.traverse((o) => {
      if (o.name === 'rotor') this.rotors.push(o);
    });
    this.traffic.setTiles(all, this.trafficLoad);
    // имена на градовете
    for (const s of this.labels.children) ((s as THREE.Sprite).material as THREE.SpriteMaterial).map?.dispose();
    this.labels.clear();
    for (const c of cities) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: labelTexture(c.name, 'rgba(15,23,42,0.75)', c.id === this.activeCityId ? '#facc15' : '#94a3b8', 26),
          sizeAttenuation: false,
          depthTest: false,
        }),
      );
      const tex = (sp.material as THREE.SpriteMaterial).map!;
      const img = tex.image as HTMLCanvasElement;
      sp.scale.set((img.width / img.height) * 0.032, 0.032, 1);
      sp.position.set(c.originX + 0.5, (this.terrain?.heightAt(c.originX, c.originY) ?? 0) + 2.2, c.originY + 0.5);
      sp.renderOrder = 10;
      this.labels.add(sp);
    }
  }

  setTrafficLoad(t: Record<string, number> | undefined) {
    if (!t) return;
    const v = Object.values(t);
    this.trafficLoad = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 1;
  }

  setLinks(links: { a: { originX: number; originY: number }; b: { originX: number; originY: number } }[]) {
    for (const c of this.linksGroup.children) (c as THREE.Mesh).geometry.dispose();
    this.linksGroup.clear();
    if (!this.terrain) return;
    const m = new THREE.MeshStandardMaterial({ color: 0x45484d, roughness: 0.9 });
    for (const l of links) {
      const ax = l.a.originX + 0.5;
      const az = l.a.originY + 0.5;
      const bx = l.b.originX + 0.5;
      const bz = l.b.originY + 0.5;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(2, Math.ceil(len));
      const nx = -(bz - az) / len;
      const nz = (bx - ax) / len;
      const pos: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = (t: number, s: number) => {
          const x = ax + (bx - ax) * t + nx * s * 0.35;
          const z = az + (bz - az) * t + nz * s * 0.35;
          return [x, Math.max(this.terrain!.heightAt(x, z), this.waterAt(x, z) + 0.4) + 0.05, z];
        };
        const t0 = i / n;
        const t1 = (i + 1) / n;
        pos.push(...p(t0, -1), ...p(t1, 1), ...p(t1, -1), ...p(t0, -1), ...p(t0, 1), ...p(t1, 1));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      this.linksGroup.add(new THREE.Mesh(g, m));
    }
  }

  setBorders(_on: boolean) {
    /* областните граници се виждат по цвета на терена */
  }

  // ------------------------------------------------------------------ слоеве, курсор
  drawOverlay(data: LayerData, kind: string) {
    for (const c of this.overlay.children) (c as THREE.Mesh).geometry.dispose();
    this.overlay.clear();
    if (!data || !this.terrain) return;
    let max = 0;
    for (const v of Object.values(data)) max = Math.max(max, v);
    if (max <= 0) max = 1;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const mixc = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), Math.max(0, Math.min(1, t)));
    for (const [k, v] of Object.entries(data)) {
      const [x, y] = k.split(',').map(Number);
      let t = Math.min(1, v / max);
      if (kind === 'landValue') c.copy(mixc(0xef4444, 0x22c55e, Math.min(1, v / 2)));
      else if (kind === 'power' || kind === 'water') c.setHex(v >= 1 ? (kind === 'power' ? 0xfacc15 : 0x38bdf8) : v >= 0.2 ? 0xf97316 : 0xef4444);
      else if (kind === 'pollution') c.copy(mixc(0xfef08a, 0x7f1d1d, t));
      else if (kind === 'traffic') {
        t = Math.min(1, v);
        c.copy(mixc(0x22c55e, 0xdc2626, t));
      } else c.copy(mixc(0x1e40af, 0xf472b6, t));
      const pts = [
        [x + 0.04, y + 0.04],
        [x + 0.96, y + 0.04],
        [x + 0.96, y + 0.96],
        [x + 0.04, y + 0.96],
      ].map(([px, pz]) => [px, Math.max(this.terrain!.heightAt(px, pz), this.waterAt(px, pz)) + 0.12, pz]);
      for (const i of [0, 2, 1, 0, 3, 2]) {
        pos.push(...pts[i]);
        col.push(c.r, c.g, c.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.renderOrder = 5;
    this.overlay.add(m);
  }

  private tileQuads(tiles: { x: number; y: number }[], color: number, opacity: number, lift = 0.15) {
    if (!this.terrain) return null;
    const pos: number[] = [];
    const line: number[] = [];
    for (const t of tiles.slice(0, 2000)) {
      const pts = [
        [t.x, t.y],
        [t.x + 1, t.y],
        [t.x + 1, t.y + 1],
        [t.x, t.y + 1],
      ].map(([px, pz]) => [px, Math.max(this.terrain!.heightAt(px, pz), this.waterAt(px, pz)) + lift, pz]);
      for (const i of [0, 2, 1, 0, 3, 2]) pos.push(...pts[i]);
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ])
        line.push(...pts[a], ...pts[b]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    fill.renderOrder = lines.renderOrder = 6;
    return [fill, lines];
  }

  private clearCursor() {
    for (const c of this.cursor.children) (c as THREE.Mesh).geometry.dispose();
    this.cursor.clear();
  }

  drawCursor(tiles: { x: number; y: number }[], color: number, valid: boolean) {
    this.clearCursor();
    const q = this.tileQuads(tiles, valid ? color : 0xef4444, 0.38);
    if (q) this.cursor.add(...q);
  }

  drawFoundCursor(px0: number, py0: number, n: number, ok: boolean) {
    this.clearCursor();
    const tiles: { x: number; y: number }[] = [];
    for (let j = 0; j < n * PARCEL; j++) for (let i = 0; i < n * PARCEL; i++) tiles.push({ x: px0 * PARCEL + i, y: py0 * PARCEL + j });
    const q = this.tileQuads(tiles, ok ? 0x22c55e : 0xef4444, 0.2, 0.3);
    if (q) this.cursor.add(q[0]);
  }

  drawParcelCursor(px: number, py: number, ok: boolean) {
    this.clearCursor();
    const tiles: { x: number; y: number }[] = [];
    for (let j = 0; j < PARCEL; j++) for (let i = 0; i < PARCEL; i++) tiles.push({ x: px * PARCEL + i, y: py * PARCEL + j });
    const q = this.tileQuads(tiles, ok ? 0x22c55e : 0xef4444, 0.25, 0.3);
    if (q) this.cursor.add(q[0]);
  }

  // ------------------------------------------------------------------ сигнали и значки
  setIssues(issues: IssueMarker[]) {
    for (const c of this.markers.children.filter((m) => m.userData.issue)) {
      ((c as THREE.Sprite).material as THREE.SpriteMaterial).map?.dispose();
      c.removeFromParent();
    }
    for (const c of [...this.decals.children]) {
      c.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      c.removeFromParent();
    }
    this.issueSprites = [];
    if (!this.terrain) return;
    for (const i of issues) {
      const x = i.x + 0.5;
      const z = i.y + 0.5;
      // истински 3D обект на сигнала (дупка в асфалта, шахта с вода, контейнер, коли, дърво…)
      const seed = i.x * 7 + i.y * 13;
      const ox = x + (i.kind === 'pothole' ? 0.08 : 0);
      const surf = this.city ? this.city.surfaceY(i.x, i.y, ox, z) : this.roadY(ox, z);
      const obj = issueObject(i.kind, i.severity, seed, i.status === 'FIXING', this.season);
      obj.position.set(ox, surf + 0.016, z);
      // наклон по настилката (на склон дупката и локвите лежат успоредно на асфалта)
      const sy = (px: number, pz: number) => (this.city ? this.city.surfaceY(Math.floor(px), Math.floor(pz), px, pz) : this.roadY(px, pz));
      const e = 0.15;
      const nrm = new THREE.Vector3(-(sy(ox + e, z) - sy(ox - e, z)) / (2 * e), 1, -(sy(ox, z + e) - sy(ox, z - e)) / (2 * e)).normalize();
      const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
      // лампата е на тротоара – по посоката на улицата; останалите – завъртяни произволно
      const ang = i.kind === 'streetlight' ? (this.city?.roadAlongX(i.x, i.y) ? 0 : Math.PI / 2) : ((seed % 8) / 8) * Math.PI * 2;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      obj.quaternion.copy(tilt.multiply(yaw));
      const y = surf;
      this.decals.add(obj);
      const fixing = i.status === 'FIXING';
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: labelTexture(
            fixing ? '🔧' : (ISSUE_TYPES[i.kind]?.icon ?? '❗'),
            'rgba(15,23,42,0.88)',
            fixing ? '#f59e0b' : i.severity >= 3 ? '#dc2626' : i.severity === 2 ? '#f97316' : '#facc15',
            30,
          ),
          sizeAttenuation: false,
          depthTest: false,
        }),
      );
      sp.scale.set(0.045, 0.045, 1);
      sp.position.set(x, y + 0.45, z);
      sp.renderOrder = 11;
      sp.userData.issue = i.id;
      this.markers.add(sp);
      this.issueSprites.push({ id: i.id, pos: sp.position.clone() });
    }
  }

  setNeeds(list: NeedBadge[]) {
    for (const c of this.markers.children.filter((m) => m.userData.need)) {
      ((c as THREE.Sprite).material as THREE.SpriteMaterial).map?.dispose();
      c.removeFromParent();
    }
    if (!this.terrain) return;
    for (const n of list) {
      const tex = labelTexture(n.count > 1 ? `${n.icon} ×${n.count}` : n.icon, 'rgba(15,23,42,0.82)', n.sev === 2 ? '#ef4444' : '#f59e0b', 24);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false }));
      const img = tex.image as HTMLCanvasElement;
      sp.scale.set((img.width / img.height) * 0.03, 0.03, 1);
      sp.position.set(n.x + 0.5, this.terrain.heightAt(n.x + 0.5, n.y + 0.5) + 0.9, n.y + 0.5);
      sp.renderOrder = 11;
      sp.userData.need = true;
      this.markers.add(sp);
    }
  }

  issueAtScreen(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bd = 26 * 26;
    for (const s of this.issueSprites) {
      const p = s.pos.clone().project(this.camera);
      const px = (p.x * 0.5 + 0.5) * this.app.screen.width;
      const py = (-p.y * 0.5 + 0.5) * this.app.screen.height;
      const d = (px - sx) ** 2 + (py - sy) ** 2;
      if (d < bd) {
        bd = d;
        best = s.id;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ атмосфера
  setSeason(s: Season) {
    if (s === this.season) return;
    this.season = s;
    this.resetTerrain();
  }

  setWeather(w: Weather) {
    if (w === this.weather) return;
    this.weather = w;
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precip.geometry.dispose();
      this.precip = null;
    }
    if (w === 'clear') return;
    const snow = w === 'snow';
    const n = 6000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.precip = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: snow ? 0xffffff : 0xaec6dc,
        size: snow ? 0.09 : 0.05,
        transparent: true,
        opacity: snow ? 0.9 : 0.55,
        depthWrite: false,
      }),
    );
    this.precip.userData.snow = snow;
    this.scene.add(this.precip);
  }

  setDayMode(m: DayMode) {
    this.dayMode = m;
  }

  /** 0 – ден, 1 – нощ; посока на слънцето. */
  private daylight() {
    if (this.dayMode === 'day') return { night: 0, elev: 0.9, az: 0.4 };
    if (this.dayMode === 'night') return { night: 1, elev: -0.3, az: 0.4 };
    const f = dayFraction();
    // ден 0..0.74 (изгрев → залез), после нощ
    if (f < 0.74) {
      const t = f / 0.74;
      const elev = Math.sin(t * Math.PI);
      const night = elev < 0.18 ? 1 - elev / 0.18 : 0;
      return { night: night * 0.85, elev, az: t };
    }
    return { night: 1, elev: -0.2, az: 0.5 };
  }

  // ------------------------------------------------------------------ кадър
  private frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.anim) {
      const k = 1 - Math.pow(0.002, dt);
      this.target.lerp(this.anim.target, k);
      this.dist += (this.anim.dist - this.dist) * k;
      if (this.target.distanceTo(this.anim.target) < 0.05 && Math.abs(this.dist - this.anim.dist) < 0.05) this.anim = null;
      this.onCameraChange?.();
    }
    this.placeCamera();
    const { night, elev, az } = this.daylight();
    const day = 1 - night;
    // слънце: изгрев от изток, залез на запад; сенките следват целта
    const sunDir = new THREE.Vector3(Math.cos(az * Math.PI) * 0.8, Math.max(0.15, elev), -0.45 + Math.sin(az * Math.PI) * 0.2).normalize();
    const sd = Math.min(60, Math.max(14, this.dist * 0.9));
    this.sun.position.copy(this.target).addScaledVector(sunDir, 80);
    this.sun.target.position.copy(this.target);
    const cam = this.sun.shadow.camera;
    cam.left = -sd;
    cam.right = sd;
    cam.top = sd;
    cam.bottom = -sd;
    cam.near = 1;
    cam.far = 200;
    cam.updateProjectionMatrix();
    this.sun.castShadow = this.dist < 140;
    const low = Math.max(0, 1 - elev * 3);
    this.sun.color.setRGB(1, 0.92 - low * 0.25, 0.82 - low * 0.4);
    this.sun.intensity = 2.6 * day * Math.max(0.2, elev) + 0.15 * night;
    if (night > 0.5) this.sun.color.setHex(0x9fb4e0);
    const overcast = this.weather === 'clear' ? 0 : this.weather === 'snow' ? 0.35 : 0.5;
    this.sun.intensity *= 1 - overcast * 0.6;
    this.hemi.intensity = 0.25 + 0.55 * day;
    this.hemi.color.setHex(night > 0.5 ? 0x34406a : 0xcfe6ff);
    const sky = new THREE.Color(0x9cc9ec)
      .lerp(new THREE.Color(0xf2a26a), low * day * 0.5)
      .lerp(new THREE.Color(0x0b1426), night)
      .lerp(new THREE.Color(0x8a96a4), overcast * day);
    (this.scene.background as THREE.Color).copy(sky);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(sky);
    fog.near = Math.max(60, this.dist * 2.5);
    fog.far = Math.max(400, this.dist * 9);
    // нощни светлини
    for (const m of facadeMaterials) m.emissiveIntensity = night * 1.1;
    lampMaterial.emissiveIntensity = night * 3;
    for (const r of this.rotors) r.rotation.z += dt * 2.2;
    this.traffic.update(dt);
    if (this.precip) {
      const p = this.precip.geometry.getAttribute('position') as THREE.BufferAttribute;
      const snow = this.precip.userData.snow as boolean;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * (snow ? 2 : 14);
        if (y < 0) y += 30;
        p.setY(i, y);
        if (snow) p.setX(i, p.getX(i) + Math.sin(now / 900 + i) * dt * 0.3);
      }
      p.needsUpdate = true;
      this.precip.position.set(this.target.x, this.target.y, this.target.z);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
