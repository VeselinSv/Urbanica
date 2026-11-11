import { mulberry32 } from '@gce/shared';
import { MinHeap } from './heap';
import { Perlin2D } from './noise';
import { BG_CITIES, BG_DANUBE, BG_ELEVATION_B64, BG_N, BG_REGION_B64, BG_REGION_NAMES } from './bulgaria-data';

/**
 * Генератор на държавата (версия 2): една непрекъсната суша с крайбрежие, планински вериги, хидрология
 * (запълване на депресии → езера, оттичане → реки с притоци), гори и административни области.
 * Светът започва без селища и пътища – всичко се строи от играчите.
 *
 * Всичко е детерминистично спрямо seed-а и използва само аритметика и Math.sqrt/floor (без тригонометрия),
 * за да дава идентичен резултат на сървъра (Node) и в браузъра.
 */

export const SEA = 0.4;
export const HILLS = 0.6;
export const MOUNTAINS = 0.7;

export const WATER_NONE = 0;
export const WATER_OCEAN = 1;
export const WATER_LAKE = 2;
export const WATER_RIVER = 3;

export interface Pt {
  x: number;
  y: number;
}

export interface RiverPath {
  /** Изгладени точки в световни координати (плочка (x,y) заема [x,x+1)×[y,y+1)); w = ширина в плочки. */
  points: { x: number; y: number; w: number }[];
  /** Къде се влива: 'ocean' | 'lake' | 'river'. */
  mouth: 'ocean' | 'lake' | 'river' | 'edge';
}

export interface Lake {
  id: number;
  level: number;
  area: number;
  cx: number;
  cy: number;
}

export interface Region {
  id: number;
  name: string;
  /** Център на областта (само за разполагане на надписа; на картата няма селище). */
  cx: number;
  cy: number;
  area: number;
}

export interface CountryData {
  N: number;
  height: Float32Array;
  water: Uint8Array;
  riverWidth: Float32Array;
  moisture: Float32Array;
  forest: Float32Array;
  slope: Float32Array;
  oceanDist: Uint8Array;
  region: Uint8Array;
  rivers: RiverPath[];
  lakes: Lake[];
  regions: Region[];
  name: string;
}

const SQRT2 = 1.4142135623730951;
const D8X = [1, -1, 0, 0, 1, 1, -1, -1];
const D8Y = [0, 0, 1, -1, 1, -1, 1, -1];
const D8C = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

export function distToPolyline(px: number, py: number, pts: Pt[]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (d < best) best = d;
  }
  return best;
}

/** Изглаждане на Чайкин – запазва крайните точки. */
export function chaikin<T extends Pt>(pts: T[], iterations: number, lerp: (a: T, b: T, t: number) => T): T[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const out: T[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      out.push(lerp(cur[i], cur[i + 1], 0.25));
      out.push(lerp(cur[i], cur[i + 1], 0.75));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

// ---------------------------------------------------------------- имена
const ROOTS = [
  'Бел',
  'Бор',
  'Вед',
  'Вран',
  'Зор',
  'Ябл',
  'Звезд',
  'Кал',
  'Лес',
  'Мир',
  'Остр',
  'Равн',
  'Слав',
  'Тис',
  'Черн',
  'Ясн',
  'Дъб',
  'Бистр',
  'Камен',
  'Сребр',
  'Злат',
  'Луг',
  'Вит',
  'Рос',
  'Стрел',
  'Гор',
  'Мор',
  'Зелен',
  'Ясен',
  'Брез',
  'Вълч',
  'Липн',
  'Дрян',
  'Кост',
  'Пес',
  'Студ',
  'Топл',
  'Сух',
  'Мъгл',
  'Орех',
  'Явор',
  'Бук',
  'Елх',
  'Глог',
  'Мед',
  'Сол',
  'Вис',
  'Широк',
  'Дълг',
  'Кремен',
  'Цвет',
  'Здрав',
];
const SUFFIX = ['ово', 'ево', 'ец', 'ица', 'ище', 'ин', 'ен', 'ина', 'ник', 'овец', 'ане', 'инци', 'ополе', 'ица', 'ово'];

function nameGen(rnd: () => number) {
  const used = new Set<string>();
  return () => {
    for (let a = 0; a < 200; a++) {
      const root = ROOTS[Math.floor(rnd() * ROOTS.length)];
      const n = root + SUFFIX[Math.floor(rnd() * SUFFIX.length)];
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    return `Област ${used.size + 1}`;
  };
}

// ---------------------------------------------------------------- реални данни за България
function b64bytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lut = new Uint8Array(128);
  for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lut[clean.charCodeAt(i)];
    const b = lut[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? lut[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? lut[clean.charCodeAt(i + 3)] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
let bgCache: { elev: Int16Array; region: Uint8Array } | null = null;
function bulgaria() {
  if (!bgCache) {
    const eb = b64bytes(BG_ELEVATION_B64);
    const elev = new Int16Array(BG_N * BG_N);
    for (let i = 0; i < elev.length; i++) elev[i] = ((eb[i * 2] | (eb[i * 2 + 1] << 8)) << 16) >> 16;
    bgCache = { elev, region: b64bytes(BG_REGION_B64) };
  }
  return bgCache;
}

/** Метри → вътрешна височина 0..1 (SEA = 0.4 е морското равнище; HILLS ≈ 700 m, MOUNTAINS ≈ 1300 m). */
function metersToHeight(m: number): number {
  if (m <= 0) return Math.max(0, SEA - 0.002 + m / 2000);
  const pts: [number, number][] = [
    [0, 0.404],
    [150, 0.43],
    [400, 0.5],
    [700, HILLS],
    [1300, MOUNTAINS],
    [2900, 0.95],
  ];
  for (let i = 1; i < pts.length; i++)
    if (m <= pts[i][0]) {
      const [m0, h0] = pts[i - 1];
      const [m1, h1] = pts[i];
      return h0 + ((m - m0) / (m1 - m0)) * (h1 - h0);
    }
  return 0.95;
}

/** Реални градове на България – само имена за ориентация (на картата не са построени). */
export const REAL_PLACES = BG_CITIES;

// ---------------------------------------------------------------- основен генератор
export function generateCountry(seedHash: number, N: number): CountryData {
  const rnd = mulberry32(seedHash ^ 0x5eed);
  const cx = N / 2;
  const cy = N / 2;
  const nCont = new Perlin2D(seedHash ^ 0xabcd);
  const nHills = new Perlin2D(seedHash ^ 0x1234);
  const nRidge = new Perlin2D(seedHash ^ 0x2468);
  const nWarpA = new Perlin2D(seedHash ^ 0x9e37);
  const nWarpB = new Perlin2D(seedHash ^ 0x79b9);
  const nMoist = new Perlin2D(seedHash ^ 0x7777);
  const nForest = new Perlin2D(seedHash ^ 0xf0e5);
  const NN = N * N;
  const idx = (x: number, y: number) => y * N + x;

  // ---------- 1. Релеф: реалните височини на България и съседите (AWS Terrain Tiles) ----------
  // Фин шум добавя текстура в равнините, без да променя формите на релефа.
  if (N !== BG_N) throw new Error(`Картата на България е ${BG_N}×${BG_N}, а светът е ${N}×${N}`);
  const bg = bulgaria();
  const height = new Float32Array(NN);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = idx(x, y);
      const m = bg.elev[k];
      let h = metersToHeight(m);
      if (m > 0) h += (nHills.fbm(x / 9, y / 9, 3) - 0.5) * 0.008;
      height[k] = h < 0 ? 0 : h > 1 ? 1 : h;
    }
  void rnd;
  void nCont;
  void nRidge;
  void cx;
  void cy;

  // ---------- 2. Океан (свързан с ръба) ----------
  const water = new Uint8Array(NN);
  {
    const q: number[] = [];
    for (let i = 0; i < N; i++)
      for (const k of [idx(i, 0), idx(i, N - 1), idx(0, i), idx(N - 1, i)])
        if (!water[k] && height[k] < SEA) {
          water[k] = WATER_OCEAN;
          q.push(k);
        }
    for (let qi = 0; qi < q.length; qi++) {
      const k = q[qi];
      const x = k % N;
      const y = (k - x) / N;
      for (let d = 0; d < 4; d++) {
        const xx = x + D8X[d];
        const yy = y + D8Y[d];
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const kk = idx(xx, yy);
        if (!water[kk] && height[kk] < SEA) {
          water[kk] = WATER_OCEAN;
          q.push(kk);
        }
      }
    }
  }

  // ---------- 3. Запълване на депресии (priority flood) ----------
  const filled = new Float32Array(NN);
  const visited = new Uint8Array(NN);
  {
    const heap = new MinHeap(1 << 16);
    for (let k = 0; k < NN; k++)
      if (water[k] === WATER_OCEAN) {
        filled[k] = height[k];
        visited[k] = 1;
        const x = k % N;
        const y = (k - x) / N;
        // само океанските клетки до суша влизат в купчината
        let shore = false;
        for (let d = 0; d < 4 && !shore; d++) {
          const xx = x + D8X[d];
          const yy = y + D8Y[d];
          if (xx >= 0 && yy >= 0 && xx < N && yy < N && water[idx(xx, yy)] !== WATER_OCEAN) shore = true;
        }
        if (shore) heap.push(SEA, k);
      }
    for (let i = 0; i < N; i++)
      for (const k of [idx(i, 0), idx(i, N - 1), idx(0, i), idx(N - 1, i)]) {
        if (visited[k]) continue;
        visited[k] = 1;
        filled[k] = height[k];
        heap.push(height[k], k);
      }
    while (heap.size) {
      const k = heap.pop();
      const x = k % N;
      const y = (k - x) / N;
      const base = water[k] === WATER_OCEAN ? SEA : filled[k];
      for (let d = 0; d < 8; d++) {
        const xx = x + D8X[d];
        const yy = y + D8Y[d];
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const kk = idx(xx, yy);
        if (visited[kk]) continue;
        visited[kk] = 1;
        const f = Math.max(height[kk], base + 1e-5);
        filled[kk] = f;
        heap.push(f, kk);
      }
    }
  }

  // ---------- 4. Езера: големи депресии остават вода, малките се запълват ----------
  const lakes: Lake[] = [];
  {
    const lakeId = new Int32Array(NN).fill(-1);
    for (let k = 0; k < NN; k++) {
      if (water[k] || lakeId[k] >= 0 || filled[k] - height[k] < 0.02) continue;
      const comp: number[] = [k];
      lakeId[k] = lakes.length;
      for (let qi = 0; qi < comp.length; qi++) {
        const c = comp[qi];
        const x = c % N;
        const y = (c - x) / N;
        for (let d = 0; d < 4; d++) {
          const xx = x + D8X[d];
          const yy = y + D8Y[d];
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          const kk = idx(xx, yy);
          if (water[kk] || lakeId[kk] >= 0 || filled[kk] - height[kk] < 0.02) continue;
          lakeId[kk] = lakes.length;
          comp.push(kk);
        }
      }
      if (comp.length >= 60 && bg.region[k] === 255) {
        let sx = 0;
        let sy = 0;
        for (const c of comp) {
          water[c] = WATER_LAKE;
          sx += c % N;
          sy += Math.floor(c / N);
        }
        lakes.push({ id: lakes.length, level: filled[k], area: comp.length, cx: sx / comp.length, cy: sy / comp.length });
      } else {
        for (const c of comp) {
          height[c] = filled[c];
          lakeId[c] = -2;
        }
        lakes.push({ id: lakes.length, level: -1, area: 0, cx: 0, cy: 0 });
      }
    }
    // премахваме празните записи, като пазим реда
    const real = lakes.filter((l) => l.level >= 0);
    lakes.length = 0;
    real.forEach((l, i) => lakes.push({ ...l, id: i }));
  }
  // плитчините в депресиите, които не станаха езера, също са суша
  for (let k = 0; k < NN; k++) if (!water[k] && filled[k] > height[k]) height[k] = filled[k];

  // ---------- 5. Посока на оттичане и натрупване на поток ----------
  const recv = new Int32Array(NN).fill(-1);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = idx(x, y);
      if (water[k] === WATER_OCEAN) continue;
      let best = -1;
      let bestDrop = 0;
      for (let d = 0; d < 8; d++) {
        const xx = x + D8X[d];
        const yy = y + D8Y[d];
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const kk = idx(xx, yy);
        const drop = (filled[k] - filled[kk]) / D8C[d];
        if (drop > bestDrop) {
          bestDrop = drop;
          best = kk;
        }
      }
      recv[k] = best;
    }
  const order = new Int32Array(NN);
  for (let k = 0; k < NN; k++) order[k] = k;
  order.sort((a, b) => filled[b] - filled[a] || a - b);
  const moisture = new Float32Array(NN);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) moisture[idx(x, y)] = nMoist.fbm(x / 70 + 100, y / 70 - 50, 4);
  const acc = new Float32Array(NN);
  for (let i = 0; i < NN; i++) {
    const k = order[i];
    if (water[k] === WATER_OCEAN) continue;
    acc[k] += 0.4 + moisture[k] + (height[k] > HILLS ? 0.6 : 0);
    if (recv[k] >= 0) acc[recv[k]] += acc[k];
  }

  // ---------- 6. Реки: трасиране от изворите до морето/езерото/сливането ----------
  const RIVER_T = N * 1.5; // водосбор, над който се появява река
  const rivers: RiverPath[] = [];
  const onRiver = new Int32Array(NN).fill(-1);
  for (let i = 0; i < NN; i++) {
    const s = order[i];
    if (water[s] || acc[s] < RIVER_T || onRiver[s] >= 0) continue;
    const cells: number[] = [];
    let k = s;
    let mouth: RiverPath['mouth'] = 'edge';
    for (let guard = 0; guard < NN; guard++) {
      cells.push(k);
      if (water[k] === WATER_OCEAN) {
        mouth = 'ocean';
        break;
      }
      if (water[k] === WATER_LAKE) {
        mouth = 'lake';
        break;
      }
      if (onRiver[k] >= 0 && k !== s) {
        mouth = 'river';
        break;
      }
      onRiver[k] = rivers.length;
      if (recv[k] < 0) break;
      k = recv[k];
    }
    if (cells.length < 6) continue;
    const raw = cells.map((c) => {
      const x = c % N;
      const y = (c - x) / N;
      const a = acc[Math.min(c, NN - 1)];
      return { x: x + 0.5, y: y + 0.5, w: Math.min(3.6, 0.45 + Math.sqrt(a / RIVER_T) * 0.55) };
    });
    // в устието ширината е като предишната точка
    raw[raw.length - 1].w = raw[Math.max(0, raw.length - 2)].w;
    const pts = chaikin(raw, 3, (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t }));
    rivers.push({ points: pts, mouth });
  }

  // Дунав – реалното корито по северната граница (водосборът му е извън картата).
  rivers.push({
    points: chaikin(
      BG_DANUBE.map((p) => ({ x: p.x, y: p.y, w: 3.4 })),
      3,
      (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t }),
    ),
    mouth: 'ocean',
  });

  // Растеризация на реките в плочки + оформяне на долини.
  const riverWidth = new Float32Array(NN);
  const riverDist = new Float32Array(NN).fill(99);
  for (const r of rivers) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const w = Math.max(a.w, b.w);
      const R = Math.ceil(w / 2 + 7);
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - R));
      const x1 = Math.min(N - 1, Math.ceil(Math.max(a.x, b.x) + R));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - R));
      const y1 = Math.min(N - 1, Math.ceil(Math.max(a.y, b.y) + R));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = idx(x, y);
          const d = distToSegment(x + 0.5, y + 0.5, a.x, a.y, b.x, b.y) - w / 2;
          if (d < riverDist[k]) riverDist[k] = d;
          if (d < 0.05 && !water[k] && w > riverWidth[k]) riverWidth[k] = w;
        }
    }
  }
  for (let k = 0; k < NN; k++) {
    if (water[k]) continue;
    if (riverWidth[k] > 0) water[k] = WATER_RIVER;
    const d = riverDist[k];
    if (d < 7) {
      // речна долина: релефът се спуска плавно към коритото
      const t = 1 - Math.max(0, d) / 7;
      const target = SEA + 0.012 + (height[k] - SEA) * 0.55;
      height[k] = height[k] + (target - height[k]) * t * t * 0.8;
      if (height[k] < SEA + 0.006) height[k] = SEA + 0.006;
    }
  }

  // ---------- 7. Разстояние до морето, наклон, влажност, гори ----------
  const oceanDist = new Uint8Array(NN).fill(255);
  {
    const q: number[] = [];
    for (let k = 0; k < NN; k++)
      if (water[k] === WATER_OCEAN) {
        oceanDist[k] = 0;
        q.push(k);
      }
    for (let qi = 0; qi < q.length; qi++) {
      const k = q[qi];
      if (oceanDist[k] >= 30) continue;
      const x = k % N;
      const y = (k - x) / N;
      for (let d = 0; d < 4; d++) {
        const xx = x + D8X[d];
        const yy = y + D8Y[d];
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const kk = idx(xx, yy);
        if (oceanDist[kk] === 255) {
          oceanDist[kk] = oceanDist[k] + 1;
          q.push(kk);
        }
      }
    }
  }
  const slope = new Float32Array(NN);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const hx = height[idx(Math.min(N - 1, x + 1), y)] - height[idx(Math.max(0, x - 1), y)];
      const hy = height[idx(x, Math.min(N - 1, y + 1))] - height[idx(x, Math.max(0, y - 1))];
      slope[idx(x, y)] = Math.sqrt(hx * hx + hy * hy) * 0.5;
    }
  for (let k = 0; k < NN; k++) {
    let m = moisture[k];
    if (riverDist[k] < 6) m += (6 - Math.max(0, riverDist[k])) * 0.03;
    if (oceanDist[k] < 12) m += (12 - oceanDist[k]) * 0.008;
    moisture[k] = m > 1 ? 1 : m;
  }
  const forest = new Float32Array(NN);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = idx(x, y);
      if (water[k]) continue;
      const h = height[k];
      if (h > 0.8) continue; // над горната граница на гората
      let f = nForest.fbm(x / 46, y / 46, 4) * 1.6 - 0.32 + (moisture[k] - 0.5) * 0.6;
      if (h > HILLS) f += 0.18; // хълмовете и подножията са по-залесени
      if (riverDist[k] < 1.6 && riverDist[k] > 0) f += 0.12; // крайречна растителност
      if (oceanDist[k] < 3) f -= 0.4;
      forest[k] = f < 0 ? 0 : f > 1 ? 1 : f;
    }

  // ---------- 8–9. Реалните административни области (geoBoundaries, 28 области) ----------
  const region = new Uint8Array(NN).fill(255);
  const sums = BG_REGION_NAMES.map(() => ({ x: 0, y: 0, n: 0 }));
  for (let k = 0; k < NN; k++) {
    const rg = bg.region[k];
    if (rg === 255 || water[k] === WATER_OCEAN) continue;
    region[k] = rg;
    const x = k % N;
    sums[rg].x += x;
    sums[rg].y += (k - x) / N;
    sums[rg].n++;
  }
  const regions: Region[] = BG_REGION_NAMES.map((name, i) => ({
    id: i,
    name: name === 'София град' ? 'София (столица)' : `Област ${name}`,
    cx: sums[i].n ? sums[i].x / sums[i].n : 0,
    cy: sums[i].n ? sums[i].y / sums[i].n : 0,
    area: sums[i].n,
  }));
  void nameGen;
  void nWarpA;
  void nWarpB;

  const countryName = 'България';
  return { N, height, water, riverWidth, moisture, forest, slope, oceanDist, region, rivers, lakes, regions, name: countryName };
}
