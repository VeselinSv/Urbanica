/**
 * Градът в 3D: улици по релефа (асфалт с маркировка, бордюри и тротоари, пешеходни пътеки на кръстовищата),
 * мостове (плоча, парапети, колони до дъното на реката), тунели (бетонен портал в склона), площадки
 * („тераси“) под сградите и самите сгради. Градът се строи на блокове 8×8 плочки, които се „запичат“
 * (геометриите се сливат по материал) и се преизграждат само при промяна.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hasSidewalk, type TileMap, type TileState } from '@gce/shared';
import { type WorldGenerator } from '@gce/world-generation';
import { tunnelKind } from '../map/paint';
import { asphaltTexture, pavingTexture } from './textures';
import { buildingFor, mat, plain, zoneColor } from './buildings';
import type { Terrain3D } from './terrain';

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const WIDTH: Record<string, number> = { street: 0.56, avenue: 0.8, highway: 0.86, rural: 0.42, industrial: 0.62 };
const BLOCK = 8;

const asphalt = (kind: 'lane' | 'plain' | 'cross' | 'highway') =>
  mat(
    `asph:${kind}`,
    () => new THREE.MeshStandardMaterial({ map: asphaltTexture(kind), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
const paving = () => mat('paving', () => new THREE.MeshStandardMaterial({ map: pavingTexture(), roughness: 0.95 }));
export const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffd27a, emissiveIntensity: 0 });

/** Четириъгълник (по часовата стрелка отгоре) от 4 точки с UV. */
function quad(p: THREE.Vector3[], uv: [number, number][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // триъгълниците с лице нагоре (иначе се рисуват отдолу и асфалтът е черен)
  const e1 = p[1].clone().sub(p[0]);
  const e2 = p[2].clone().sub(p[0]);
  const up = e1.cross(e2).y > 0;
  const idx = up ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const pos: number[] = [];
  const uvs: number[] = [];
  for (const i of idx) {
    pos.push(p[i].x, p[i].y, p[i].z);
    uvs.push(uv[i][0], uv[i][1]);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

export class City3D {
  readonly group = new THREE.Group();
  private blocks = new Map<string, { sig: string; obj: THREE.Group }>();
  private tiles: TileMap = {};
  /** Височина на площадката по плочка (за сигнали върху парцели). */
  private lotTop = new Map<string, number>();
  season = 'summer';
  zoning = false;

  constructor(
    private gen: WorldGenerator,
    private terrain: Terrain3D,
  ) {}

  private lookup = (x: number, y: number) => this.tiles[`${x},${y}`];

  /** Нови плочки (всички градове в изгледа) – преизгражда само променените блокове. */
  setTiles(tiles: TileMap, season: string, zoning: boolean) {
    this.tiles = tiles;
    const force = season !== this.season || zoning !== this.zoning;
    this.season = season;
    this.zoning = zoning;
    const want = new Set<string>();
    for (const k of Object.keys(tiles)) {
      const [x, y] = k.split(',').map(Number);
      want.add(`${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)}`);
    }
    for (const [bk, b] of this.blocks)
      if (!want.has(bk)) {
        this.group.remove(b.obj);
        disposeBaked(b.obj);
        this.blocks.delete(bk);
      }
    for (const bk of want) {
      const [bx, by] = bk.split(',').map(Number);
      const sig = this.signature(bx, by);
      const old = this.blocks.get(bk);
      if (old && old.sig === sig && !force) continue;
      if (old) {
        this.group.remove(old.obj);
        disposeBaked(old.obj);
      }
      const obj = this.buildBlock(bx, by);
      this.group.add(obj);
      this.blocks.set(bk, { sig, obj });
    }
  }

  private signature(bx: number, by: number) {
    // плочките на блока и пръстен около него (пътищата зависят от съседите)
    let s = '';
    for (let y = by * BLOCK - 1; y <= by * BLOCK + BLOCK; y++)
      for (let x = bx * BLOCK - 1; x <= bx * BLOCK + BLOCK; x++) {
        const t = this.lookup(x, y);
        if (!t) continue;
        // само видимите свойства (без заетост/състояние, които се менят всеки ден)
        s += `${x},${y}:${t.t}`;
        if (t.t === 'road') s += `${t.c ?? ''}${t.j ?? ''}${t.sw ?? ''}${t.st ? 's' : ''}`;
        else if (t.t === 'zone') s += `${t.z}${t.lvl}${t.prog > 0 ? 'b' : ''}${t.ab ? 'a' : ''}`;
        else if (t.t === 'service') s += t.s;
        else if (t.t === 'facility') s += t.f;
        s += ';';
      }
    return s;
  }

  /** Повърхността в плочката: платното на пътя, площадката на парцела или терена. */
  surfaceY(x: number, y: number, px: number, pz: number): number {
    const t = this.lookup(x, y);
    if (t?.t === 'road') return this.isBridge(x, y) ? this.deck(x, y) : this.terrain.heightAt(px, pz) + 0.035;
    return this.lotTop.get(`${x},${y}`) ?? this.terrain.heightAt(px, pz);
  }

  /** Посоката на улицата в плочката: true – по X, false – по Z. */
  roadAlongX(x: number, y: number): boolean {
    return this.lookup(x - 1, y)?.t === 'road' || this.lookup(x + 1, y)?.t === 'road';
  }

  isBridge(x: number, y: number) {
    const k = y * this.gen.size + x;
    return this.lookup(x, y)?.t === 'road' && !!this.gen.country.water[k];
  }

  tunnel(x: number, y: number) {
    return this.lookup(x, y)?.t === 'road' ? tunnelKind(this.gen, this.lookup, x, y) : null;
  }

  /** Височина на моста в плочката: по съседните пътища на сушата, но над водата. */
  deck(x: number, y: number) {
    const lv = this.terrain.waterLevel(x, y);
    let h = Number.isNaN(lv) ? 0 : lv + 0.45;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.lookup(nx, ny)?.t === 'road' && !this.isBridge(nx, ny)) h = Math.max(h, this.terrain.heightAt(nx + 0.5, ny + 0.5) + 0.04);
    }
    return h;
  }

  private roadY(x: number, y: number, px: number, pz: number) {
    if (this.isBridge(x, y)) return this.deck(x, y);
    return this.terrain.heightAt(px, pz) + 0.035;
  }

  /** Височина на ръба към съседа: при мост – височината на моста (рампа). */
  private edgeY(x: number, y: number, dx: number, dy: number, px: number, pz: number) {
    const nx = x + dx;
    const ny = y + dy;
    if (this.isBridge(x, y)) return this.deck(x, y);
    if (this.isBridge(nx, ny)) return this.deck(nx, ny);
    return this.terrain.heightAt(px, pz) + 0.035;
  }

  private buildBlock(bx: number, by: number): THREE.Group {
    const raw = new THREE.Group();
    const dynamic = new THREE.Group();
    for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y++)
      for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x++) {
        const t = this.lookup(x, y);
        if (!t) continue;
        if (t.t === 'road') this.road(raw, x, y, t);
        else if (t.t === 'path') this.path(raw, x, y);
        else this.lot(raw, dynamic, x, y, t);
      }
    const out = bake(raw);
    out.add(dynamic);
    return out;
  }

  // ---------------------------------------------------------------- пътища
  private road(g: THREE.Group, x: number, y: number, t: Extract<TileState, { t: 'road' }>) {
    const tk = this.tunnel(x, y);
    if (tk === 'inside' || tk === 'portal') return; // под планината
    const cls = t.c ?? 'street';
    const w = WIDTH[cls] ?? 0.56;
    const cx = x + 0.5;
    const cz = y + 0.5;
    const arms = DIRS.map(([dx, dy]) => this.lookup(x + dx, y + dy)?.t === 'road');
    const n = arms.filter(Boolean).length;
    const straight = n === 2 && ((arms[0] && arms[2]) || (arms[1] && arms[3]));
    const laneMat = asphalt(cls === 'highway' ? 'highway' : 'lane');
    const yc = this.roadY(x, y, cx, cz);
    const bridge = this.isBridge(x, y);
    const nearBridge = bridge || DIRS.some(([dx, dy]) => this.isBridge(x + dx, y + dy));
    const at = (px: number, pz: number) => (nearBridge ? null : this.terrain.heightAt(px, pz) + 0.035);
    // ръкав към съседа: от ръба на централния квадрат до ръба на плочката
    const arm = (d: number, from: number) => {
      const [dx, dy] = DIRS[d];
      const ye = this.edgeY(x, y, dx, dy, cx + dx * 0.5, cz + dy * 0.5);
      const ys = from === 0 ? yc : yc;
      const px = -dy;
      const pz = dx;
      const pts: THREE.Vector3[] = [];
      const a0 = from;
      const a1 = 0.5;
      const P = (along: number, side: number, yv: number | null, frac: number) =>
        new THREE.Vector3(cx + dx * along + px * side, yv ?? ys + (ye - ys) * frac, cz + dy * along + pz * side);
      const mk = (along: number, side: number, frac: number) => {
        const wx = cx + dx * along + px * side;
        const wz = cz + dy * along + pz * side;
        return P(along, side, at(wx, wz), frac);
      };
      pts.push(mk(a0, -w / 2, (a0 - from) / (a1 - from || 1)), mk(a0, w / 2, 0), mk(a1, w / 2, 1), mk(a1, -w / 2, 1));
      const len = a1 - a0;
      g.add(
        new THREE.Mesh(
          quad(pts, [
            [0, 0],
            [1, 0],
            [1, len * 2],
            [0, len * 2],
          ]),
          laneMat,
        ),
      );
      if (hasSidewalk(t) && !bridge) {
        for (const s of [-1, 1])
          this.curb(g, cx + (dx * (a0 + a1)) / 2 + px * s * (w / 2 + 0.05), cz + (dy * (a0 + a1)) / 2 + pz * s * (w / 2 + 0.05), dx !== 0, len, (ys + ye) / 2);
      }
      return ye;
    };
    if (straight) {
      // права отсечка през цялата плочка
      const d = arms[0] ? 0 : 1;
      const [dx, dy] = DIRS[d];
      const px = -dy;
      const pz = dx;
      const y0 = this.edgeY(x, y, -dx, -dy, cx - dx * 0.5, cz - dy * 0.5);
      const y1 = this.edgeY(x, y, dx, dy, cx + dx * 0.5, cz + dy * 0.5);
      const segs = 2;
      for (let s = 0; s < segs; s++) {
        const a0 = -0.5 + s / segs;
        const a1 = a0 + 1 / segs;
        const yA = (a: number, side: number) => at(cx + dx * a + px * side, cz + dy * a + pz * side) ?? y0 + (y1 - y0) * (a + 0.5);
        const pts = [
          new THREE.Vector3(cx + dx * a0 - (px * w) / 2, yA(a0, -w / 2), cz + dy * a0 - (pz * w) / 2),
          new THREE.Vector3(cx + dx * a0 + (px * w) / 2, yA(a0, w / 2), cz + dy * a0 + (pz * w) / 2),
          new THREE.Vector3(cx + dx * a1 + (px * w) / 2, yA(a1, w / 2), cz + dy * a1 + (pz * w) / 2),
          new THREE.Vector3(cx + dx * a1 - (px * w) / 2, yA(a1, -w / 2), cz + dy * a1 - (pz * w) / 2),
        ];
        g.add(
          new THREE.Mesh(
            quad(pts, [
              [0, s],
              [1, s],
              [1, s + 1],
              [0, s + 1],
            ]),
            laneMat,
          ),
        );
      }
      if (hasSidewalk(t) && !bridge)
        for (const s of [-1, 1]) this.curb(g, cx + px * s * (w / 2 + 0.05), cz + pz * s * (w / 2 + 0.05), dx !== 0, 1, (y0 + y1) / 2);
      if (hasSidewalk(t) && !bridge && (x + y) % 2 === 0) this.lamp(g, cx + px * (w / 2 + 0.07), cz + pz * (w / 2 + 0.07), (y0 + y1) / 2, px, pz);
      if (bridge) this.bridge(g, x, y, d, w, (y0 + y1) / 2);
      this.tunnelPortals(g, x, y, w, yc);
      return;
    }
    // централен квадрат (кръстовище, завой, край)
    const sq = [
      new THREE.Vector3(cx - w / 2, at(cx - w / 2, cz - w / 2) ?? yc, cz - w / 2),
      new THREE.Vector3(cx + w / 2, at(cx + w / 2, cz - w / 2) ?? yc, cz - w / 2),
      new THREE.Vector3(cx + w / 2, at(cx + w / 2, cz + w / 2) ?? yc, cz + w / 2),
      new THREE.Vector3(cx - w / 2, at(cx - w / 2, cz + w / 2) ?? yc, cz + w / 2),
    ];
    g.add(
      new THREE.Mesh(
        quad(sq, [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]),
        asphalt(n >= 3 ? 'cross' : 'plain'),
      ),
    );
    arms.forEach((on, d) => {
      if (on) arm(d, w / 2);
      else if (hasSidewalk(t) && !bridge) {
        const [dx, dy] = DIRS[d];
        this.curb(g, cx + dx * (w / 2 + 0.05), cz + dy * (w / 2 + 0.05), dy !== 0, w + 0.2, yc);
      }
    });
    if (bridge) this.bridge(g, x, y, -1, w, yc);
    this.tunnelPortals(g, x, y, w, yc);
  }

  /** Тротоар (плочки), леко над платното, следва терена; ръбът към платното е бордюр. */
  private curb(g: THREE.Group, x: number, z: number, alongX: boolean, len: number, _y: number) {
    const hw = 0.05;
    const hl = len / 2;
    const segs = Math.max(1, Math.round(len * 2));
    for (let s = 0; s < segs; s++) {
      const a0 = -hl + (len * s) / segs;
      const a1 = a0 + len / segs;
      const P = (a: number, side: number) => {
        const px = x + (alongX ? a : side);
        const pz = z + (alongX ? side : a);
        return new THREE.Vector3(px, this.terrain.heightAt(px, pz) + 0.055, pz);
      };
      const pts = [P(a0, -hw), P(a0, hw), P(a1, hw), P(a1, -hw)];
      g.add(
        new THREE.Mesh(
          quad(pts, [
            [0, 0],
            [0.4, 0],
            [0.4, (a1 - a0) * 4],
            [0, (a1 - a0) * 4],
          ]),
          paving(),
        ),
      );
    }
  }

  /** Улична лампа: стълб, рамо и светеща глава (свети нощем). */
  private lamp(g: THREE.Group, x: number, z: number, y: number, px: number, pz: number) {
    const pole = plain(0x3d4247, 0.5, 0.6);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.2, 6), pole);
    p.position.set(x, y + 0.1, z);
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.006, 0.006), pole);
    a.position.set(x - px * 0.03, y + 0.2, z - pz * 0.03);
    a.rotation.y = Math.atan2(pz, px);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.016), lampMaterial);
    head.position.set(x - px * 0.06, y + 0.195, z - pz * 0.06);
    g.add(p, a, head);
  }

  /** Мост: плоча с ръбове, парапети, колони до дъното. d – посока (0 по X, 1 по Z, -1 – квадратна плоча). */
  private bridge(g: THREE.Group, x: number, y: number, d: number, w: number, yDeck: number) {
    const conc = plain(0xb9b5ac, 0.9);
    const cx = x + 0.5;
    const cz = y + 0.5;
    const alongX = d === 0;
    const L = 1.02;
    const W = d === -1 ? 1.02 : w + 0.16;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(alongX || d === -1 ? L : W, 0.1, alongX || d === -1 ? (d === -1 ? L : W) : L), conc);
    slab.position.set(cx, yDeck - 0.06, cz);
    slab.castShadow = true;
    g.add(slab);
    if (d !== -1) {
      const rail = plain(0x8e959b, 0.4, 0.6);
      for (const s of [-1, 1]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(alongX ? L : 0.012, 0.05, alongX ? 0.012 : L), rail);
        r.position.set(cx + (alongX ? 0 : s * (W / 2 - 0.01)), yDeck + 0.03, cz + (alongX ? s * (W / 2 - 0.01) : 0));
        g.add(r);
        // стълбчета
        for (let i = -2; i <= 2; i++) {
          const p = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.012), rail);
          p.position.set(cx + (alongX ? i * 0.22 : s * (W / 2 - 0.01)), yDeck + 0.0, cz + (alongX ? s * (W / 2 - 0.01) : i * 0.22));
          g.add(p);
        }
      }
    }
    // колони до дъното на реката
    const bed = this.terrain.tileH[y * this.gen.size + x];
    const hgt = yDeck - 0.11 - bed;
    if (hgt > 0.05) {
      const offs = w > 0.7 ? [-0.22, 0.22] : [0];
      for (const o of offs) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, hgt, 12), conc);
        p.position.set(cx + (alongX ? 0 : o), bed + hgt / 2, cz + (alongX ? o : 0));
        p.castShadow = true;
        g.add(p);
      }
      const cap = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.14 : W, 0.05, alongX ? W : 0.14), conc);
      cap.position.set(cx, yDeck - 0.135, cz);
      g.add(cap);
    }
  }

  /** Портал на тунел там, където пътят влиза в планината (към съсед „в тунела“). */
  private tunnelPortals(g: THREE.Group, x: number, y: number, w: number, yRoad: number) {
    DIRS.forEach(([dx, dy]) => {
      const k = this.tunnel(x + dx, y + dy);
      if (!k) return;
      const ex = x + 0.5 + dx * 0.5;
      const ez = y + 0.5 + dy * 0.5;
      const top = Math.max(yRoad + 0.28, this.terrain.heightAt(ex + dx * 0.25, ez + dy * 0.25) + 0.05);
      const H = top - yRoad;
      const conc = plain(0xa9a49a, 0.95);
      const alongX = dx !== 0;
      const span = w + 0.36;
      const wall = (off: number, width: number, h0: number, h1: number) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.08 : width, h1 - h0, alongX ? width : 0.08), conc);
        b.position.set(ex + (alongX ? 0 : off), yRoad + (h0 + h1) / 2, ez + (alongX ? off : 0));
        b.castShadow = true;
        g.add(b);
      };
      const open = w + 0.04;
      const oh = 0.2;
      wall(-(open / 2 + (span - open) / 4), (span - open) / 2, -0.05, H);
      wall(open / 2 + (span - open) / 4, (span - open) / 2, -0.05, H);
      wall(0, open, oh, H);
      // тъмна вътрешност на тунела
      const hole = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.02 : open, oh, alongX ? open : 0.02), plain(0x0b0c0e, 1));
      hole.position.set(ex + dx * 0.035, yRoad + oh / 2 - 0.01, ez + dy * 0.035);
      g.add(hole);
      // светлини в тунела
      const l = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.02 : 0.05, 0.01, alongX ? 0.05 : 0.02), lampMaterial);
      l.position.set(ex + dx * 0.06, yRoad + oh - 0.03, ez + dy * 0.06);
      g.add(l);
    });
  }

  private path(g: THREE.Group, x: number, y: number) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.9), paving());
    b.position.set(x + 0.5, this.terrain.heightAt(x + 0.5, y + 0.5) + 0.01, y + 0.5);
    g.add(b);
  }

  // ---------------------------------------------------------------- парцели и сгради
  private lot(g: THREE.Group, dyn: THREE.Group, x: number, y: number, t: TileState) {
    // височините по изгладения релеф (както е нарисуван)
    const H = (px: number, pz: number) => this.terrain.heightAt(px, pz);
    const corners = [H(x + 0.02, y + 0.02), H(x + 0.98, y + 0.02), H(x + 0.02, y + 0.98), H(x + 0.98, y + 0.98), H(x + 0.5, y + 0.5)];
    // площадка на средната височина; на стръмен бряг – не по-висока от 0.25 над най-ниския ъгъл
    const lo = Math.min(...corners);
    const mean = corners.reduce((a, b) => a + b, 0) / corners.length;
    const hi = Math.min(Math.max(...corners), Math.max(mean, lo + 0.02), lo + 0.12) + 0.01;
    const winter = this.season === 'winter';
    let top = 0x86b25a;
    if (t.t === 'zone') {
      if (t.lvl === 0) top = winter ? 0xe6ebee : 0x9fbf72;
      else if (t.z === 'R') top = winter ? 0xe9eef1 : 0x7fae54;
      else if (t.z === 'C' || t.z === 'O' || t.z === 'H') top = 0xb8b2a6;
      else if (t.z === 'A') top = winter ? 0xdfe4e6 : 0xb7a85a;
      else top = 0x9c9a94;
    } else if (t.t === 'service') top = t.s === 'park' ? (winter ? 0xe9eef1 : 0x6f9f45) : t.s === 'parking' ? 0x44474b : 0xb8b2a6;
    else top = 0x9c9a94;
    // тераса: равна площадка (на склон – с подпорна стена)
    this.lotTop.set(`${x},${y}`, hi + 0.03);
    // отгоре – площадката; отстрани – каменна подпорна стена
    const stone = plain(0x8d877c, 1);
    const topM = plain(top, 0.95);
    const terr = new THREE.Mesh(new THREE.BoxGeometry(0.98, hi - lo + 0.06, 0.98), [stone, stone, topM, stone, stone, stone]);
    terr.position.set(x + 0.5, (hi + lo) / 2 - 0.03, y + 0.5);
    terr.receiveShadow = true;
    g.add(terr);
    // празна зона: цветна рамка (в изгледа „Зониране“ – и запълнена)
    if (t.t === 'zone' && (t.lvl === 0 || this.zoning) && !(t.prog > 0)) {
      const zc = zoneColor(t.z);
      const m = mat(
        `zone:${zc}:${this.zoning}`,
        () => new THREE.MeshBasicMaterial({ color: zc, transparent: true, opacity: this.zoning ? 0.45 : 0.22, depthWrite: false }),
      );
      const q = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), m);
      q.rotation.x = -Math.PI / 2;
      q.position.set(x + 0.5, hi + 0.004, y + 0.5);
      g.add(q);
    }
    const seed = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    const b = buildingFor(t, seed % 9973, this.season);
    if (!b) return;
    // към пътя: +z на сградата гледа към съседната улица
    let rot = 0;
    for (const [i, [dx, dy]] of DIRS.entries())
      if (this.lookup(x + dx, y + dy)?.t === 'road') {
        rot = [Math.PI / 2, 0, -Math.PI / 2, Math.PI][i];
        break;
      }
    b.position.set(x + 0.5, hi + 0.0, y + 0.5);
    b.rotation.y = rot;
    if (t.t === 'zone' && t.ab)
      b.traverse((o) => ((o as THREE.Mesh).isMesh ? (((o as THREE.Mesh).material as THREE.Material[] | THREE.Material) = plain(0x6b6560, 1)) : null));
    // въртящи се части (перки) остават отделно
    const rotor = b.getObjectByName('rotor');
    if (rotor) {
      dyn.add(b);
      return;
    }
    g.add(b);
  }
}

/** Слива всички мрежи в групата по материал (за бързо рисуване). */
function bake(src: THREE.Group): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.getAttribute('position').count * 2) | 0), 2));
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    geo.applyMatrix4(m.matrixWorld);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (Array.isArray(m.material) && m.geometry.groups.length) {
      // разделяне по групите (фасада/покрив)
      const src2 = m.geometry.index ? m.geometry : null;
      for (const gr of m.geometry.groups) {
        const part = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'uv']) {
          const a = geo.getAttribute(name) as THREE.BufferAttribute;
          if (!a) continue;
          const start = src2 ? gr.start : gr.start;
          part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(start * a.itemSize, (start + gr.count) * a.itemSize), a.itemSize));
        }
        const mt = mats[gr.materialIndex ?? 0];
        if (!buckets.has(mt)) buckets.set(mt, []);
        buckets.get(mt)!.push(part);
      }
      return;
    }
    if (!buckets.has(mats[0])) buckets.set(mats[0], []);
    buckets.get(mats[0])!.push(geo);
  });
  const out = new THREE.Group();
  for (const [mt, list] of buckets) {
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mt);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

function disposeBaked(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
