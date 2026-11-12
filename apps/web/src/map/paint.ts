/**
 * Рисуване на чанк (32×32 плочки) в Canvas 2D в изометрична проекция.
 *
 * Земята (терен, ниви, градска среда, реки, пътища, маркировка) се рисува в световни координати
 * чрез афинна изометрична трансформация – така кривите на реките, кръговите движения и пътищата
 * са гладки и не следват решетката. Обемните обекти (сгради, дървета) се „печатат“ като спрайтове,
 * сортирани по дълбочина. Резултатът се качва като една текстура (малко draw call-ове в PixiJS).
 */
import { newCanvas } from './canvas';
import { BALANCE, ZONES, hasSidewalk, isWalkable, type TileState } from '@gce/shared';
import { HILLS, MOUNTAINS, SEA, Terrain, WATER_LAKE, WATER_OCEAN, WATER_RIVER, type Pt, type WorldGenerator } from '@gce/world-generation';
import { FLOOR, getSprite, h01, mixc, rgb, type BuildingKey, type Season, type TreeKind } from './sprites';
import { PATH_WIDTH, ROAD_GEOM } from './roadgeom';

export const CHUNK = BALANCE.world.chunkSize;
/** Горно поле на платното на чанка (px при мащаб 1) за високите обекти. */
export const TOP_MARGIN = 300;

export type TileLookup = (x: number, y: number) => TileState | undefined;

export interface PaintOptions {
  res: number;
  zoning: boolean;
  /** Подробност: 2 – близо (маркировка, коли, прозорци), 1 – средно. */
  detail: 1 | 2;
  /** Територия на град на играч – горите там са изсечени (остават единични дървета). */
  cleared?: (x: number, y: number) => boolean;
  /**
   * Ако е подаден, сградите на градовете не се „печатат“ в текстурата, а се връщат тук –
   * рендерерът ги показва като отделни спрайтове, сортирани по дълбочина заедно с колите и хората
   * (така колите минават зад сградите).
   */
  actors?: CityActor[];
  /** Сезон: сняг по земята и покривите, есенни/голи дървета. */
  season?: Season;
}

/** Сграда на град като отделен обект (за сортиране по дълбочина с трафика). */
export interface CityActor {
  d: number;
  wx: number;
  wy: number;
  key: BuildingKey;
}

type Ctx = CanvasRenderingContext2D;

// ------------------------------------------------------------------ палитра
const C = {
  deep: 0x1c4a73,
  shallow: 0x4f9bb0,
  lake: 0x3f83a6,
  river: 0x4b8eae,
  riverDeep: 0x3c7898,
  bank: 0xb3a37a,
  sand: 0xd9c99a,
  grassLush: 0x6c9a44,
  grassDry: 0xa7a45e,
  forestFloor: 0x4b6f37,
  hills: 0x8a8d58,
  rock: 0x8e8981,
  snow: 0xeff2f4,
  asphalt: 0x4a4d52,
  asphaltOld: 0x5f6064,
  sidewalk: 0xcdc8bb,
  verge: 0xa89c7c,
  curb: 0xe3dfd5,
  marking: 0xf3f2ec,
  markingYellow: 0xe8c547,
  median: 0x6f8f47,
  lawn: 0x8db763,
  paving: 0xc8c2b4,
  concrete: 0xa8a49b,
  courtyard: 0x8bb362,
};

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ------------------------------------------------------------------ полилинии
function bboxHit(pts: Pt[], x0: number, y0: number, x1: number, y1: number) {
  for (const p of pts) if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
  return false;
}

// ------------------------------------------------------------------ шум за текстура
let noiseCanvas: HTMLCanvasElement | null = null;
function grainPattern(g: Ctx): CanvasPattern | null {
  if (!noiseCanvas) {
    noiseCanvas = newCanvas();
    noiseCanvas.width = 128;
    noiseCanvas.height = 128;
    const n = noiseCanvas.getContext('2d')!;
    const img = n.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) {
      const v = 110 + Math.floor(h01(i, 77) * 40);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    n.putImageData(img, 0, 0);
  }
  return g.createPattern(noiseCanvas, 'repeat');
}

/** Плавен стойностен шум (0..1) с мащаб scale плочки – за поляни в горите и петна в тревата. */
export function smoothNoise(wx: number, wy: number, scale: number, seed: number) {
  const x = wx / scale;
  const y = wy / scale;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = h01(x0, y0, seed);
  const b = h01(x0 + 1, y0, seed);
  const c = h01(x0, y0 + 1, seed);
  const d = h01(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

// ------------------------------------------------------------------ терен
/** Цвят на терена в произволна точка (wx, wy) – непрекъснато, с хълмово осветяване. */
export function terrainSampler(gen: WorldGenerator) {
  const c = gen.country;
  const N = c.N;
  const H = c.height;
  const F = c.forest;
  const M = c.moisture;
  const at = (arr: ArrayLike<number>, x: number, y: number) => {
    const xi = x < 0 ? 0 : x >= N ? N - 1 : x;
    const yi = y < 0 ? 0 : y >= N ? N - 1 : y;
    return arr[yi * N + xi];
  };
  const bil = (arr: ArrayLike<number>, wx: number, wy: number) => {
    const fx = wx - 0.5;
    const fy = wy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = at(arr, x0, y0);
    const b = at(arr, x0 + 1, y0);
    const cc = at(arr, x0, y0 + 1);
    const d = at(arr, x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
  };
  // Маска на водата, размита два пъти (3x3) – бреговата линия става плавна крива, а не стъпала.
  let blur = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) blur[k] = c.water[k] === WATER_OCEAN || c.water[k] === WATER_LAKE ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const nb = new Float32Array(N * N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx < 0 ? 0 : x + dx >= N ? N - 1 : x + dx;
            const yy = y + dy < 0 ? 0 : y + dy >= N ? N - 1 : y + dy;
            sum += blur[yy * N + xx] * (dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1);
          }
        nb[y * N + x] = sum / 16;
      }
    blur = nb;
  }
  const wet = (x: number, y: number) => at(blur, x, y);
  const wetB = (wx: number, wy: number) => {
    const fx = wx - 0.5;
    const fy = wy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    return (wet(x0, y0) * (1 - tx) + wet(x0 + 1, y0) * tx) * (1 - ty) + (wet(x0, y0 + 1) * (1 - tx) + wet(x0 + 1, y0 + 1) * tx) * ty;
  };
  /** Връща [r,g,b]. */
  return (wx: number, wy: number, out: number[]) => {
    const h = bil(H, wx, wy);
    const n = h01(Math.floor(wx * 8), Math.floor(wy * 8), 3) - 0.5;
    const w = wetB(wx, wy) + n * 0.06;
    let col: number;
    if (w > 0.5) {
      const tileW = at(c.water, Math.floor(wx), Math.floor(wy));
      if (tileW === WATER_LAKE || (tileW !== WATER_OCEAN && h > SEA)) {
        col = mixc(C.shallow, C.lake, clamp01((w - 0.5) * 2.5));
      } else {
        const depth = clamp01((SEA - h) / 0.09);
        col = mixc(C.shallow, C.deep, depth);
      }
      // плитка ивица и пяна до брега
      if (w < 0.6) col = mixc(col, 0xd9ecef, (0.6 - w) * 4);
      out[0] = (col >> 16) & 255;
      out[1] = (col >> 8) & 255;
      out[2] = col & 255;
      return;
    }
    const m = bil(M, wx, wy);
    const f = bil(F, wx, wy);
    col = mixc(C.grassDry, C.grassLush, clamp01((m - 0.3) * 2));
    // петна в тревата (ливади, ниви, сенчести участъци)
    const patch = smoothNoise(wx, wy, 5, 91) - 0.5;
    col = patch > 0 ? mixc(col, 0x9fbf5a, patch * 0.35) : mixc(col, 0x557f3a, -patch * 0.3);
    // пясък по крайбрежието
    if (w > 0.28 && h < SEA + 0.035) col = mixc(col, C.sand, clamp01((w - 0.28) * 4.5));
    if (f > 0.35) col = mixc(col, C.forestFloor, clamp01((f - 0.35) * 2.2));
    if (h > HILLS - 0.04) col = mixc(col, C.hills, clamp01((h - HILLS + 0.04) / 0.1) * 0.7);
    // алпийски ливади над горския пояс
    if (h > 0.7) col = mixc(col, 0xa6a46a, clamp01((h - 0.7) / 0.06) * 0.6);
    if (h > MOUNTAINS - 0.03) col = mixc(col, C.rock, clamp01((h - MOUNTAINS + 0.03) / 0.07));
    // стръмните склонове са скалисти
    const gx = bil(H, wx + 0.5, wy) - bil(H, wx - 0.5, wy);
    const gy = bil(H, wx, wy + 0.5) - bil(H, wx, wy - 0.5);
    const slope = Math.sqrt(gx * gx + gy * gy);
    if (h > HILLS - 0.05) col = mixc(col, mixc(C.rock, 0x6f6a62, 0.4), clamp01((slope - 0.025) * 18) * 0.75);
    if (h > 0.83) col = mixc(col, C.snow, clamp01((h - 0.83) / 0.05));
    // извън България – избледнял фон (там не се строи)
    if (at(c.region, Math.floor(wx), Math.floor(wy)) === 255) col = mixc(col, 0x8a9096, 0.55);
    // хълмово осветяване (светлина отгоре-вляво на екрана = посока -x)
    const dh = bil(H, wx - 0.6, wy - 0.15) - bil(H, wx + 0.6, wy + 0.15);
    const sh = 1 + Math.max(-0.5, Math.min(0.45, dh * 26)) + n * 0.05;
    out[0] = Math.min(255, ((col >> 16) & 255) * sh);
    out[1] = Math.min(255, ((col >> 8) & 255) * sh);
    out[2] = Math.min(255, (col & 255) * sh);
  };
}

const samplers = new WeakMap<WorldGenerator, ReturnType<typeof terrainSampler>>();
function sampler(gen: WorldGenerator) {
  let s = samplers.get(gen);
  if (!s) {
    s = terrainSampler(gen);
    samplers.set(gen, s);
  }
  return s;
}

function paintTerrain(g: Ctx, gen: WorldGenerator, x0: number, y0: number, size: number, S: number) {
  const M = 1;
  const n = (size + 2 * M) * S;
  const img = newCanvas();
  img.width = n;
  img.height = n;
  const ig = img.getContext('2d')!;
  const data = ig.createImageData(n, n);
  const sample = sampler(gen);
  const out = [0, 0, 0];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      sample(x0 - M + (i + 0.5) / S, y0 - M + (j + 0.5) / S, out);
      const o = (j * n + i) * 4;
      data.data[o] = out[0];
      data.data[o + 1] = out[1];
      data.data[o + 2] = out[2];
      data.data[o + 3] = 255;
    }
  ig.putImageData(data, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(img, x0 - M, y0 - M, size + 2 * M, size + 2 * M);
}

// ------------------------------------------------------------------ реки и езера
function paintRivers(g: Ctx, gen: WorldGenerator, x0: number, y0: number, x1: number, y1: number) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const rivers = gen.rivers.filter((r) => bboxHit(r.points, x0 - 4, y0 - 4, x1 + 4, y1 + 4));
  for (const pass of [0, 1, 2, 3, 4, 5]) {
    for (const r of rivers) {
      const p = r.points;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i];
        const b = p[i + 1];
        if ((a.x < x0 - 4 && b.x < x0 - 4) || (a.x > x1 + 4 && b.x > x1 + 4) || (a.y < y0 - 4 && b.y < y0 - 4) || (a.y > y1 + 4 && b.y > y1 + 4)) continue;
        const w = (a.w + b.w) / 2;
        const wa = gen.country.water[Math.floor(a.y) * gen.size + Math.floor(a.x)];
        const wb = gen.country.water[Math.floor(b.y) * gen.size + Math.floor(b.x)];
        if ((wa === WATER_OCEAN || wa === WATER_LAKE) && (wb === WATER_OCEAN || wb === WATER_LAKE)) continue;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        if (pass === 0) {
          // крайбрежна растителност (по-тъмна, влажна трева)
          g.lineWidth = w + 1.6;
          g.strokeStyle = 'rgba(52,96,40,0.28)';
        } else if (pass === 1) {
          // бряг: чакъл и пясък
          g.lineWidth = w + 0.42;
          g.strokeStyle = rgb(C.bank, 1, 0.92);
        } else if (pass === 2) {
          // плитка вода до бреговете
          g.lineWidth = w;
          g.strokeStyle = rgb(mixc(C.river, 0x7fb9c9, 0.35));
        } else if (pass === 3) {
          g.lineWidth = w * 0.7;
          g.strokeStyle = rgb(C.river);
        } else if (pass === 4) {
          g.lineWidth = w * 0.38;
          g.strokeStyle = rgb(C.riverDeep, 1, 0.85);
        } else {
          // течение – светли прекъснати линии
          if (w < 0.7) continue;
          g.lineWidth = 0.04;
          g.strokeStyle = 'rgba(225,242,250,0.4)';
          g.setLineDash([0.35, 0.8]);
        }
        g.stroke();
        g.setLineDash([]);
      }
    }
  }
}

// ------------------------------------------------------------------ градски пътища (плочки)
const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
interface TileRoadStyle {
  outer: number;
  outerColor: number;
  width: number;
  color: number;
  sidewalk: boolean;
}
/** Стил на плочка път: с тротоари (светли плочки и бордюр) или с банкет/аварийна лента. */
function roadStyle(t: Extract<TileState, { t: 'road' }>): TileRoadStyle {
  const g = ROAD_GEOM[t.c ?? 'street'];
  const sw = hasSidewalk(t);
  return { outer: sw ? g.sidewalkOuter : g.vergeOuter, outerColor: sw ? C.sidewalk : g.vergeColor, width: g.width, color: g.asphalt, sidewalk: sw };
}

interface RoadTile {
  x: number;
  y: number;
  t: Extract<TileState, { t: 'road' }>;
  arms: boolean[];
  n: number;
}

function roadPath(g: Ctx, r: RoadTile) {
  const cx = r.x + 0.5;
  const cy = r.y + 0.5;
  g.beginPath();
  const a = r.arms;
  const idx = a.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (r.n === 2 && (idx[1] - idx[0]) % 2 === 1 && !r.t.j) {
    // плавен завой
    const [d0, d1] = [DIRS[idx[0]], DIRS[idx[1]]];
    g.moveTo(cx + d0[0] * 0.5, cy + d0[1] * 0.5);
    g.quadraticCurveTo(cx, cy, cx + d1[0] * 0.5, cy + d1[1] * 0.5);
    return 'curve';
  }
  if (r.n === 0) {
    g.moveTo(cx - 0.01, cy);
    g.lineTo(cx + 0.01, cy);
    return 'dot';
  }
  for (const i of idx) {
    g.moveTo(cx, cy);
    g.lineTo(cx + DIRS[i][0] * 0.5, cy + DIRS[i][1] * 0.5);
  }
  return r.n === 1 ? 'end' : r.n === 2 ? 'straight' : 'junction';
}

function paintTileRoads(g: Ctx, roads: RoadTile[], detail: number) {
  // 1) тротоари / банкети, 2) фуги на плочките, 3) бордюр, 4) настилка, после маркировка и кръстовища
  for (const pass of [0, 1, 2, 3]) {
    if ((pass === 1 || pass === 2) && detail < 2) continue;
    for (const r of roads) {
      const st = roadStyle(r.t);
      if ((pass === 1 || pass === 2) && !st.sidewalk) continue;
      const w = pass === 0 ? st.outer : pass === 1 ? st.outer - 0.03 : pass === 2 ? st.width + 0.05 : st.width;
      const col = pass === 0 ? st.outerColor : pass === 1 ? mixc(C.sidewalk, 0x8d877a, 0.45) : pass === 2 ? C.curb : st.color;
      if (pass === 1) {
        // фуги между плочките на тротоара (пресичащи ивици)
        roadPath(g, r);
        g.lineCap = 'butt';
        g.lineWidth = w;
        g.strokeStyle = rgb(col, 1, 0.55);
        g.setLineDash([0.012, 0.11]);
        g.stroke();
        g.setLineDash([]);
        continue;
      }
      const kind = roadPath(g, r);
      g.lineCap = kind === 'end' || kind === 'dot' ? 'round' : 'butt';
      g.lineWidth = w;
      g.strokeStyle = rgb(col);
      g.stroke();
      if (kind === 'junction' || kind === 'straight') {
        g.fillStyle = rgb(col);
        g.fillRect(r.x + 0.5 - w / 2, r.y + 0.5 - w / 2, w, w);
      }
    }
  }
  if (detail < 2) return;
  g.lineCap = 'butt';
  for (const r of roads) {
    const cls = r.t.c ?? 'street';
    const st = roadStyle(r.t);
    const cx = r.x + 0.5;
    const cy = r.y + 0.5;
    if (r.n === 2 && !r.t.j) {
      const kind = roadPath(g, r);
      if (cls === 'avenue' || cls === 'highway') {
        // разделителна ивица + ленти
        g.lineWidth = cls === 'avenue' ? 0.08 : 0.06;
        g.strokeStyle = rgb(cls === 'avenue' ? C.median : 0xd8d8d2);
        g.stroke();
        if (kind === 'straight') {
          const horiz = r.arms[0] || r.arms[2];
          for (const s of [-1, 1]) {
            g.beginPath();
            if (horiz) {
              g.moveTo(r.x, cy + s * st.width * 0.26);
              g.lineTo(r.x + 1, cy + s * st.width * 0.26);
            } else {
              g.moveTo(cx + s * st.width * 0.26, r.y);
              g.lineTo(cx + s * st.width * 0.26, r.y + 1);
            }
            g.lineWidth = 0.025;
            g.strokeStyle = rgb(C.marking, 1, 0.85);
            g.setLineDash([0.18, 0.16]);
            g.stroke();
            g.setLineDash([]);
          }
        }
      } else if (cls !== 'rural') {
        g.lineWidth = 0.025;
        g.strokeStyle = rgb(cls === 'industrial' ? C.markingYellow : C.marking, 1, 0.8);
        g.setLineDash([0.16, 0.14]);
        g.stroke();
        g.setLineDash([]);
      }
    }
    if (r.n >= 3 && !r.t.j && cls !== 'rural') zebra(g, r, st.width, 0.36);
    if (r.t.j === 'signals') {
      zebra(g, r, st.width, 0.4);
      // стоп линии
      for (let i = 0; i < 4; i++) {
        if (!r.arms[i]) continue;
        const [dx, dy] = DIRS[i];
        const px = cx + dx * 0.3;
        const py = cy + dy * 0.3;
        g.beginPath();
        g.moveTo(px - dy * st.width * 0.48, py + dx * st.width * 0.48);
        g.lineTo(px, py);
        g.lineWidth = 0.035;
        g.strokeStyle = rgb(C.marking);
        g.stroke();
      }
    }
  }
}

function zebra(g: Ctx, r: RoadTile, width: number, at: number) {
  const cx = r.x + 0.5;
  const cy = r.y + 0.5;
  g.lineWidth = 0.09;
  g.strokeStyle = rgb(C.marking, 1, 0.92);
  for (let i = 0; i < 4; i++) {
    if (!r.arms[i]) continue;
    const [dx, dy] = DIRS[i];
    const stripes = Math.max(3, Math.round(width / 0.11));
    g.beginPath();
    for (let s = 0; s < stripes; s++) {
      const o = -width / 2 + ((s + 0.5) * width) / stripes;
      const px = cx + dx * at - dy * o;
      const py = cy + dy * at + dx * o;
      g.moveTo(px - dx * 0.06, py - dy * 0.06);
      g.lineTo(px + dx * 0.06, py + dy * 0.06);
    }
    g.lineWidth = (width / stripes) * 0.55;
    g.stroke();
  }
}

function paintRoundabouts(g: Ctx, roads: RoadTile[], detail: number) {
  for (const r of roads) {
    if (r.t.j !== 'roundabout') continue;
    const big = r.t.c === 'avenue' || r.t.c === 'highway';
    const R = big ? 0.92 : 0.6;
    const cx = r.x + 0.5;
    const cy = r.y + 0.5;
    g.beginPath();
    g.arc(cx, cy, R + 0.12, 0, Math.PI * 2);
    g.fillStyle = rgb(C.sidewalk);
    g.fill();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = rgb(C.asphalt);
    g.fill();
    const island = big ? R - 0.42 : R - 0.3;
    g.beginPath();
    g.arc(cx, cy, island + 0.04, 0, Math.PI * 2);
    g.fillStyle = rgb(C.curb);
    g.fill();
    g.beginPath();
    g.arc(cx, cy, island, 0, Math.PI * 2);
    g.fillStyle = rgb(0x6f9c48);
    g.fill();
    if (big) {
      g.beginPath();
      g.arc(cx, cy, island * 0.45, 0, Math.PI * 2);
      g.fillStyle = rgb(0xd7cfb8);
      g.fill();
    }
    if (detail >= 2) {
      g.beginPath();
      g.arc(cx, cy, (R + island) / 2 + 0.04, 0, Math.PI * 2);
      g.lineWidth = 0.025;
      g.strokeStyle = rgb(C.marking, 1, 0.75);
      g.setLineDash([0.16, 0.14]);
      g.stroke();
      g.setLineDash([]);
      // разделителни острови на входовете
      for (let i = 0; i < 4; i++) {
        if (!r.arms[i]) continue;
        const [dx, dy] = DIRS[i];
        const px = cx + dx * (R + 0.18);
        const py = cy + dy * (R + 0.18);
        g.beginPath();
        g.moveTo(px - dx * 0.16, py - dy * 0.16);
        g.lineTo(px + dx * 0.2, py + dy * 0.2);
        g.lineWidth = 0.07;
        g.strokeStyle = rgb(C.curb);
        g.stroke();
      }
    }
  }
}

/** Пешеходни алеи: павирана пътека с бордюр, свързана със съседните алеи и тротоари. */
function paintPaths(g: Ctx, tiles: { x: number; y: number; t: TileState }[], lookup: TileLookup, detail: number) {
  const paths = tiles.filter((p) => p.t.t === 'path');
  if (!paths.length) return;
  for (const pass of [0, 1, 2]) {
    if (pass === 2 && detail < 2) continue;
    for (const { x, y } of paths) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      g.beginPath();
      let arms = 0;
      for (const [dx, dy] of DIRS) {
        if (!isWalkable(lookup(x + dx, y + dy))) continue;
        arms++;
        g.moveTo(cx, cy);
        g.lineTo(cx + dx * 0.5, cy + dy * 0.5);
      }
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const w = pass === 0 ? PATH_WIDTH + 0.05 : pass === 1 ? PATH_WIDTH : PATH_WIDTH - 0.02;
      g.lineWidth = w;
      const col = pass === 0 ? rgb(0xb7ad97) : pass === 1 ? rgb(0xdcd2bd) : 'rgba(150,138,115,0.55)';
      g.strokeStyle = col;
      if (pass === 2) g.setLineDash([0.012, 0.075]);
      if (arms) g.stroke();
      g.setLineDash([]);
      if (pass < 2) {
        g.beginPath();
        g.arc(cx, cy, (arms ? w : w * 1.3) / 2, 0, Math.PI * 2);
        g.fillStyle = col;
        g.fill();
      }
    }
  }
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
}

// ------------------------------------------------------------------ земя на градовете
function paintLots(g: Ctx, tiles: { x: number; y: number; t: TileState }[], zoning: boolean) {
  for (const { x, y, t } of tiles) {
    if (t.t === 'road') continue;
    let col: number | null = null;
    if (t.t === 'path') {
      g.fillStyle = rgb(C.lawn);
      g.fillRect(x, y, 1, 1);
      continue;
    }
    if (t.t === 'zone') {
      if (t.lvl === 0) {
        col = t.prog > 0 ? 0xb59a72 : 0xa7c47c;
      } else col = t.z === 'R' ? C.lawn : t.z === 'C' || t.z === 'O' ? C.paving : t.z === 'H' ? 0x9fc27a : t.z === 'A' ? null : C.concrete;
    } else if (t.t === 'service') col = t.s === 'park' ? 0x7fae55 : C.paving;
    else col = C.concrete;
    if (col !== null) {
      g.fillStyle = rgb(col);
      g.fillRect(x, y, 1, 1);
    }
    if (t.t === 'zone' && (t.lvl === 0 || zoning)) {
      const zc = ZONES[t.z].color;
      g.fillStyle = rgb(zc, 1, zoning ? 0.45 : 0.18);
      g.fillRect(x + 0.04, y + 0.04, 0.92, 0.92);
      g.strokeStyle = rgb(zc, 1, zoning ? 0.9 : 0.55);
      g.lineWidth = 0.04;
      g.setLineDash([0.12, 0.08]);
      g.strokeRect(x + 0.06, y + 0.06, 0.88, 0.88);
      g.setLineDash([]);
    }
  }
}

// ------------------------------------------------------------------ обекти
interface Obj {
  d: number;
  wx: number;
  wy: number;
  key?: BuildingKey;
  draw?: (g: Ctx, px: number, py: number) => void;
}

/** Къде на плочката има улична лампа (по тротоар на прав участък или до алея). Използва се и за нощното осветление. */
export function lampAt(x: number, y: number, t: TileState, lookup: TileLookup): { wx: number; wy: number; arm: number } | null {
  if (t.t === 'path') return h01(x, y, 17) < 0.3 ? { wx: x + 0.82, wy: y + 0.18, arm: 1 } : null;
  if (t.t !== 'road' || t.j || !hasSidewalk(t) || h01(x, y, 15) >= 0.55) return null;
  const horiz = lookup(x + 1, y)?.t === 'road' && lookup(x - 1, y)?.t === 'road';
  const vert = lookup(x, y + 1)?.t === 'road' && lookup(x, y - 1)?.t === 'road';
  if (horiz === vert) return null;
  const geo = ROAD_GEOM[t.c ?? 'street'];
  const off = (geo.width / 2 + 0.035) * (h01(x, y, 16) < 0.5 ? -1 : 1);
  return { wx: horiz ? x + 0.5 : x + 0.5 + off, wy: horiz ? y + 0.5 + off : y + 0.5, arm: (horiz ? -1 : 1) * (off < 0 ? -1 : 1) };
}

/** Сезонен слой върху земята: сняг през зимата (по-дебел по планините), есенни тонове, свежа пролетна трева. */
function paintSeasonGround(g: Ctx, gen: WorldGenerator, lookup: TileLookup, x0: number, y0: number, season: Season | undefined) {
  if (!season || season === 'summer') return;
  const N = gen.size;
  const c = gen.country;
  for (let y = y0 - 1; y < y0 + CHUNK + 1; y++)
    for (let x = x0 - 1; x < x0 + CHUNK + 1; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const k = y * N + x;
      if (c.water[k]) continue;
      const t = lookup(x, y);
      if (t?.t === 'road') continue;
      const h = c.height[k];
      if (season === 'winter') {
        const a = Math.min(0.85, 0.55 + Math.max(0, h - 0.35) * 0.9 + (h01(x, y, 61) - 0.5) * 0.12);
        g.fillStyle = `rgba(243,246,250,${a.toFixed(3)})`;
      } else if (season === 'autumn') g.fillStyle = `rgba(176,128,58,${(0.14 + h01(x, y, 62) * 0.08).toFixed(3)})`;
      else g.fillStyle = 'rgba(120,190,70,0.08)';
      g.fillRect(x - 0.02, y - 0.02, 1.04, 1.04);
    }
}

/** Мост ли е пътната плочка (над река или езеро). */
export function isBridge(gen: WorldGenerator, x: number, y: number) {
  const t = gen.terrain[y * gen.size + x] as Terrain;
  return t === Terrain.River || t === Terrain.Water;
}

/** Тунел: плочка път в планина. 'inside' – скрита в планината, 'portal' – вход (до път извън планината). */
export function tunnelKind(gen: WorldGenerator, lookup: TileLookup, x: number, y: number): 'inside' | 'portal' | null {
  if (lookup(x, y)?.t !== 'road') return null;
  const isM = (a: number, b: number) => gen.terrain[b * gen.size + a] === Terrain.Mountains;
  if (!isM(x, y)) return null;
  let arms = 0;
  for (const [dx, dy] of DIRS) {
    if (lookup(x + dx, y + dy)?.t !== 'road') continue;
    arms++;
    if (!isM(x + dx, y + dy)) return 'portal';
  }
  return arms ? 'inside' : null;
}

/** Сянка на моста върху водата (преди настилката). */
function paintBridgeShadows(g: Ctx, gen: WorldGenerator, roads: RoadTile[]) {
  for (const r of roads) {
    if (!isBridge(gen, r.x, r.y)) continue;
    const st = roadStyle(r.t);
    g.save();
    g.translate(0.14, 0.14);
    roadPath(g, r);
    g.lineCap = 'butt';
    g.lineWidth = st.width + 0.14;
    g.strokeStyle = 'rgba(8,22,40,0.35)';
    g.stroke();
    g.restore();
  }
}

/** Парапети и колони на мостовете; тунелите – планината отново покрива пътя. */
function paintBridgesTunnels(g: Ctx, gen: WorldGenerator, roads: RoadTile[], lookup: TileLookup, detail: number) {
  for (const r of roads) {
    if (isBridge(gen, r.x, r.y)) {
      const st = roadStyle(r.t);
      const cx = r.x + 0.5;
      const cy = r.y + 0.5;
      // бетонни ръбове на плочата на моста
      g.lineCap = 'butt';
      roadPath(g, r);
      g.lineWidth = st.width + 0.16;
      g.strokeStyle = rgb(0xb9b5ac);
      g.globalCompositeOperation = 'destination-over';
      g.stroke();
      g.globalCompositeOperation = 'source-over';
      for (let i = 0; i < 4; i++) {
        if (!r.arms[i] && r.n > 0) continue;
        const [dx, dy] = DIRS[i];
        for (const side of [-1, 1]) {
          const o = (st.width / 2 + 0.05) * side;
          g.beginPath();
          g.moveTo(cx - dy * o, cy + dx * o);
          g.lineTo(cx + dx * 0.5 - dy * o, cy + dy * 0.5 + dx * o);
          g.lineWidth = 0.05;
          g.strokeStyle = rgb(0xd9d6cf);
          g.stroke();
          if (detail >= 2) {
            // колони на парапета
            for (let k = 0; k <= 3; k++) {
              const f = k / 6;
              g.fillStyle = rgb(0x8f8b83);
              g.fillRect(cx + dx * f - dy * o - 0.025, cy + dy * f + dx * o - 0.025, 0.05, 0.05);
            }
          }
        }
      }
      continue;
    }
    const tk = tunnelKind(gen, lookup, r.x, r.y);
    if (tk === 'inside') {
      // планината над тунела
      g.save();
      g.beginPath();
      g.rect(r.x - 0.02, r.y - 0.02, 1.04, 1.04);
      g.clip();
      paintTerrain(g, gen, r.x, r.y, 1, detail >= 2 ? 4 : 2);
      g.restore();
    }
  }
}

/** Улична лампа: тънък стълб с рамо и светеща глава. side – накъде е рамото на екрана. */
function streetLamp(g: Ctx, px: number, py: number, res: number, side: number) {
  const s = res;
  g.fillStyle = 'rgba(10,14,20,0.25)';
  g.beginPath();
  g.ellipse(px + 2 * s, py + 0.5 * s, 2.4 * s, 0.9 * s, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#3b4046';
  g.lineWidth = 0.9 * s;
  g.beginPath();
  g.moveTo(px, py);
  g.lineTo(px, py - 15 * s);
  g.quadraticCurveTo(px, py - 17 * s, px + side * 3.2 * s, py - 16.6 * s);
  g.stroke();
  g.fillStyle = '#fff1c4';
  g.beginPath();
  g.ellipse(px + side * 3.4 * s, py - 16.2 * s, 1.4 * s, 0.7 * s, 0, 0, Math.PI * 2);
  g.fill();
}

/** Автобусна спирка: стъклен навес с покрив и синя табела. */
function busShelter(g: Ctx, px: number, py: number, res: number, horiz: boolean) {
  const s = res;
  const dx = horiz ? 1 : -1;
  g.fillStyle = 'rgba(10,14,20,0.25)';
  g.beginPath();
  g.ellipse(px + 2 * s, py + 1 * s, 7 * s, 2.4 * s, 0, 0, Math.PI * 2);
  g.fill();
  // стъкло
  g.fillStyle = 'rgba(170,205,230,0.55)';
  g.beginPath();
  g.moveTo(px - 6 * s * dx, py - 3 * s);
  g.lineTo(px + 6 * s * dx, py + 3 * s);
  g.lineTo(px + 6 * s * dx, py - 7 * s);
  g.lineTo(px - 6 * s * dx, py - 13 * s);
  g.closePath();
  g.fill();
  g.strokeStyle = '#3b4046';
  g.lineWidth = 0.8 * s;
  g.stroke();
  // покрив
  g.fillStyle = '#2b5f8f';
  g.beginPath();
  g.moveTo(px - 7 * s * dx, py - 13.5 * s);
  g.lineTo(px + 7 * s * dx, py - 6.5 * s);
  g.lineTo(px + 7 * s * dx + 2 * s, py - 7.5 * s);
  g.lineTo(px - 7 * s * dx + 2 * s, py - 14.5 * s);
  g.closePath();
  g.fill();
  // табела
  g.strokeStyle = '#3b4046';
  g.beginPath();
  g.moveTo(px + 8 * s * dx, py + 4 * s);
  g.lineTo(px + 8 * s * dx, py - 14 * s);
  g.stroke();
  g.fillStyle = '#1f6fb2';
  g.beginPath();
  g.arc(px + 8 * s * dx, py - 15 * s, 2.6 * s, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${3.4 * s}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('A', px + 8 * s * dx, py - 13.8 * s);
}

/** Дървена пейка. */
function bench(g: Ctx, px: number, py: number, res: number) {
  const s = res;
  g.fillStyle = 'rgba(10,14,20,0.25)';
  g.fillRect(px - 3 * s, py - 0.2 * s, 7 * s, 1.4 * s);
  g.fillStyle = '#7b5536';
  g.beginPath();
  g.moveTo(px - 3.5 * s, py - 2.2 * s);
  g.lineTo(px + 1 * s, py - 4.4 * s);
  g.lineTo(px + 3.2 * s, py - 3.3 * s);
  g.lineTo(px - 1.3 * s, py - 1.1 * s);
  g.closePath();
  g.fill();
  g.fillStyle = '#986a43';
  g.beginPath();
  g.moveTo(px - 3.5 * s, py - 2.2 * s);
  g.lineTo(px + 1 * s, py - 4.4 * s);
  g.lineTo(px + 1 * s, py - 6.4 * s);
  g.lineTo(px - 3.5 * s, py - 4.2 * s);
  g.closePath();
  g.fill();
  g.strokeStyle = '#2f3337';
  g.lineWidth = 0.6 * s;
  g.beginPath();
  g.moveTo(px - 2.8 * s, py - 1.9 * s);
  g.lineTo(px - 2.8 * s, py - 0.2 * s);
  g.moveTo(px + 2.4 * s, py - 3.4 * s);
  g.lineTo(px + 2.4 * s, py - 1.8 * s);
  g.stroke();
}

function treeKind(gen: WorldGenerator, x: number, y: number, s: number): TreeKind {
  const k = y * gen.size + x;
  const h = gen.country.height[k];
  if (h > 0.66) return s < 0.5 ? 'conifer' : 'pine';
  if (h > HILLS) return s < 0.45 ? 'conifer' : s < 0.8 ? 'oak' : 'birch';
  const nearRiver =
    gen.country.water[Math.min(gen.size * gen.size - 1, k + 1)] === WATER_RIVER ||
    gen.country.water[Math.max(0, k - 1)] === WATER_RIVER ||
    gen.country.water[Math.min(gen.size * gen.size - 1, k + gen.size)] === WATER_RIVER;
  if (nearRiver) return s < 0.5 ? 'willow' : 'poplar';
  return s < 0.6 ? 'oak' : s < 0.8 ? 'birch' : s < 0.9 ? 'poplar' : 'bush';
}

function collectObjects(gen: WorldGenerator, lookup: TileLookup, x0: number, y0: number, opts: PaintOptions): Obj[] {
  const out: Obj[] = [];
  const sink: { push: (o: CityActor) => void } = opts.actors ?? out;
  const N = gen.size;
  const c = gen.country;
  const mid = opts.detail < 2;
  for (let y = y0; y < y0 + CHUNK; y++)
    for (let x = x0; x < x0 + CHUNK; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const k = y * N + x;
      const t = lookup(x, y);
      if (t) {
        const face = lookup(x, y + 1)?.t === 'road' || !(lookup(x + 1, y)?.t === 'road') ? 'left' : 'right';
        const v = Math.floor(h01(x, y, 11) * 997);
        if (t.t === 'zone') {
          if (t.lvl > 0) sink.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'zone', z: t.z, lvl: t.lvl, v: v % 13, face, ab: t.ab } });
          else if (t.prog > 0) sink.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'construction', v: v % 9 } });
        } else if (t.t === 'service') sink.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'service', s: t.s, v: v % 5, face } });
        else if (t.t === 'facility') sink.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'facility', f: t.f, v: v % 5, face } });
        else if (t.t === 'path') {
          // пейки и лампи покрай алеите
          if (!mid) {
            const hv = h01(x, y, 17);
            const lamp = lampAt(x, y, t, lookup);
            if (lamp) out.push({ d: lamp.wx + lamp.wy, wx: lamp.wx, wy: lamp.wy, draw: (g, px, py) => streetLamp(g, px, py, opts.res, lamp.arm) });
            else if (hv < 0.6) out.push({ d: x + y + 1.1, wx: x + 0.2, wy: y + 0.85, draw: (g, px, py) => bench(g, px, py, opts.res) });
          }
        } else if (t.t === 'road') {
          if (tunnelKind(gen, lookup, x, y) === 'portal') out.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'tunnel', v: v % 3, dir: 0 } });
          if (t.st && !mid) {
            const horiz = lookup(x + 1, y)?.t === 'road' || lookup(x - 1, y)?.t === 'road';
            const geo = ROAD_GEOM[t.c ?? 'street'];
            const off = geo.width / 2 + 0.09;
            const sx = horiz ? x + 0.5 : x + 0.5 + off;
            const sy = horiz ? y + 0.5 + off : y + 0.5;
            out.push({ d: sx + sy, wx: sx, wy: sy, draw: (g, px, py) => busShelter(g, px, py, opts.res, horiz) });
          }
          // улични лампи по тротоарите (на правите участъци, през плочка); светофарите са живи – traffic.ts
          const lamp = !mid ? lampAt(x, y, t, lookup) : null;
          if (lamp) out.push({ d: lamp.wx + lamp.wy, wx: lamp.wx, wy: lamp.wy, draw: (g, px, py) => streetLamp(g, px, py, opts.res, lamp.arm) });
          // дървета по тротоарите на кварталните улици (през една плочка, на другата страна от лампата)
          if (!mid && !t.j && hasSidewalk(t) && (t.c ?? 'street') === 'street' && h01(x, y, 18) < 0.55) {
            const horiz = lookup(x + 1, y)?.t === 'road' && lookup(x - 1, y)?.t === 'road';
            const vert = lookup(x, y + 1)?.t === 'road' && lookup(x, y - 1)?.t === 'road';
            if (horiz !== vert) {
              const geo = ROAD_GEOM.street;
              const side = lamp ? (h01(x, y, 16) < 0.5 ? 1 : -1) : h01(x, y, 19) < 0.5 ? -1 : 1;
              const off = (geo.width / 2 + 0.08) * side;
              const along = 0.25 + h01(x, y, 20) * 0.5;
              const tx = horiz ? x + along : x + 0.5 + off;
              const ty = horiz ? y + 0.5 + off : y + along;
              out.push({
                d: tx + ty,
                wx: tx,
                wy: ty,
                key: { k: 'tree', t: h01(x, y, 21) < 0.5 ? 'oak' : h01(x, y, 22) < 0.5 ? 'birch' : 'poplar', v: Math.floor(h01(x, y, 23) * 8), size: 0.95 },
              });
            }
          }
          // дървета в средната ивица на булевардите
          if (t.c === 'avenue' && !t.j && h01(x, y, 13) < 0.6) {
            const horiz = lookup(x + 1, y)?.t === 'road' && lookup(x - 1, y)?.t === 'road';
            const vert = lookup(x, y + 1)?.t === 'road' && lookup(x, y - 1)?.t === 'road';
            if (horiz !== vert)
              out.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'tree', t: h01(x, y, 14) < 0.5 ? 'oak' : 'poplar', v: v % 7, size: 1.15 } });
          }
        }
        continue;
      }
      const w = c.water[k];
      if (w) continue;
      const f = c.forest[k];
      const h = c.height[k];
      let count = 0;
      const clearing = smoothNoise(x, y, 6, 57);
      if (opts.cleared?.(x, y)) count = h01(x, y, 27) < 0.08 ? 1 : 0;
      else if (f > 0.5) count = clearing < 0.24 ? (h01(x, y, 28) < 0.25 ? 1 : 0) : clearing < 0.32 ? (mid ? 1 : 2) : mid ? 2 : 4;
      else if (f > 0.3) count = h01(x, y, 23) < f * 1.6 ? (h01(x, y, 26) < 0.5 ? 2 : 1) : 0;
      else if (h > MOUNTAINS) count = 0;
      else count = h01(x, y, 25) < 0.06 + f * 0.3 ? 1 : 0;
      // горски пояс: над него – редки дървета, после само скали и сняг
      if (h > 0.8) count = 0;
      else if (h > 0.74) count = Math.min(count, h01(x, y, 29) < 0.3 ? 1 : 0);
      // покрай реките – върби и тополи
      let riverside = false;
      if (!opts.cleared?.(x, y))
        for (const [dx, dy] of DIRS)
          if (c.water[(y + dy) * N + (x + dx)] === WATER_RIVER) {
            riverside = true;
            break;
          }
      if (riverside && count < 2 && h01(x, y, 30) < 0.6) count = Math.max(count, 1);
      for (let i = 0; i < count; i++) {
        const fx = (i % 2) * 0.5 + 0.08 + h01(x, y, i, 31) * 0.36;
        const fy = (Math.floor(i / 2) % 2) * 0.5 + 0.08 + h01(x, y, i, 32) * 0.36 + (count === 1 ? 0.2 : 0);
        const s = h01(x, y, i, 33);
        out.push({
          d: x + fx + y + fy,
          wx: x + fx,
          wy: y + fy,
          key: {
            k: 'tree',
            t: riverside && i === 0 ? (h01(x, y, 31) < 0.6 ? 'willow' : 'poplar') : treeKind(gen, x, y, s),
            v: Math.floor(h01(x, y, i, 34) * 8),
            // по-високо – по-ниски дървета
            size: (1.8 + (Math.floor(h01(x, y, i, 35) * 4) / 4) * 0.9) * (h > 0.7 ? 0.8 : 1),
          },
        });
      }
      if (h > MOUNTAINS - 0.02 && h01(x, y, 40) < 0.25)
        out.push({ d: x + y + 1, wx: x + 0.5, wy: y + 0.5, key: { k: 'rock', v: Math.floor(h01(x, y, 41) * 5) } });
    }
  out.sort((a, b) => a.d - b.d || a.wx - b.wx);
  if (opts.season && opts.season !== 'summer') {
    for (const o of out) if (o.key) o.key = { ...o.key, sn: opts.season };
    for (const a of opts.actors ?? []) a.key = { ...a.key, sn: opts.season };
  }
  return out;
}

// ------------------------------------------------------------------ сглобяване
export interface ChunkCanvas {
  canvas: HTMLCanvasElement;
  /** Екранна позиция (при мащаб 1) на горния ляв ъгъл на платното. */
  sx: number;
  sy: number;
  res: number;
}

export const paintStats = { chunks: 0, ms: 0, ground: 0, objects: 0 };

export function paintChunk(gen: WorldGenerator, lookup: TileLookup, cx: number, cy: number, opts: PaintOptions): ChunkCanvas {
  const tStart = performance.now();
  const res = opts.res;
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  const S0x = (x0 - y0) * 32 - CHUNK * 32;
  const S0y = (x0 + y0) * 16 - TOP_MARGIN;
  const canvas = newCanvas();
  canvas.width = Math.ceil(CHUNK * 64 * res);
  canvas.height = Math.ceil((CHUNK * 32 + TOP_MARGIN + 8) * res);
  const g = canvas.getContext('2d')!;
  const world = () => g.setTransform(32 * res, 16 * res, -32 * res, 16 * res, -S0x * res, -S0y * res);
  const toPx = (wx: number, wy: number): [number, number] => [((wx - wy) * 32 - S0x) * res, ((wx + wy) * 16 - S0y) * res];

  // ---- земя (изрязана до ромба на чанка) ----
  g.save();
  world();
  g.beginPath();
  g.rect(x0, y0, CHUNK, CHUNK);
  g.clip();
  paintTerrain(g, gen, x0, y0, CHUNK, opts.detail >= 2 ? 4 : 2);
  // фина текстура (само отблизо)
  if (opts.detail >= 2) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    const pat = grainPattern(g);
    if (pat) {
      g.globalAlpha = 0.05;
      g.fillStyle = pat;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.restore();
  }
  const M = 2;
  paintRivers(g, gen, x0, y0, x0 + CHUNK, y0 + CHUNK);

  // плочки на градовете на играчите в обхвата
  const tiles: { x: number; y: number; t: TileState }[] = [];
  for (let y = y0 - M; y < y0 + CHUNK + M; y++)
    for (let x = x0 - M; x < x0 + CHUNK + M; x++) {
      const t = lookup(x, y);
      if (t) tiles.push({ x, y, t });
    }
  paintLots(g, tiles, opts.zoning);
  paintPaths(g, tiles, lookup, opts.detail);
  const roads: RoadTile[] = [];
  for (const { x, y, t } of tiles) {
    if (t.t !== 'road') continue;
    const arms = DIRS.map(([dx, dy]) => lookup(x + dx, y + dy)?.t === 'road');
    roads.push({ x, y, t, arms, n: arms.filter(Boolean).length });
  }
  paintSeasonGround(g, gen, lookup, x0, y0, opts.season);
  paintBridgeShadows(g, gen, roads);
  paintTileRoads(g, roads, opts.detail);
  paintRoundabouts(g, roads, opts.detail);
  paintBridgesTunnels(g, gen, roads, lookup, opts.detail);
  g.restore();

  // ---- обемни обекти, сортирани по дълбочина ----
  const tGround = performance.now();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const objs = collectObjects(gen, lookup, x0, y0, opts);
  for (const o of objs) {
    const [px, py] = toPx(o.wx, o.wy);
    if (o.draw) o.draw(g, px, py);
    else if (o.key) {
      const sp = getSprite(o.key, res);
      g.drawImage(sp.canvas, Math.round(px - sp.ax), Math.round(py - sp.ay));
    }
  }
  void FLOOR;
  const tEnd = performance.now();
  paintStats.chunks++;
  paintStats.ms += tEnd - tStart;
  paintStats.ground += tGround - tStart;
  paintStats.objects += tEnd - tGround;
  return { canvas, sx: S0x, sy: S0y, res };
}

// ------------------------------------------------------------------ далечен изглед на държавата
export function paintCountry(gen: WorldGenerator, res: number): ChunkCanvas {
  const N = gen.size;
  const S0x = -N * 32;
  const S0y = -40;
  const canvas = newCanvas();
  canvas.width = Math.ceil(N * 64 * res);
  canvas.height = Math.ceil((N * 32 + 80) * res);
  const g = canvas.getContext('2d')!;
  g.fillStyle = rgb(C.deep);
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.setTransform(32 * res, 16 * res, -32 * res, 16 * res, -S0x * res, -S0y * res);
  // терен с 2 проби на плочка
  const S = 2;
  const img = newCanvas();
  img.width = N * S;
  img.height = N * S;
  const ig = img.getContext('2d')!;
  const data = ig.createImageData(N * S, N * S);
  const sample = sampler(gen);
  const out = [0, 0, 0];
  for (let j = 0; j < N * S; j++)
    for (let i = 0; i < N * S; i++) {
      const wx = (i + 0.5) / S;
      const wy = (j + 0.5) / S;
      sample(wx, wy, out);
      const k = Math.floor(wy) * N + Math.floor(wx);
      let f = 1;
      if (gen.country.forest[k] > 0.5 && !gen.country.water[k]) f = 0.78 + h01(i, j) * 0.12; // горски масив
      const o = (j * N * S + i) * 4;
      data.data[o] = out[0] * f;
      data.data[o + 1] = out[1] * f;
      data.data[o + 2] = out[2] * f;
      data.data[o + 3] = 255;
    }
  ig.putImageData(data, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(img, 0, 0, N, N);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const r of gen.rivers)
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineWidth = Math.max(1.1, (a.w + b.w) / 2);
      g.strokeStyle = rgb(C.river);
      g.stroke();
    }
  return { canvas, sx: S0x, sy: S0y, res };
}
