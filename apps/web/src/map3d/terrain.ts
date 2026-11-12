/**
 * 3D терен: истински релеф (височинна карта по плочки), цветове по вид земя и сезон, вода с реално ниво –
 * морето, езерата и реките лежат в коритата си, а бреговете пресичат водната повърхност плавно.
 *
 * Координати: плочка (x, y) заема квадрата X ∈ [x, x+1], Z ∈ [y, y+1]; височината е по Y (в „плочки“).
 */
import * as THREE from 'three';
import { HILLS, MOUNTAINS, SEA, WATER_LAKE, WATER_OCEAN, WATER_RIVER, type WorldGenerator } from '@gce/world-generation';
import { grainTexture } from './textures';

export type Season3 = 'spring' | 'summer' | 'autumn' | 'winter';

/** Вертикален мащаб: разлика във височината (0..1) → плочки. */
export const HK = 16;
export const elev = (h: number) => (h - SEA) * HK;

const lerpc = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.max(0, Math.min(1, t)));

export class Terrain3D {
  readonly N: number;
  /** Височина на терена по плочка (за водните – дъното). */
  readonly tileH: Float32Array;
  /** Ниво на водата по плочка (NaN за суша). */
  readonly level: Float32Array;
  /** Височина в ъглите (N+1)². */
  readonly cornerH: Float32Array;
  /** Подробна мрежа на релефа: S точки на плочка, изгладена – плавни брегове и склонове. */
  static readonly S = 2;
  readonly F: number;
  readonly fineH: Float32Array;
  mesh!: THREE.Mesh;
  water!: THREE.Mesh;

  constructor(readonly gen: WorldGenerator) {
    const N = gen.size;
    this.N = N;
    const c = gen.country;
    this.tileH = new Float32Array(N * N);
    this.level = new Float32Array(N * N).fill(NaN);
    for (let k = 0; k < N * N; k++) {
      const h = c.height[k];
      const w = c.water[k];
      if (w === WATER_OCEAN) {
        this.level[k] = 0;
        this.tileH[k] = Math.min(elev(h), -0.7);
      } else if (w === WATER_LAKE || w === WATER_RIVER) {
        const lv = Math.max(0.05, elev(h) + 0.02);
        this.level[k] = lv;
        const depth = w === WATER_RIVER ? 0.28 + Math.min(0.4, (c.riverWidth[k] ?? 0) * 0.18) : 0.6;
        this.tileH[k] = lv - depth;
      } else this.tileH[k] = Math.max(0.04, elev(h));
    }
    const M = N + 1;
    this.cornerH = new Float32Array(M * M);
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        let s = 0;
        let n = 0;
        let minWater = Infinity;
        for (const [dx, dy] of [
          [-1, -1],
          [0, -1],
          [-1, 0],
          [0, 0],
        ]) {
          const x = i + dx;
          const y = j + dy;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const k = y * N + x;
          s += this.tileH[k];
          n++;
          if (!Number.isNaN(this.level[k])) minWater = Math.min(minWater, this.tileH[k]);
        }
        let v = n ? s / n : 0;
        // ъгъл на брега: малко под водата, за да няма „стъпало“ на брега
        if (minWater !== Infinity) v = Math.min(v, minWater + 0.55);
        this.cornerH[j * M + i] = v;
      }
    // подробна мрежа: билинейно от ъглите + изглаждане (пет пъти [1 2 1] – плавни брегове без зъбци)
    const S = Terrain3D.S;
    const F = N * S + 1;
    this.F = F;
    let fh = new Float32Array(F * F);
    for (let j = 0; j < F; j++)
      for (let i = 0; i < F; i++) {
        const x = i / S;
        const z = j / S;
        const ci = Math.min(N - 1, Math.floor(x));
        const cj = Math.min(N - 1, Math.floor(z));
        const tx = x - ci;
        const tz = z - cj;
        const a = this.cornerH[cj * M + ci];
        const b = this.cornerH[cj * M + ci + 1];
        const cc = this.cornerH[(cj + 1) * M + ci];
        const d = this.cornerH[(cj + 1) * M + ci + 1];
        fh[j * F + i] = (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
      }
    for (let pass = 0; pass < 5; pass++) {
      const out = new Float32Array(F * F);
      for (let j = 0; j < F; j++)
        for (let i = 0; i < F; i++) {
          let sum = 0;
          let w = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const x = i + dx;
              const y = j + dy;
              if (x < 0 || y < 0 || x >= F || y >= F) continue;
              const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
              sum += fh[y * F + x] * k;
              w += k;
            }
          out[j * F + i] = sum / w;
        }
      fh = out;
    }
    this.fineH = fh;
  }

  /** Височина на терена в точка (билинейно по подробната мрежа – точно като нарисувания релеф). */
  heightAt(x: number, z: number): number {
    const S = Terrain3D.S;
    const F = this.F;
    const fx = Math.max(0, Math.min(F - 1.0001, x * S));
    const fz = Math.max(0, Math.min(F - 1.0001, z * S));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.fineH;
    const a = h[j * F + i];
    const b = h[j * F + i + 1];
    const c = h[(j + 1) * F + i];
    const d = h[(j + 1) * F + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Ниво на водата в плочката (NaN – суша). */
  waterLevel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.N || y >= this.N) return NaN;
    return this.level[y * this.N + x];
  }

  /** Нормали и цветове за цялата подробна мрежа (общи за всички парчета – без шевове). */
  private normalsFull!: Float32Array;
  private colorFull!: Float32Array;
  private chunks: { geo: THREE.BufferGeometry; map: Uint32Array }[] = [];
  private material!: THREE.MeshStandardMaterial;

  /**
   * Релефът е на парчета 32×32 плочки: невидимите не се рисуват, а далечните са с 4 пъти по-малко точки
   * (THREE.LOD) – така и цялата държава, и отблизо градът вървят бързо.
   */
  build(season: Season3): THREE.Group {
    const S = Terrain3D.S;
    const F = this.F;
    const H = this.fineH;
    // нормали от височинната карта (централни разлики)
    const nf = new Float32Array(F * F * 3);
    for (let j = 0; j < F; j++)
      for (let i = 0; i < F; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(F - 1, i + 1);
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(F - 1, j + 1);
        const dx = (H[j * F + i1] - H[j * F + i0]) / ((i1 - i0) / S);
        const dz = (H[j1 * F + i] - H[j0 * F + i]) / ((j1 - j0) / S);
        const l = Math.hypot(dx, 1, dz);
        const o = (j * F + i) * 3;
        nf[o] = -dx / l;
        nf[o + 1] = 1 / l;
        nf[o + 2] = -dz / l;
      }
    this.normalsFull = nf;
    this.colorFull = new Float32Array(F * F * 3);
    this.computeColors(season);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, map: grainTexture(), roughness: 0.95, metalness: 0 });
    const g = new THREE.Group();
    const CH = 32;
    const n = Math.ceil(this.N / CH);
    for (let cy = 0; cy < n; cy++)
      for (let cx = 0; cx < n; cx++) {
        const lod = new THREE.LOD();
        const ox = cx * CH + CH / 2;
        const oz = cy * CH + CH / 2;
        lod.position.set(ox, 0, oz);
        for (const step of [1, 4]) {
          const geo = this.chunkGeometry(cx * CH * S, cy * CH * S, Math.min(F - 1, (cx + 1) * CH * S), Math.min(F - 1, (cy + 1) * CH * S), step, ox, oz);
          const m = new THREE.Mesh(geo, this.material);
          m.receiveShadow = true;
          lod.addLevel(m, step === 1 ? 0 : 110);
        }
        g.add(lod);
      }
    this.mesh = (g.children[0] as THREE.LOD).levels[0].object as THREE.Mesh;
    this.water = this.buildWater();
    g.add(this.water);
    return g;
  }

  private chunkGeometry(i0: number, j0: number, i1: number, j1: number, step: number, ox: number, oz: number) {
    const S = Terrain3D.S;
    const F = this.F;
    const H = this.fineH;
    const xs: number[] = [];
    for (let i = i0; i < i1; i += step) xs.push(i);
    xs.push(i1);
    const zs: number[] = [];
    for (let j = j0; j < j1; j += step) zs.push(j);
    zs.push(j1);
    const W = xs.length;
    const D = zs.length;
    const pos = new Float32Array(W * D * 3);
    const nrm = new Float32Array(W * D * 3);
    const uv = new Float32Array(W * D * 2);
    const map = new Uint32Array(W * D);
    for (let b = 0; b < D; b++)
      for (let a = 0; a < W; a++) {
        const v = b * W + a;
        const o = zs[b] * F + xs[a];
        map[v] = o;
        pos[v * 3] = xs[a] / S - ox;
        pos[v * 3 + 1] = H[o];
        pos[v * 3 + 2] = zs[b] / S - oz;
        nrm[v * 3] = this.normalsFull[o * 3];
        nrm[v * 3 + 1] = this.normalsFull[o * 3 + 1];
        nrm[v * 3 + 2] = this.normalsFull[o * 3 + 2];
        uv[v * 2] = xs[a] / S / 6;
        uv[v * 2 + 1] = zs[b] / S / 6;
      }
    const idx = new Uint32Array((W - 1) * (D - 1) * 6);
    let p = 0;
    for (let b = 0; b < D - 1; b++)
      for (let a = 0; a < W - 1; a++) {
        const v0 = b * W + a;
        const v1 = v0 + 1;
        const v2 = v0 + W;
        const v3 = v2 + 1;
        if (Math.abs(pos[v0 * 3 + 1] - pos[v3 * 3 + 1]) < Math.abs(pos[v1 * 3 + 1] - pos[v2 * 3 + 1])) idx.set([v0, v2, v3, v0, v3, v1], p);
        else idx.set([v0, v2, v1, v1, v2, v3], p);
        p += 6;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const col = new Float32Array(W * D * 3);
    for (let v = 0; v < W * D; v++) {
      col[v * 3] = this.colorFull[map[v] * 3];
      col[v * 3 + 1] = this.colorFull[map[v] * 3 + 1];
      col[v * 3 + 2] = this.colorFull[map[v] * 3 + 2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.chunks.push({ geo, map });
    return geo;
  }

  /** Нов сезон – преоцветява всички парчета. */
  recolor(season: Season3) {
    this.computeColors(season);
    for (const ch of this.chunks) {
      const c = ch.geo.getAttribute('color') as THREE.BufferAttribute;
      const arr = c.array as Float32Array;
      for (let v = 0; v < ch.map.length; v++) {
        arr[v * 3] = this.colorFull[ch.map[v] * 3];
        arr[v * 3 + 1] = this.colorFull[ch.map[v] * 3 + 1];
        arr[v * 3 + 2] = this.colorFull[ch.map[v] * 3 + 2];
      }
      c.needsUpdate = true;
    }
  }

  /** Цвят по точка: трева/гора/скали/сняг/пясък/дъно според височината, наклона, влагата и сезона. */
  private computeColors(season: Season3) {
    const N = this.N;
    const M = this.F;
    const S = Terrain3D.S;
    const c = this.gen.country;
    const C = {
      dry: new THREE.Color(0xa7ad62),
      lush: new THREE.Color(0x5d8a3b),
      forest: new THREE.Color(0x3f5a2c),
      hills: new THREE.Color(0x8e8a58),
      meadow: new THREE.Color(0x9a9a5c),
      rock: new THREE.Color(0x857f76),
      snow: new THREE.Color(0xf2f5f8),
      sand: new THREE.Color(0xd8c690),
      bed: new THREE.Color(0x6f6a55),
      autumn: new THREE.Color(0xb08a4a),
      out: new THREE.Color(0x8a9096),
    };
    const col = this.colorFull;
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        const o = j * M + i;
        const tx = Math.min(N - 1, Math.floor(i / S));
        const ty = Math.min(N - 1, Math.floor(j / S));
        const k = ty * N + tx;
        const h = c.height[k];
        const m = c.moisture[k];
        const f = c.forest[k];
        const steep = 1 - this.normalsFull[o * 3 + 1];
        let cc = lerpc(C.dry, C.lush, (m - 0.3) * 2);
        if (f > 0.35) cc = lerpc(cc, C.forest, (f - 0.35) * 2.5);
        if (h > HILLS - 0.04) cc = lerpc(cc, C.hills, ((h - HILLS + 0.04) / 0.1) * 0.6);
        if (h > 0.7) cc = lerpc(cc, C.meadow, ((h - 0.7) / 0.06) * 0.5);
        if (h > MOUNTAINS - 0.03) cc = lerpc(cc, C.rock, (h - MOUNTAINS + 0.03) / 0.07);
        cc = lerpc(cc, C.rock, (steep - 0.12) * 4);
        const wet = c.water[k];
        if (wet === WATER_OCEAN && this.fineH[o] > -0.3) cc = lerpc(C.sand, C.bed, 0.3);
        else if (wet) cc = C.bed.clone();
        else if (c.oceanDist[k] <= 2 && h < SEA + 0.03) cc = lerpc(cc, C.sand, 0.8);
        // сняг по върховете; сезони
        let snow = h > 0.83 ? (h - 0.83) / 0.05 : 0;
        if (season === 'winter' && !wet) snow = Math.max(snow, 0.72 + (h - 0.35) * 0.5 - steep * 1.5);
        if (season === 'autumn' && !wet) cc = lerpc(cc, C.autumn, 0.22);
        if (season === 'spring' && !wet) cc = lerpc(cc, C.lush, 0.12);
        cc = lerpc(cc, C.snow, snow);
        if (c.region[k] === 255 && !wet) cc = lerpc(cc, C.out, 0.45);
        col[o * 3] = cc.r;
        col[o * 3 + 1] = cc.g;
        col[o * 3 + 2] = cc.b;
      }
  }

  /** Водна повърхност: клетки с вода и пръстен около тях; брегът е там, където терена пресича нивото. */
  private buildWater(): THREE.Mesh {
    const N = this.N;
    const pos: number[] = [];
    const col: number[] = [];
    const deep = new THREE.Color(0x1f4f6e);
    const river = new THREE.Color(0x3d7f9a);
    const shallow = new THREE.Color(0x6aa8b8);
    const lvAt = (x: number, y: number) => this.waterLevel(x, y);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        // клетката е вода или съседна на вода
        let ref = NaN;
        let anyWater = false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const l = lvAt(x + dx, y + dy);
            if (!Number.isNaN(l)) {
              anyWater = true;
              ref = Number.isNaN(ref) ? l : Math.min(ref, l);
            }
          }
        if (!anyWater) continue;
        // ниво в ъглите: средно от съседните водни плочки (иначе – нивото на клетката)
        const corner = (cx: number, cy: number) => {
          let s = 0;
          let n = 0;
          for (const [dx, dy] of [
            [-1, -1],
            [0, -1],
            [-1, 0],
            [0, 0],
          ]) {
            const l = lvAt(cx + dx, cy + dy);
            if (!Number.isNaN(l)) {
              s += l;
              n++;
            }
          }
          return n ? s / n : ref;
        };
        const self = lvAt(x, y);
        const k = y * N + x;
        const isRiver = this.gen.country.water[k] === WATER_RIVER;
        // пръстенът около водата е със същия цвят – брегът се определя само от терена (без светли триъгълници)
        const near = Number.isNaN(self) ? ref : self;
        const cc = near <= 0.01 ? deep : isRiver || Number.isNaN(self) ? river : river.clone().lerp(deep, 0.4);
        void shallow;
        const v = [
          [x, y],
          [x + 1, y],
          [x, y + 1],
          [x + 1, y + 1],
        ].map(([cx, cy]) => [cx, corner(cx, cy) - 0.02, cy]);
        for (const t of [0, 2, 1, 1, 2, 3]) {
          pos.push(...v[t]);
          col.push(cc.r, cc.g, cc.b);
        }
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // гладка водна повърхност: нормалите нагоре (без фасети)
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      roughness: 0.06,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    return m;
  }
}
