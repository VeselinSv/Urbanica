/**
 * Процедурна библиотека от изометрични спрайтове (сгради, дървета, съоръжения).
 * Всичко се рисува с Canvas 2D в собствена геометрия (без външни ресурси): фасади с прозорци и врати,
 * покриви (двускатни, четирискатни, плоски с парапет, шедови), балкони, комини, сенки.
 * Спрайтовете се кешират по ключ + резолюция и се „печатат“ в текстурите на чанковете.
 */

import { newCanvas } from './canvas';

export const TW = 64;
export const TH = 32;
/** Височина на един етаж в пиксели при мащаб 1. */
export const FLOOR = 11;

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Пиксел в платното, който съответства на центъра на плочката. */
  ax: number;
  ay: number;
}

type Ctx = CanvasRenderingContext2D;
type P3 = (u: number, v: number, h: number) => [number, number];

// ------------------------------------------------------------------ цветове
export function rgb(c: number, f = 1, a = 1): string {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}
export function mixc(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
/** Детерминистичен хеш 0..1 за избор на варианти. */
export function h01(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 100000) / 100000;
}
function pick<T>(arr: T[], t: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
}

// Светлина: слънце горе-вляво. Лявата стена (+v, към долу-ляво) е огряна, дясната (+u) е в сянка.
const LIT = { top: 1.06, left: 0.94, right: 0.68 };

const WALLS = [0xf2ead8, 0xe8dcc2, 0xf4f1ea, 0xdcc9a8, 0xe9d3b0, 0xcfc6b8, 0xf0e2c8, 0xd8b99a, 0xe6e1d6, 0xc9b49a, 0xe7d7c1, 0xd6cfc4];
const BRICK = [0xa65b3f, 0xb36a48, 0x8f4e3a, 0xa8705a];
const ROOF_TILES = [0xa9472f, 0x9b3e2c, 0x7a3b2e, 0x5f5a57, 0x6b4a3a, 0x8c5a3c, 0x4e4d52, 0xb0533a];
const MODERN = [0xd9dde2, 0xc7ccd3, 0xb9c0c8, 0xe5e2dc, 0xa9b0b8, 0xd0c8bc];
const GLASS = [0x6f93b3, 0x5d86a8, 0x7fa3bf, 0x5a7d96, 0x6b8fa0, 0x88a9b9];

// ------------------------------------------------------------------ платно
function makeSprite(r: number, maxH: number, draw: (g: Ctx, P: P3, r: number) => void): Sprite {
  const W = Math.ceil(150 * r);
  const H = Math.ceil((44 + maxH) * r);
  const canvas = newCanvas();
  canvas.width = Math.max(2, W);
  canvas.height = Math.max(2, H);
  const g = canvas.getContext('2d')!;
  const ax = 46 * r;
  const ay = H - 22 * r;
  const P: P3 = (u, v, h) => [ax + (u - v) * (TW / 2) * r, ay + (u + v) * (TH / 2) * r - h * r];
  g.lineJoin = 'round';
  draw(g, P, r);
  return { canvas, ax, ay };
}

type Fill = string | CanvasGradient | CanvasPattern;
function poly(g: Ctx, pts: (readonly [number, number])[], fill: Fill, stroke?: string, lw = 1) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.stroke();
  }
}

function line(g: Ctx, a: readonly [number, number], b: readonly [number, number], color: string, w: number) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.strokeStyle = color;
  g.lineWidth = w;
  g.stroke();
}

const canBlur = (() => {
  try {
    const c = newCanvas().getContext('2d');
    return !!c && 'filter' in c;
  } catch {
    return false;
  }
})();

/** Мека сянка на обем върху терена (хвърля се към долу-дясно на екрана = посока +u). */
function shadow(g: Ctx, P: P3, u0: number, v0: number, u1: number, v1: number, h: number, alpha = 0.3) {
  const L = Math.min(1.4, 0.1 + h / 55);
  const pts = [P(u0, v0, 0), P(u1 + L, v0 + L * 0.15, 0), P(u1 + L, v1 + L * 0.15, 0), P(u0 + L * 0.3, v1, 0), P(u0, v1, 0)];
  g.save();
  if (canBlur) g.filter = 'blur(1.6px)';
  poly(g, pts, `rgba(18,28,22,${alpha})`);
  g.restore();
  // плътен контакт в основата (ambient occlusion по земята)
  poly(g, [P(u0 - 0.02, v0 - 0.02, 0), P(u1 + 0.05, v0 - 0.02, 0), P(u1 + 0.05, v1 + 0.05, 0), P(u0 - 0.02, v1 + 0.05, 0)], 'rgba(10,16,12,0.22)');
}

/** Стена с вертикален градиент: по-тъмна долу (засенчване от земята), по-светла горе. */
function wall(g: Ctx, pts: (readonly [number, number])[], color: number, f: number) {
  const yb = Math.max(pts[0][1], pts[1][1]);
  const yt = Math.min(pts[2][1], pts[3][1]);
  const hgt = Math.max(1, yb - yt);
  const gr = g.createLinearGradient(0, yb, 0, yt);
  gr.addColorStop(0, rgb(color, f * 0.74));
  gr.addColorStop(Math.min(0.45, 7 / hgt), rgb(color, f * 0.95));
  gr.addColorStop(1, rgb(color, f * 1.05));
  poly(g, pts, gr);
}

interface BoxStyle {
  wall: number;
  top?: number;
  edge?: boolean;
}
function box(g: Ctx, P: P3, u0: number, v0: number, u1: number, v1: number, z0: number, z1: number, s: BoxStyle) {
  const top = s.top ?? s.wall;
  wall(g, [P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1)], s.wall, LIT.right);
  wall(g, [P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1)], s.wall, LIT.left);
  const tp = [P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)];
  const tg = g.createLinearGradient(tp[0][0], tp[0][1], tp[2][0], tp[2][1]);
  tg.addColorStop(0, rgb(top, LIT.top * 1.03));
  tg.addColorStop(1, rgb(top, LIT.top * 0.94));
  poly(g, tp, tg);
  if (s.edge !== false) {
    // тъмен преден ъгъл и светли горни ръбове (обем)
    line(g, P(u1, v1, z0), P(u1, v1, z1), 'rgba(0,0,0,0.22)', 0.6);
    line(g, P(u0, v1, z1), P(u1, v1, z1), 'rgba(255,255,255,0.3)', 0.6);
    line(g, P(u1, v1, z1), P(u1, v0, z1), 'rgba(255,255,255,0.14)', 0.5);
  }
}

type Face = 'left' | 'right';
/** Точка върху стена: s по дължина 0..1, z височина в px. */
function facePt(P: P3, face: Face, u0: number, v0: number, u1: number, v1: number, s: number, z: number) {
  return face === 'right' ? P(u1, v0 + (v1 - v0) * s, z) : P(u0 + (u1 - u0) * s, v1, z);
}
function faceQuad(g: Ctx, P: P3, face: Face, b: [number, number, number, number], s0: number, s1: number, z0: number, z1: number, fill: Fill) {
  const [u0, v0, u1, v1] = b;
  poly(
    g,
    [
      facePt(P, face, u0, v0, u1, v1, s0, z0),
      facePt(P, face, u0, v0, u1, v1, s1, z0),
      facePt(P, face, u0, v0, u1, v1, s1, z1),
      facePt(P, face, u0, v0, u1, v1, s0, z1),
    ],
    fill,
  );
}
/** Вертикален градиент за квадрат върху стена (z0 долу → z1 горе). */
function faceGrad(g: Ctx, P: P3, face: Face, b: [number, number, number, number], s: number, z0: number, z1: number, c0: string, c1: string) {
  const [u0, v0, u1, v1] = b;
  const a = facePt(P, face, u0, v0, u1, v1, s, z0);
  const c = facePt(P, face, u0, v0, u1, v1, s, z1);
  const gr = g.createLinearGradient(a[0], a[1], c[0], c[1]);
  gr.addColorStop(0, c0);
  gr.addColorStop(1, c1);
  return gr;
}

interface WindowStyle {
  glass: number;
  frame?: number;
  /** Ширина на прозореца като дял от колоната. */
  w?: number;
  /** Височина като дял от етажа. */
  hgt?: number;
  /** Колони на единица дължина (плочка). */
  density?: number;
  lit?: number;
  band?: boolean;
  balcony?: number;
  seed: number;
  fromFloor?: number;
  /** Без междуетажни линии (къщи). */
  noSlabs?: boolean;
}

/** Балкон: изнесена плоча с парапет пред прозореца. */
function balcony(g: Ctx, P: P3, face: Face, b: [number, number, number, number], s0: number, s1: number, z: number, shade: number) {
  const [u0, v0, u1, v1] = b;
  const d = 0.075;
  if (face === 'left') {
    const ua = u0 + (u1 - u0) * s0;
    const ub = u0 + (u1 - u0) * s1;
    box(g, P, ua, v1, ub, v1 + d, z - 1.6, z, { wall: 0xdedad2, edge: false });
    poly(g, [P(ua, v1 + d, z), P(ub, v1 + d, z), P(ub, v1 + d, z + 4.2), P(ua, v1 + d, z + 4.2)], `rgba(150,180,200,${0.35 * shade})`);
    line(g, P(ua, v1 + d, z + 4.2), P(ub, v1 + d, z + 4.2), rgb(0x5f666c, shade), 0.7);
  } else {
    const va = v0 + (v1 - v0) * s0;
    const vb = v0 + (v1 - v0) * s1;
    box(g, P, u1, va, u1 + d, vb, z - 1.6, z, { wall: 0xdedad2, edge: false });
    poly(g, [P(u1 + d, va, z), P(u1 + d, vb, z), P(u1 + d, vb, z + 4.2), P(u1 + d, va, z + 4.2)], `rgba(120,150,170,${0.35 * shade})`);
    line(g, P(u1 + d, va, z + 4.2), P(u1 + d, vb, z + 4.2), rgb(0x5f666c, shade), 0.7);
  }
}

function windows(g: Ctx, P: P3, r: number, b: [number, number, number, number], z0: number, z1: number, ws: WindowStyle) {
  const floors = Math.max(1, Math.round((z1 - z0) / FLOOR));
  const fh = (z1 - z0) / floors;
  if (r < 0.45) {
    // далечен мащаб: само ленти, без отделни прозорци
    for (const face of ['left', 'right'] as Face[])
      for (let f = ws.fromFloor ?? 0; f < floors; f++) {
        const za = z0 + (f + 0.3) * fh;
        const zb = z0 + (f + 0.75) * fh;
        faceQuad(g, P, face, b, 0.08, 0.92, za, zb, rgb(ws.glass, face === 'left' ? 0.95 : 0.75, 0.8));
      }
    return;
  }
  const [u0, v0, u1, v1] = b;
  for (const face of ['left', 'right'] as Face[]) {
    const len = face === 'left' ? u1 - u0 : v1 - v0;
    const cols = Math.max(1, Math.round(len * (ws.density ?? 5)));
    const shade = face === 'left' ? 1 : 0.74;
    // междуетажни плочи
    if (!ws.noSlabs && floors > 1 && !ws.band)
      for (let f = 1; f < floors; f++) faceQuad(g, P, face, b, 0, 1, z0 + f * fh - 0.4, z0 + f * fh + 0.4, 'rgba(0,0,0,0.07)');
    for (let f = ws.fromFloor ?? 0; f < floors; f++) {
      const za = z0 + f * fh + fh * (1 - (ws.hgt ?? 0.55)) * 0.55;
      const zb = za + fh * (ws.hgt ?? 0.55);
      if (ws.band) {
        // стъклена фасада: отражение на небето + вертикални рамки + тъмен парапет между етажите
        faceQuad(
          g,
          P,
          face,
          b,
          0,
          1,
          z0 + f * fh,
          z0 + (f + 1) * fh,
          faceGrad(g, P, face, b, 0.5, za, zb, rgb(ws.glass, shade * 0.85), rgb(mixc(ws.glass, 0xdff1ff, 0.45), shade)),
        );
        faceQuad(g, P, face, b, 0, 1, z0 + f * fh, z0 + f * fh + 1.3, rgb(ws.glass, shade * 0.55));
        const mull = Math.max(2, Math.round(len * 9));
        for (let m = 1; m < mull; m++)
          faceQuad(g, P, face, b, m / mull - 0.004, m / mull + 0.004, z0 + f * fh, z0 + (f + 1) * fh, `rgba(220,230,240,${0.35 * shade})`);
        continue;
      }
      for (let c = 0; c < cols; c++) {
        const w = ws.w ?? 0.5;
        const s0 = (c + (1 - w) / 2) / cols;
        const s1 = (c + (1 + w) / 2) / cols;
        const hv = h01(ws.seed, f, c, face === 'left' ? 1 : 2);
        const lit = hv < (ws.lit ?? 0.12);
        // рамка (леко изнесена) и перваз
        faceQuad(g, P, face, b, s0 - 0.014, s1 + 0.014, za - 1, zb + 0.8, rgb(ws.frame ?? 0xf5f2ea, shade));
        faceQuad(g, P, face, b, s0 - 0.03, s1 + 0.03, za - 1.6, za - 0.8, rgb(0xd9d4ca, shade * 0.95));
        // стъкло: отражение на небето горе, по-тъмно долу; светнало – топла светлина
        const top = lit ? rgb(0xffe7b0, shade) : rgb(mixc(ws.glass, 0xe3f2ff, 0.5), shade);
        const bot = lit ? rgb(0xf0b860, shade * 0.9) : rgb(mixc(ws.glass, 0x1d2b38, 0.35), shade);
        faceQuad(g, P, face, b, s0, s1, za, zb, faceGrad(g, P, face, b, (s0 + s1) / 2, za, zb, bot, top));
        // сянка от горния праг
        faceQuad(g, P, face, b, s0, s1, zb - 1.1, zb, 'rgba(0,0,0,0.22)');
        // перде в част от прозорците
        if (!lit && hv > 0.62) faceQuad(g, P, face, b, s0, s0 + (s1 - s0) * 0.32, za, zb - 1.1, `rgba(235,225,205,${0.55 * shade})`);
        // средна рамка при широки прозорци
        if ((s1 - s0) * len > 0.07) faceQuad(g, P, face, b, (s0 + s1) / 2 - 0.004, (s0 + s1) / 2 + 0.004, za, zb, rgb(ws.frame ?? 0xf5f2ea, shade * 0.95));
        if (ws.balcony && f > 0 && h01(ws.seed, f, c, 7) < ws.balcony) balcony(g, P, face, b, s0 - 0.04, s1 + 0.04, za - 0.4, shade);
      }
    }
  }
}

function door(g: Ctx, P: P3, b: [number, number, number, number], face: Face, s: number, w: number, h: number, color: number) {
  const shade = face === 'left' ? 0.95 : 0.72;
  faceQuad(g, P, face, b, s - w / 2 - 0.025, s + w / 2 + 0.025, 0, h + 1.2, rgb(0xeeeae2, shade));
  faceQuad(g, P, face, b, s - w / 2, s + w / 2, 0, h, faceGrad(g, P, face, b, s, 0, h, rgb(color, shade * 0.8), rgb(color, shade * 1.1)));
  faceQuad(g, P, face, b, s - w / 2, s + w / 2, h - 1, h, 'rgba(0,0,0,0.25)');
  // дръжка и стъпало
  faceQuad(g, P, face, b, s + w * 0.25, s + w * 0.32, h * 0.45, h * 0.52, '#d8c27a');
  faceQuad(g, P, face, b, s - w / 2 - 0.04, s + w / 2 + 0.04, 0, 0.9, rgb(0xcfcac0, shade));
}

type RoofKind = 'gable' | 'hip' | 'flat' | 'sawtooth' | 'shed';

/** Плоскост на покрив с градиент по наклона и керемидени редове. */
function roofPlane(g: Ctx, pts: (readonly [number, number])[], color: number, f: number, rows: number, tiles: boolean) {
  // pts: стреха-ляво, стреха-дясно, било-дясно, било-ляво
  const eave = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  const ridge = [(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2];
  const gr = g.createLinearGradient(eave[0], eave[1], ridge[0], ridge[1]);
  gr.addColorStop(0, rgb(color, f * 0.86));
  gr.addColorStop(1, rgb(color, f * 1.1));
  poly(g, pts, gr);
  if (!tiles) return;
  g.save();
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  g.clip();
  for (let i = 1; i < rows; i++) {
    const t = i / rows;
    const a: [number, number] = [pts[0][0] + (pts[3][0] - pts[0][0]) * t, pts[0][1] + (pts[3][1] - pts[0][1]) * t];
    const c: [number, number] = [pts[1][0] + (pts[2][0] - pts[1][0]) * t, pts[1][1] + (pts[2][1] - pts[1][1]) * t];
    line(g, a, c, rgb(color, f * 0.66, 0.85), 0.55);
    line(g, [a[0], a[1] - 0.6], [c[0], c[1] - 0.6], rgb(color, f * 1.25, 0.35), 0.4);
  }
  g.restore();
}

function roof(g: Ctx, P: P3, b: [number, number, number, number], z: number, kind: RoofKind, color: number, wallC: number, rh: number, seed: number) {
  if (SEASON === 'winter') color = mixc(color, 0xf2f5f8, kind === 'flat' ? 0.7 : 0.82);
  const [u0, v0, u1, v1] = b;
  const o = 0.04; // стреха
  // сянка под стрехата върху стените
  if (kind !== 'flat') {
    faceQuad(g, P, 'left', b, 0, 1, z - 2.4, z, 'rgba(0,0,0,0.22)');
    faceQuad(g, P, 'right', b, 0, 1, z - 2.4, z, 'rgba(0,0,0,0.28)');
  }
  if (kind === 'flat') {
    poly(g, [P(u0, v0, z), P(u1, v0, z), P(u1, v1, z), P(u0, v1, z)], rgb(color, 1.05));
    const i = Math.min(0.05, (u1 - u0) * 0.1);
    // парапет с обшивка и чакъл вътре
    const inner = [P(u0 + i, v0 + i, z), P(u1 - i, v0 + i, z), P(u1 - i, v1 - i, z), P(u0 + i, v1 - i, z)];
    poly(g, inner, rgb(color, 0.82));
    for (let k = 0; k < 26; k++) {
      const pu = u0 + i + (u1 - u0 - 2 * i) * h01(seed, k, 21);
      const pv = v0 + i + (v1 - v0 - 2 * i) * h01(seed, k, 22);
      const [px, py] = P(pu, pv, z);
      g.fillStyle = h01(seed, k, 23) < 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)';
      g.fillRect(px, py, 1, 1);
    }
    line(g, P(u0, v1, z), P(u1, v1, z), 'rgba(255,255,255,0.45)', 0.7);
    line(g, P(u1, v1, z), P(u1, v0, z), 'rgba(255,255,255,0.25)', 0.6);
    // покривно оборудване: машинно помещение, климатици, понякога соларни панели
    const area = (u1 - u0) * (v1 - v0);
    if (area > 0.2 && h01(seed, 9) < 0.6) {
      const cu = u0 + (u1 - u0) * 0.3;
      const cv = v0 + (v1 - v0) * 0.3;
      box(g, P, cu - 0.08, cv - 0.07, cu + 0.08, cv + 0.07, z, z + 5, { wall: 0xc4c1ba });
    }
    const n = 1 + Math.floor(h01(seed, 3) * 3);
    for (let k = 0; k < n; k++) {
      const cu = u0 + (u1 - u0) * (0.3 + 0.5 * h01(seed, k, 4));
      const cv = v0 + (v1 - v0) * (0.3 + 0.5 * h01(seed, k, 5));
      box(g, P, cu - 0.035, cv - 0.03, cu + 0.035, cv + 0.03, z, z + 2.6, { wall: 0xb8bcc0, edge: false });
    }
    if (h01(seed, 11) < 0.35 && area > 0.12) {
      for (let k = 0; k < 3; k++) {
        const pu = u0 + (u1 - u0) * (0.55 + k * 0.12);
        poly(g, [P(pu, v0 + 0.08, z + 0.5), P(pu + 0.09, v0 + 0.08, z + 0.5), P(pu + 0.09, v1 - 0.1, z + 2.2), P(pu, v1 - 0.1, z + 2.2)], '#2a4566');
        line(g, P(pu, v0 + 0.08, z + 0.5), P(pu + 0.09, v0 + 0.08, z + 0.5), 'rgba(200,220,240,0.6)', 0.4);
      }
    }
    return;
  }
  if (kind === 'sawtooth') {
    const teeth = Math.max(2, Math.round((u1 - u0) / 0.18));
    for (let t = 0; t < teeth; t++) {
      const a = u0 + ((u1 - u0) * t) / teeth;
      const c = u0 + ((u1 - u0) * (t + 1)) / teeth;
      roofPlane(g, [P(a, v1, z), P(a, v0, z), P(c, v0, z + rh), P(c, v1, z + rh)], color, 1.0, 4, false);
      poly(g, [P(c, v0, z), P(c, v1, z), P(c, v1, z + rh), P(c, v0, z + rh)], rgb(0x9fb7c9, 0.85));
      poly(g, [P(a, v1, z), P(c, v1, z), P(c, v1, z + rh)], rgb(wallC, LIT.left));
    }
    return;
  }
  if (kind === 'shed') {
    roofPlane(g, [P(u0 - o, v1 + o, z), P(u1 + o, v1 + o, z), P(u1 + o, v0 - o, z + rh), P(u0 - o, v0 - o, z + rh)], color, 0.98, 4, false);
    poly(g, [P(u1, v0, z), P(u1, v1, z), P(u1, v0, z + rh)], rgb(wallC, LIT.right));
    return;
  }
  const tiles = true;
  const alongU = u1 - u0 >= v1 - v0;
  if (alongU) {
    const vm = (v0 + v1) / 2;
    const hip = kind === 'hip' ? Math.min((u1 - u0) * 0.3, (v1 - v0) * 0.5) : 0;
    roofPlane(g, [P(u0 - o, v0 - o, z), P(u1 + o, v0 - o, z), P(u1 - hip, vm, z + rh), P(u0 + hip, vm, z + rh)], color, 0.78, 5, tiles);
    if (kind === 'gable') wall(g, [P(u1, v0, z), P(u1, v1, z), P(u1, vm, z + rh), P(u1, vm, z + rh)], wallC, LIT.right);
    else roofPlane(g, [P(u1 + o, v0 - o, z), P(u1 + o, v1 + o, z), P(u1 - hip, vm, z + rh), P(u1 - hip, vm, z + rh)], color, 0.66, 4, tiles);
    roofPlane(g, [P(u0 - o, v1 + o, z), P(u1 + o, v1 + o, z), P(u1 - hip, vm, z + rh), P(u0 + hip, vm, z + rh)], color, 1.0, 5, tiles);
    // било и стреха
    line(g, P(u0 + hip, vm, z + rh), P(u1 - hip, vm, z + rh), rgb(color, 0.55), 1.1);
    line(g, P(u0 - o, v1 + o, z), P(u1 + o, v1 + o, z), rgb(color, 0.6), 0.8);
    if (kind === 'gable' && h01(seed, 15) < 0.35) {
      // капандура
      const du = u0 + (u1 - u0) * 0.4;
      const dv = v1 - (v1 - vm) * 0.45;
      box(g, P, du, dv, du + 0.12, dv + 0.06, z + rh * 0.35, z + rh * 0.35 + 5, { wall: wallC, edge: false });
      faceQuad(g, P, 'left', [du, dv, du + 0.12, dv + 0.06], 0.25, 0.75, z + rh * 0.35 + 1, z + rh * 0.35 + 4, '#5b7a95');
      roofPlane(
        g,
        [
          P(du - 0.01, dv + 0.07, z + rh * 0.35 + 5),
          P(du + 0.13, dv + 0.07, z + rh * 0.35 + 5),
          P(du + 0.13, dv, z + rh * 0.35 + 7.5),
          P(du - 0.01, dv, z + rh * 0.35 + 7.5),
        ],
        color,
        1,
        2,
        false,
      );
    }
  } else {
    const um = (u0 + u1) / 2;
    const hip = kind === 'hip' ? Math.min((v1 - v0) * 0.3, (u1 - u0) * 0.5) : 0;
    roofPlane(g, [P(u0 - o, v1 + o, z), P(u0 - o, v0 - o, z), P(um, v0 + hip, z + rh), P(um, v1 - hip, z + rh)], color, 0.8, 5, tiles);
    if (kind === 'gable') wall(g, [P(u0, v1, z), P(u1, v1, z), P(um, v1, z + rh), P(um, v1, z + rh)], wallC, LIT.left);
    else roofPlane(g, [P(u0 - o, v1 + o, z), P(u1 + o, v1 + o, z), P(um, v1 - hip, z + rh), P(um, v1 - hip, z + rh)], color, 0.95, 4, tiles);
    roofPlane(g, [P(u1 + o, v1 + o, z), P(u1 + o, v0 - o, z), P(um, v0 + hip, z + rh), P(um, v1 - hip, z + rh)], color, 0.7, 5, tiles);
    line(g, P(um, v0 + hip, z + rh), P(um, v1 - hip, z + rh), rgb(color, 0.55), 1.1);
  }
}

/** Светлинен отвор (стъклена призма) на плосък покрив. */
function roofPlaneSky(g: Ctx, P: P3, u0: number, v0: number, u1: number, v1: number, z: number) {
  const um = (u0 + u1) / 2;
  poly(g, [P(u0, v1, z), P(um, v1, z + 3), P(um, v0, z + 3), P(u0, v0, z)], '#9cc4dc');
  poly(g, [P(um, v1, z + 3), P(u1, v1, z), P(u1, v0, z), P(um, v0, z + 3)], '#5d86a3');
  line(g, P(um, v0, z + 3), P(um, v1, z + 3), 'rgba(255,255,255,0.7)', 0.6);
}

function chimney(g: Ctx, P: P3, u: number, v: number, z: number, h: number, color = 0x8b5e4a) {
  box(g, P, u - 0.03, v - 0.03, u + 0.03, v + 0.03, z, z + h, { wall: color, top: 0x3a3330, edge: false });
  box(g, P, u - 0.036, v - 0.036, u + 0.036, v + 0.036, z + h, z + h + 1, { wall: 0x9a9a96, top: 0x2b2a28, edge: false });
}

/** Трева според сезона: сняг през зимата, изсъхнала есента. */
function grass(c: number) {
  return SEASON === 'winter' ? mixc(c, 0xeef2f6, 0.78) : SEASON === 'autumn' ? mixc(c, 0xb08a4a, 0.25) : SEASON === 'spring' ? mixc(c, 0x8fd04f, 0.12) : c;
}

/** Двор на къща: окосена трева на ивици, цветни лехи, плочки до вратата, жив плет, понякога кола. */
function yard(g: Ctx, P: P3, r: number, seed: number, face: Face, dim: (c: number) => number) {
  const lawn = grass(dim(0x7fae54));
  poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(lawn));
  for (let i = 0; i < 6; i++) {
    const v0 = -0.48 + i * 0.16;
    poly(g, [P(-0.48, v0, 0), P(0.48, v0, 0), P(0.48, v0 + 0.08, 0), P(-0.48, v0 + 0.08, 0)], rgb(lawn, 1.07, 0.6));
  }
  // пътека до вратата
  const path =
    face === 'left'
      ? [P(-0.06, 0.2, 0), P(0.06, 0.2, 0), P(0.06, 0.48, 0), P(-0.06, 0.48, 0)]
      : [P(0.24, -0.06, 0), P(0.48, -0.06, 0), P(0.48, 0.06, 0), P(0.24, 0.06, 0)];
  poly(g, path, rgb(dim(0xcfc6b4)));
  // цветни лехи
  const flowers = [0xe8505b, 0xf2c94c, 0xf6f1e7, 0xb56be0, 0xf08a3c];
  for (let k = 0; k < 10; k++) {
    const u = -0.44 + h01(seed, k, 31) * 0.88;
    const v = (h01(seed, k, 32) < 0.5 ? -0.44 : 0.36) + h01(seed, k, 33) * 0.07;
    const [x, y] = P(u, v, 0);
    g.fillStyle = rgb(dim(0x3f6b2f));
    g.beginPath();
    g.arc(x, y - 0.8 * r, 1.6 * r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = SEASON === 'winter' ? 'rgba(245,248,252,0.9)' : rgb(dim(flowers[SEASON === 'autumn' ? 4 : k % flowers.length]));
    g.beginPath();
    g.arc(x + 0.4 * r, y - 1.4 * r, 0.8 * r, 0, Math.PI * 2);
    g.fill();
  }
  // жив плет по задните граници
  for (const [a, c] of [
    [P(-0.48, -0.48, 0), P(0.48, -0.48, 0)],
    [P(-0.48, -0.48, 0), P(-0.48, 0.48, 0)],
  ] as const) {
    line(g, [a[0], a[1] - 1.4 * r], [c[0], c[1] - 1.4 * r], rgb(dim(0x3d6a2c)), 2.6 * r);
    line(g, [a[0], a[1] - 2.2 * r], [c[0], c[1] - 2.2 * r], rgb(dim(0x5c8a3a), 1, 0.8), 1 * r);
  }
  // кола на алеята
  if (h01(seed, 41) < 0.45) carSprite(g, P, r, 0.33, 0.3, h01(seed, 42) < 0.5, pick([0xc0392b, 0xecf0f1, 0x2c3e50, 0x2471a3, 0x7f8c8d], h01(seed, 43)));
}

/** Паркинг: асфалт, бели линии и паркирани коли в зоната [u0..u1]×[v0..v1]. */
function parking(g: Ctx, P: P3, r: number, u0: number, v0: number, u1: number, v1: number, seed: number, fill = 0.6) {
  poly(g, [P(u0, v0, 0), P(u1, v0, 0), P(u1, v1, 0), P(u0, v1, 0)], rgb(0x5d6064));
  const n = Math.max(2, Math.round((u1 - u0) / 0.09));
  for (let i = 0; i <= n; i++)
    line(g, P(u0 + ((u1 - u0) * i) / n, v0, 0), P(u0 + ((u1 - u0) * i) / n, v0 + (v1 - v0) * 0.45, 0), 'rgba(255,255,255,0.7)', 0.5 * r);
  const cols = [0xc0392b, 0xecf0f1, 0x2c3e50, 0x2471a3, 0x7f8c8d, 0xf1c40f, 0x1e8449, 0xd5d8dc];
  for (let i = 0; i < n; i++)
    if (h01(seed, i, 51) < fill)
      carSprite(g, P, r, u0 + ((u1 - u0) * (i + 0.5)) / n, v0 + (v1 - v0) * 0.22, false, cols[Math.floor(h01(seed, i, 52) * cols.length)]);
}

/** Малка изометрична кола (каросерия, покрив, стъкла, сянка). */
function carSprite(g: Ctx, P: P3, r: number, cu: number, cv: number, alongU: boolean, color: number) {
  const L = 0.13;
  const W = 0.065;
  const [a0, a1, b0, b1] = alongU ? [cu - L, cu + L, cv - W, cv + W] : [cu - W, cu + W, cv - L, cv + L];
  poly(g, [P(a0 + 0.02, b0 + 0.02, 0), P(a1 + 0.04, b0 + 0.02, 0), P(a1 + 0.04, b1 + 0.03, 0), P(a0 + 0.02, b1 + 0.03, 0)], 'rgba(0,0,0,0.25)');
  box(g, P, a0, b0, a1, b1, 0.6, 3.6, { wall: color, edge: false });
  const [c0, c1, d0, d1] = alongU ? [cu - L * 0.45, cu + L * 0.35, b0 + 0.008, b1 - 0.008] : [a0 + 0.008, a1 - 0.008, cv - L * 0.45, cv + L * 0.35];
  box(g, P, c0, d0, c1, d1, 3.6, 5.6, { wall: 0x2a3a4a, top: color, edge: false });
  void r;
}

/** Гофрирана ламарина / вертикални ребра по стените на хале или склад. */
function corrugate(g: Ctx, P: P3, b: [number, number, number, number], z0: number, z1: number, r: number) {
  if (r < 0.45) return;
  for (const face of ['left', 'right'] as Face[]) {
    const len = face === 'left' ? b[2] - b[0] : b[3] - b[1];
    const n = Math.round(len * 34);
    for (let i = 1; i < n; i++) faceQuad(g, P, face, b, i / n - 0.003, i / n + 0.003, z0 + 0.5, z1 - 0.5, i % 2 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)');
  }
}

/** Цилиндър (силоз, резервоар, охладителна кула при taper > 0). */
function cylinder(g: Ctx, P: P3, r: number, u: number, v: number, rad: number, z0: number, z1: number, color: number, taper = 0) {
  const [cx, cy0] = P(u, v, z0);
  const [, cy1] = P(u, v, z1);
  const rx0 = rad * (TW / 2) * r * 1.414;
  const ry0 = rad * (TH / 2) * r * 1.414;
  const rx1 = rx0 * (1 - taper);
  const ry1 = ry0 * (1 - taper);
  const grad = g.createLinearGradient(cx - rx0, 0, cx + rx0, 0);
  grad.addColorStop(0, rgb(color, 0.95));
  grad.addColorStop(0.45, rgb(color, 1.08));
  grad.addColorStop(1, rgb(color, 0.62));
  g.beginPath();
  if (taper > 0) {
    // хиперболоиден профил
    const mid = (cy0 + cy1) / 2 + (cy0 - cy1) * 0.15;
    g.moveTo(cx - rx0, cy0);
    g.quadraticCurveTo(cx - rx1 * 0.8, mid, cx - rx1, cy1);
    g.lineTo(cx + rx1, cy1);
    g.quadraticCurveTo(cx + rx1 * 0.8, mid, cx + rx0, cy0);
  } else {
    g.moveTo(cx - rx0, cy0);
    g.lineTo(cx - rx1, cy1);
    g.lineTo(cx + rx1, cy1);
    g.lineTo(cx + rx0, cy0);
  }
  g.ellipse(cx, cy0, rx0, ry0, 0, 0, Math.PI, false);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  // хоризонтални пояси
  if (taper === 0 && cy0 - cy1 > 14 * r) {
    const n = Math.floor((cy0 - cy1) / (9 * r));
    for (let i = 1; i <= n; i++) {
      g.beginPath();
      g.ellipse(cx, cy0 - i * 9 * r, rx0, ry0, 0, 0, Math.PI, false);
      g.strokeStyle = rgb(color, 0.72, 0.8);
      g.lineWidth = 0.6;
      g.stroke();
    }
  }
  g.beginPath();
  g.ellipse(cx, cy1, rx1, ry1, 0, 0, Math.PI * 2);
  g.fillStyle = rgb(color, taper > 0 ? 0.45 : 1.12);
  g.fill();
  g.strokeStyle = rgb(color, taper > 0 ? 0.8 : 0.75);
  g.lineWidth = 0.7;
  g.stroke();
  if (taper > 0) {
    // вътрешността на охладителната кула + пара
    g.beginPath();
    g.ellipse(cx, cy1 + ry1 * 0.2, rx1 * 0.82, ry1 * 0.7, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(30,30,30,0.6)';
    g.fill();
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cx + (i - 1.5) * rx1 * 0.35, cy1 - (4 + i * 3) * r, (5 + i * 1.5) * r, 0, Math.PI * 2);
      g.fillStyle = `rgba(245,245,245,${0.55 - i * 0.1})`;
      g.fill();
    }
  }
}

// ------------------------------------------------------------------ дървета
export type TreeKind = 'oak' | 'conifer' | 'birch' | 'poplar' | 'bush' | 'willow' | 'pine';
const TREE_GREENS = [0x4f7f3a, 0x5b8a3f, 0x46713a, 0x6a9443, 0x3f6b34, 0x587d3c, 0x6f8f3e, 0x4a7a44, 0x63863a];
const CONIFER_GREENS = [0x2f5a3c, 0x2b5236, 0x355f40, 0x274a35, 0x3a6646];
const TREE_AUTUMN = [0xb5862f, 0xa45a2a, 0xc0a040, 0x9c6b2e];

/** Леко разместен оттенък за всяко дърво – гората не е еднакво зелена. */
function tint(c: number, seed: number) {
  const t = h01(seed, 77);
  return t < 0.33 ? mixc(c, 0x8fa83a, 0.12) : t < 0.66 ? mixc(c, 0x2f5f4f, 0.1) : c;
}

/** Купчина листа: тъмна долна част, огряна горна (светлина горе-вляво), отделни листа по ръба. */
function leafCluster(g: Ctx, x: number, y: number, rad: number, base: number, seed: number, r: number) {
  g.fillStyle = rgb(base, 0.55);
  g.beginPath();
  g.arc(x + rad * 0.18, y + rad * 0.22, rad * 0.95, 0, Math.PI * 2);
  g.fill();
  const gr = g.createRadialGradient(x - rad * 0.45, y - rad * 0.5, rad * 0.1, x, y, rad * 1.05);
  gr.addColorStop(0, rgb(base, 1.32));
  gr.addColorStop(0.55, rgb(base, 1.0));
  gr.addColorStop(1, rgb(base, 0.68));
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, rad, 0, Math.PI * 2);
  g.fill();
  // назъбен ръб от отделни листа
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + h01(seed, i, 3);
    const lx = x + Math.cos(a) * rad * 0.92;
    const ly = y + Math.sin(a) * rad * 0.85;
    const lit = Math.cos(a) * -0.6 + Math.sin(a) * -0.8; // към светлината
    g.fillStyle = rgb(base, 0.95 + lit * 0.28);
    g.beginPath();
    g.arc(lx, ly, rad * (0.28 + h01(seed, i, 4) * 0.14), 0, Math.PI * 2);
    g.fill();
  }
  // отблясъци
  for (let i = 0; i < 4; i++) {
    g.fillStyle = rgb(base, 1.45, 0.75);
    g.beginPath();
    g.arc(x - rad * (0.2 + h01(seed, i, 5) * 0.5), y - rad * (0.25 + h01(seed, i, 6) * 0.45), Math.max(0.5, rad * 0.13), 0, Math.PI * 2);
    g.fill();
  }
  void r;
}

function trunk(g: Ctx, x: number, y: number, s: number, h: number, w: number, color: number, branches: number, seed: number) {
  const gr = g.createLinearGradient(x - w, 0, x + w, 0);
  gr.addColorStop(0, rgb(color, 1.15));
  gr.addColorStop(1, rgb(color, 0.6));
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(x - w * 1.5, y);
  g.lineTo(x - w * 0.7, y - h * s);
  g.lineTo(x + w * 0.7, y - h * s);
  g.lineTo(x + w * 1.5, y);
  g.closePath();
  g.fill();
  g.strokeStyle = rgb(color, 0.85);
  g.lineCap = 'round';
  for (let i = 0; i < branches; i++) {
    const side = i % 2 ? 1 : -1;
    const by = y - h * s * (0.55 + h01(seed, i, 8) * 0.4);
    g.lineWidth = w * 0.7;
    g.beginPath();
    g.moveTo(x, by);
    g.quadraticCurveTo(x + side * 2.5 * s, by - 2 * s, x + side * (3.5 + h01(seed, i, 9) * 2) * s, by - 4.5 * s);
    g.stroke();
  }
}

function softShadow(g: Ctx, x: number, y: number, rx: number, ry: number) {
  g.save();
  g.translate(x, y);
  g.scale(1, ry / rx);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  gr.addColorStop(0, 'rgba(15,30,15,0.36)');
  gr.addColorStop(0.6, 'rgba(15,30,15,0.22)');
  gr.addColorStop(1, 'rgba(15,30,15,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(0, 0, rx, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** Зимно (голо) широколистно дърво: ствол, разклонени клони и сняг по тях. */
function bareTree(g: Ctx, x: number, y: number, s: number, kind: TreeKind, seed: number) {
  softShadow(g, x + 7 * s, y + 1 * s, 8 * s, 3 * s);
  const birch = kind === 'birch';
  const col = birch ? '#d9d4ca' : kind === 'bush' ? '#6b5544' : '#5b4636';
  const h = kind === 'bush' ? 3 : kind === 'poplar' ? 22 : birch ? 15 : 12;
  g.lineCap = 'round';
  const branch = (bx: number, by: number, ang: number, len: number, w: number, depth: number, k: number) => {
    const ex = bx + Math.cos(ang) * len;
    const ey = by + Math.sin(ang) * len;
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(ex, ey);
    g.stroke();
    if (depth > 0 && w > 0.25 * s) {
      const n = 2 + (h01(seed, k, 41) < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const spread = kind === 'poplar' ? 0.25 : 0.6;
        const a = ang + (i - (n - 1) / 2) * spread + (h01(seed, k, i, 42) - 0.5) * 0.3;
        branch(ex, ey, a, len * (0.62 + h01(seed, k, i, 43) * 0.15), w * 0.62, depth - 1, k * 3 + i + 1);
      }
    } else {
      // сняг по върховете на клонките
      g.fillStyle = 'rgba(245,248,252,0.9)';
      g.beginPath();
      g.ellipse(ex, ey - 0.3 * s, 0.9 * s, 0.4 * s, 0, 0, Math.PI * 2);
      g.fill();
    }
  };
  if (kind === 'bush') {
    for (let i = 0; i < 6; i++) branch(x + (i - 2.5) * 0.8 * s, y, -Math.PI / 2 + (i - 2.5) * 0.3, 3.2 * s, 0.6 * s, 1, i + 10);
    return;
  }
  // ствол
  branch(x, y, -Math.PI / 2, h * s * 0.55, (birch ? 1.1 : 1.6) * s, 0, 0);
  const top = y - h * s * 0.55;
  const main = kind === 'poplar' ? 3 : 4;
  for (let i = 0; i < main; i++) {
    const a = -Math.PI / 2 + (i - (main - 1) / 2) * (kind === 'poplar' ? 0.22 : 0.5) + (h01(seed, i, 44) - 0.5) * 0.2;
    branch(x, top + i * 0.6 * s, a, h * s * (kind === 'poplar' ? 0.5 : 0.38), (birch ? 0.75 : 1.05) * s, 3, i + 1);
  }
  if (birch) {
    g.fillStyle = '#2d2d2d';
    for (let i = 0; i < 3; i++) g.fillRect(x - 0.5 * s, y - (1.5 + i * 2) * s, 0.9 * s, 0.4 * s);
  }
}

function treeDraw(g: Ctx, P: P3, r: number, kind: TreeKind, size: number, seed: number) {
  const s = size * r;
  const [x, y] = P(0, 0, 0);
  const autumn = h01(seed, 9) < (SEASON === 'autumn' ? 0.78 : 0.05);
  const spring = SEASON === 'spring';
  const green = tint(
    autumn ? pick(TREE_AUTUMN, h01(seed, 10)) : spring ? mixc(pick(TREE_GREENS, h01(seed, 1)), 0x9ccf55, 0.3) : pick(TREE_GREENS, h01(seed, 1)),
    seed,
  );
  if (SEASON === 'winter' && kind !== 'conifer' && kind !== 'pine') {
    bareTree(g, x, y, s, kind, seed);
    return;
  }

  if (kind === 'conifer' || kind === 'pine') {
    if (kind === 'pine') {
      // бял/черен бор: висок гол ствол и разлята корона
      softShadow(g, x + 8 * s, y + 1 * s, 9 * s, 3.4 * s);
      trunk(g, x, y, s, 15, 0.9 * s, 0x7a4f35, 0, seed);
      const base = tint(pick(CONIFER_GREENS, h01(seed, 2)), seed);
      const cy = y - 16 * s;
      const pts: [number, number, number][] = [];
      for (let i = 0; i < 9; i++) pts.push([x + (h01(seed, i, 11) - 0.5) * 11 * s, cy + (h01(seed, i, 12) - 0.6) * 6 * s, (2.4 + h01(seed, i, 13) * 1.6) * s]);
      pts.sort((a, b) => a[1] - b[1]);
      for (const [px, py, pr] of pts) leafCluster(g, px, py, pr, base, seed + px, r);
      return;
    }
    // смърч/ела: много неравни нива с клонки; огряна лява страна, сянка отдясно и под всяко ниво
    softShadow(g, x + 7 * s, y + 1 * s, 8 * s, 3 * s);
    trunk(g, x, y, s, 4, 0.8 * s, 0x5a4030, 0, seed);
    const base = tint(pick(CONIFER_GREENS, h01(seed, 2)), seed);
    const tiers = 6;
    const H = 28 * s;
    const lean = (h01(seed, 30) - 0.5) * 1.2 * s;
    for (let t = 0; t < tiers; t++) {
      const k = t / (tiers - 1);
      const yb = y - 3 * s - H * k * 0.86;
      const w = (8.6 - k * 7.2) * s;
      const tipY = yb - (6.5 - k * 1.5) * s;
      const tx0 = x + lean * k;
      const edge: [number, number][] = [];
      const teeth = 9;
      for (let i = 0; i <= teeth; i++) {
        const f = i / teeth;
        const ex = tx0 - w + 2 * w * f + (h01(seed, t, i, 31) - 0.5) * 1.2 * s;
        const ey = yb + (i % 2 ? -1.8 * s : 0.5 * s) * (0.6 + h01(seed, t, i, 32) * 0.8) - Math.sin(f * Math.PI) * 1.2 * s;
        edge.push([ex, ey]);
      }
      // лява (огряна) половина
      g.beginPath();
      g.moveTo(tx0, tipY);
      for (let i = 0; i <= teeth / 2; i++) g.lineTo(edge[i][0], edge[i][1]);
      g.lineTo(tx0, yb - 1 * s);
      g.closePath();
      g.fillStyle = rgb(base, 1.18 + h01(seed, t, 33) * 0.1);
      g.fill();
      // дясна (засенчена) половина
      g.beginPath();
      g.moveTo(tx0, tipY);
      g.lineTo(tx0, yb - 1 * s);
      for (let i = Math.ceil(teeth / 2); i <= teeth; i++) g.lineTo(edge[i][0], edge[i][1]);
      g.closePath();
      g.fillStyle = rgb(base, 0.74);
      g.fill();
      if (SEASON === 'winter') {
        // сняг по горната страна на клоните
        g.beginPath();
        g.moveTo(tx0, tipY);
        for (let i = 0; i <= teeth; i++) g.lineTo(edge[i][0], edge[i][1] - (1.4 + h01(seed, t, i, 34)) * s);
        g.lineTo(tx0 + w * 0.2, yb - 2.6 * s);
        g.closePath();
        g.fillStyle = 'rgba(244,247,251,0.82)';
        g.fill();
      }
      // тъмна долна страна по назъбения ръб (дълбочина между нивата)
      g.strokeStyle = rgb(base, 0.42, 0.55);
      g.lineWidth = 0.9 * s;
      g.beginPath();
      edge.forEach(([ex, ey], i) => (i ? g.lineTo(ex, ey + 0.5 * s) : g.moveTo(ex, ey + 0.5 * s)));
      g.stroke();
      // клонки
      g.strokeStyle = rgb(base, 1.45, 0.45);
      g.lineWidth = 0.45 * s;
      g.beginPath();
      g.moveTo(tx0 - 0.5 * s, tipY + 2 * s);
      g.lineTo(tx0 - w * 0.75, yb - 0.6 * s);
      g.stroke();
    }
    // връх
    g.strokeStyle = rgb(base, 0.9);
    g.lineWidth = 0.8 * s;
    g.beginPath();
    g.moveTo(x + lean, y - 3 * s - H * 0.86 - 5 * s);
    g.lineTo(x + lean, y - 3 * s - H * 0.86 - 7.5 * s);
    g.stroke();
    return;
  }

  if (kind === 'poplar') {
    softShadow(g, x + 8 * s, y + 1 * s, 9 * s, 3 * s);
    trunk(g, x, y, s, 5, 0.7 * s, 0x6b5040, 0, seed);
    for (let i = 0; i < 8; i++) {
      const py = y - (6 + i * 3.2) * s;
      const pw = (3.4 - Math.abs(i - 3) * 0.35) * s;
      leafCluster(g, x + (h01(seed, i, 15) - 0.5) * 1.6 * s, py, pw, green, seed + i, r);
    }
    return;
  }

  if (kind === 'bush') {
    softShadow(g, x + 4 * s, y + 0.5 * s, 6 * s, 2.4 * s);
    for (let i = 0; i < 4; i++) leafCluster(g, x + (i - 1.5) * 2.2 * s, y - (2 + (i % 2) * 1.5) * s, (2.4 + h01(seed, i, 16)) * s, green, seed + i, r);
    return;
  }

  // широколистни: дъб/липа, бреза, върба
  const crown = kind === 'birch' ? 0.8 : kind === 'willow' ? 1.1 : 1;
  const trunkH = kind === 'birch' ? 9 : 6;
  softShadow(g, x + 9 * s * crown, y + 1.5 * s, 11 * s * crown, 4 * s * crown);
  if (kind === 'birch') {
    trunk(g, x, y, s, trunkH, 0.75 * s, 0xe9e5dc, 2, seed);
    g.fillStyle = '#2d2d2d';
    for (let i = 0; i < 4; i++) g.fillRect(x - 0.7 * s, y - (1.5 + i * 2) * s, (0.8 + h01(seed, i, 17)) * s, 0.45 * s);
  } else trunk(g, x, y, s, trunkH, 1.1 * s, 0x5d4433, 2, seed);
  const base = kind === 'birch' ? mixc(green, 0x9cc65a, 0.35) : kind === 'willow' ? mixc(green, 0x8fae5a, 0.3) : green;
  const cy = y - (trunkH + 5 * crown) * s;
  const n = kind === 'birch' ? 10 : 14;
  const blobs: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = h01(seed, i, 18) * Math.PI * 2;
    const d = Math.sqrt(h01(seed, i, 19));
    blobs.push([x + Math.cos(a) * d * 6.2 * s * crown, cy + Math.sin(a) * d * 4.6 * s * crown - (1 - d) * 1.5 * s, (2.2 + h01(seed, i, 20) * 1.6) * s * crown]);
  }
  // отзад напред: първо горните/десните, накрая долните-леви (по-близо до зрителя)
  blobs.sort((a, b) => a[1] + (x - a[0]) * 0.2 - (b[1] + (x - b[0]) * 0.2));
  for (const [bx, by, br] of blobs) leafCluster(g, bx, by, br, base, seed + Math.round(bx * 7), r);
  if (kind === 'willow') {
    g.strokeStyle = rgb(base, 0.9);
    g.lineWidth = 0.55 * s;
    for (let i = -5; i <= 5; i++) {
      const sx = x + i * 1.3 * s;
      g.beginPath();
      g.moveTo(sx, cy + 1 * s);
      g.quadraticCurveTo(sx + i * 0.5 * s, cy + 5 * s, sx + i * 0.4 * s, cy + (8 + h01(seed, i + 9, 21) * 3) * s);
      g.stroke();
    }
  }
}

// ------------------------------------------------------------------ сгради
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
/** Сезон по игрови месец (1..12). */
export function seasonOf(month: number): Season {
  return month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
}
/** Сезонът на спрайта, който се рисува в момента (покриви със сняг, есенни/голи дървета). */
let SEASON: Season = 'summer';

export type BuildingKey = (
  | { k: 'zone'; z: string; lvl: number; v: number; face: Face; ab?: boolean; occ?: number }
  | { k: 'service'; s: string; v: number; face: Face }
  | { k: 'facility'; f: string; v: number; face: Face }
  | { k: 'construction'; v: number }
  | { k: 'tree'; t: TreeKind; v: number; size: number }
  | { k: 'rock'; v: number }
  | { k: 'tunnel'; v: number; dir: number }
) & { sn?: Season };

const cache = new Map<string, Sprite>();
export function spriteCacheSize() {
  return cache.size;
}

export function getSprite(key: BuildingKey, res: number): Sprite {
  const r = Math.round(res * 100) / 100;
  const id = `${JSON.stringify(key)}@${r}`;
  let s = cache.get(id);
  if (!s) {
    s = drawSprite(key, r);
    cache.set(id, s);
  }
  return s;
}

function drawSprite(key: BuildingKey, r: number): Sprite {
  SEASON = key.sn ?? 'summer';
  switch (key.k) {
    case 'tree':
      return makeSprite(r, 40 * key.size, (g, P) => treeDraw(g, P, r, key.t, key.size, key.v));
    case 'rock':
      return makeSprite(r, 14, (g, P) => {
        const c = pick([0x8d8a84, 0x9b968e, 0x7f7c77], h01(key.v));
        box(g, P, -0.12, -0.1, 0.1, 0.12, 0, 5 + h01(key.v, 2) * 5, { wall: c, edge: false });
      });
    case 'tunnel':
      return makeSprite(r, 30, (g, P) => {
        const [x, y] = P(0, 0, 0);
        g.fillStyle = rgb(0x7d7a73);
        g.beginPath();
        g.ellipse(x, y - 6 * r, 22 * r, 18 * r, 0, Math.PI, 0);
        g.lineTo(x + 22 * r, y + 4 * r);
        g.lineTo(x - 22 * r, y + 4 * r);
        g.fill();
        g.fillStyle = '#1b1d20';
        g.beginPath();
        g.ellipse(x, y - 4 * r, 15 * r, 12 * r, 0, Math.PI, 0);
        g.lineTo(x + 15 * r, y + 4 * r);
        g.lineTo(x - 15 * r, y + 4 * r);
        g.fill();
      });
    case 'construction':
      return makeSprite(r, 40, (g, P) => {
        const b: [number, number, number, number] = [-0.3, -0.3, 0.3, 0.3];
        poly(g, [P(-0.42, -0.42, 0), P(0.42, -0.42, 0), P(0.42, 0.42, 0), P(-0.42, 0.42, 0)], rgb(0xb59a72));
        box(g, P, b[0], b[1], b[2], b[3], 0, 8, { wall: 0xc9c4ba });
        // скеле
        g.strokeStyle = rgb(0xd08c2a);
        g.lineWidth = 0.8 * r;
        for (let i = 0; i <= 4; i++) {
          const a = facePt(P, 'left', b[0], b[1], b[2], b[3], i / 4, 0);
          const c = facePt(P, 'left', b[0], b[1], b[2], b[3], i / 4, 18);
          g.beginPath();
          g.moveTo(a[0], a[1]);
          g.lineTo(c[0], c[1]);
          g.stroke();
        }
        // кран – само на част от строежите
        if (h01(key.v, 3) < 0.34) {
          const base = P(0.32, -0.32, 0);
          g.strokeStyle = rgb(0xe0a526);
          g.lineWidth = 0.9 * r;
          g.beginPath();
          g.moveTo(base[0], base[1]);
          g.lineTo(base[0], base[1] - 30 * r);
          g.lineTo(base[0] - 18 * r, base[1] - 30 * r);
          g.stroke();
        }
      });
    case 'zone':
      return zoneBuilding(key, r);
    case 'service':
      return serviceBuilding(key, r);
    case 'facility':
      return facilityBuilding(key, r);
  }
}

function zoneBuilding(key: Extract<BuildingKey, { k: 'zone' }>, r: number): Sprite {
  const { z, lvl, v, face } = key;
  const t = (n: number) => h01(v, n);
  const ab = !!key.ab;
  const dim = (c: number) => (ab ? mixc(c, 0x6b6660, 0.55) : c);
  const H =
    z === 'R'
      ? [16, 34, 60 + t(1) * 90][lvl - 1]
      : z === 'O'
        ? [26, 70, 120 + t(1) * 120][lvl - 1]
        : z === 'C'
          ? [14, 30, 52 + t(1) * 40][lvl - 1]
          : z === 'H'
            ? [18, 30, 48][lvl - 1]
            : 30;
  return makeSprite(r, H + 50, (g, P) => {
    const other: Face = face === 'left' ? 'right' : 'left';
    if (z === 'R') {
      if (lvl === 1) {
        // еднофамилна къща (вариант: едноетажна, двуетажна, с гараж, с четирискатен покрив)
        const two = t(2) < 0.45;
        const hh = two ? FLOOR * 2 : FLOOR + 2;
        const b: [number, number, number, number] = t(3) < 0.5 ? [-0.28, -0.22, 0.24, 0.2] : [-0.22, -0.28, 0.2, 0.24];
        const wall = dim(pick(WALLS, t(4)));
        const rc = dim(pick(ROOF_TILES, t(5)));
        // двор с ограда
        yard(g, P, r, v, face, dim);
        shadow(g, P, b[0], b[1], b[2], b[3], hh + 10);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        windows(g, P, r, b, 0, hh, { glass: 0x6f8aa0, density: 3.2, w: 0.42, hgt: 0.5, seed: v, lit: 0.1, noSlabs: true });
        door(g, P, b, face, 0.5, 0.16, 8, pick([0x6b4430, 0x3f5a6b, 0x7a2e2a], t(6)));
        roof(g, P, b, hh, t(7) < 0.3 ? 'hip' : 'gable', rc, wall, 10 + t(8) * 4, v);
        if (t(9) < 0.6) chimney(g, P, b[0] + 0.1, b[1] + 0.12, hh + 4, 7);
        if (t(10) < 0.35 && !two) {
          const gb: [number, number, number, number] = [b[2] + 0.02, b[1] + 0.05, b[2] + 0.2, b[3] - 0.05];
          box(g, P, gb[0], gb[1], gb[2], gb[3], 0, 8, { wall: dim(mixc(wall, 0xffffff, 0.2)), top: 0x8a8580 });
          faceQuad(g, P, 'right', gb, 0.15, 0.85, 0, 6, rgb(0xd9d4cb, 0.75));
        }
        return;
      }
      if (lvl === 2) {
        const kind = t(2);
        if (kind < 0.4) {
          // редови къщи
          const n = 3;
          for (let i = 0; i < n; i++) {
            const u0 = -0.38 + (0.76 / n) * i;
            const b: [number, number, number, number] = [u0, -0.24, u0 + 0.76 / n - 0.01, 0.26];
            const wall = dim(pick(WALLS, t(10 + i)));
            const hh = FLOOR * 2 + 2;
            if (i === 0) shadow(g, P, -0.38, -0.24, 0.38, 0.26, hh + 12);
            box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
            windows(g, P, r, b, 0, hh, { glass: 0x6f8aa0, density: 6, w: 0.5, seed: v + i, lit: 0.12 });
            door(g, P, b, 'left', 0.5, 0.25, 8, 0x5a3f2c);
            roof(g, P, b, hh, 'gable', dim(pick(ROOF_TILES, t(5))), wall, 9, v + i);
            chimney(g, P, b[0] + 0.06, -0.05, hh + 4, 6);
          }
          return;
        }
        // нисък жилищен блок (4 етажа) с балкони
        const floors = kind < 0.75 ? 4 : 3;
        const hh = FLOOR * floors;
        const b: [number, number, number, number] = [-0.38, -0.3, 0.38, 0.32];
        const wall = dim(pick([...WALLS, ...BRICK.slice(0, 1)], t(4)));
        shadow(g, P, b[0], b[1], b[2], b[3], hh);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        windows(g, P, r, b, 0, hh, { glass: 0x6c8597, density: 6, w: 0.48, seed: v, lit: 0.12, balcony: 0.5 });
        door(g, P, b, face, 0.5, 0.12, 9, 0x4b5a63);
        if (kind < 0.75) roof(g, P, b, hh, 'flat', dim(0x8d8a86), wall, 0, v);
        else roof(g, P, b, hh, 'hip', dim(pick(ROOF_TILES, t(5))), wall, 12, v);
        return;
      }
      // висока жилищна сграда / луксозна кула / комплекс
      const luxury = t(2) < 0.3;
      const hh = Math.round(H / FLOOR) * FLOOR;
      const b: [number, number, number, number] = luxury ? [-0.3, -0.3, 0.3, 0.3] : t(3) < 0.5 ? [-0.38, -0.26, 0.38, 0.28] : [-0.26, -0.38, 0.28, 0.38];
      const wall = dim(luxury ? pick(MODERN, t(4)) : pick(WALLS, t(4)));
      shadow(g, P, b[0], b[1], b[2], b[3], hh);
      // подиум
      box(g, P, b[0] - 0.04, b[1] - 0.04, b[2] + 0.04, b[3] + 0.04, 0, FLOOR, { wall: dim(0xbdb6aa) });
      faceQuad(g, P, face, [b[0] - 0.04, b[1] - 0.04, b[2] + 0.04, b[3] + 0.04], 0.1, 0.9, 1, FLOOR - 2, rgb(0x5d7484, face === 'left' ? 0.95 : 0.75));
      box(g, P, b[0], b[1], b[2], b[3], FLOOR, hh, { wall });
      windows(
        g,
        P,
        r,
        b,
        FLOOR,
        hh,
        luxury ? { glass: pick(GLASS, t(5)), band: true, seed: v } : { glass: 0x6c8597, density: 6, w: 0.5, seed: v, lit: 0.14, balcony: 0.7 },
      );
      roof(g, P, b, hh, 'flat', dim(0x9a9792), wall, 0, v);
      if (luxury) box(g, P, b[0] + 0.1, b[1] + 0.1, b[2] - 0.1, b[3] - 0.1, hh, hh + 6, { wall: 0xdfe3e6 });
      void other;
      return;
    }
    if (z === 'C') {
      if (lvl === 1) {
        // малък магазин / ресторант с тента
        const b: [number, number, number, number] = [-0.32, -0.3, 0.32, 0.3];
        const wall = dim(pick(WALLS, t(4)));
        const hh = t(2) < 0.5 ? FLOOR + 3 : FLOOR * 2;
        shadow(g, P, b[0], b[1], b[2], b[3], hh);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        for (const f of ['left', 'right'] as Face[]) faceQuad(g, P, f, b, 0.08, 0.92, 1, 8, rgb(0x5f7d90, f === 'left' ? 1 : 0.75));
        if (hh > FLOOR + 3) windows(g, P, r, b, FLOOR, hh, { glass: 0x6f8aa0, density: 5, seed: v });
        const aw = dim(pick([0xc0392b, 0x2e7d32, 0x1f5f8b, 0xd68910, 0x7d3c98], t(5)));
        for (const f of ['left', 'right'] as Face[]) {
          const [u0, v0, u1, v1] = b;
          const o = 0.08;
          const pts =
            f === 'left'
              ? [P(u0, v1, 10), P(u1, v1, 10), P(u1, v1 + o, 7), P(u0, v1 + o, 7)]
              : [P(u1, v0, 10), P(u1, v1, 10), P(u1 + o, v1, 7), P(u1 + o, v0, 7)];
          poly(g, pts as [number, number][], rgb(aw, f === 'left' ? 1 : 0.8));
        }
        roof(g, P, b, hh, 'flat', dim(0x8f8b85), wall, 0, v);
        // табела
        faceQuad(g, P, face, b, 0.25, 0.75, hh - 4, hh - 0.5, rgb(0xf4f1e8));
        return;
      }
      if (lvl === 2) {
        if (t(2) < 0.5) {
          // супермаркет: широка ниска сграда с паркинг
          poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(0x6e6f71));
          parking(g, P, r, -0.46, 0.3, 0.46, 0.48, v, 0.65);
          const b: [number, number, number, number] = [-0.42, -0.42, 0.18, 0.24];
          const wall = dim(pick(MODERN, t(4)));
          const brand = pick([0xd35400, 0x1f6fb2, 0x27ae60, 0xc0392b], t(5));
          shadow(g, P, b[0], b[1], b[2], b[3], 16);
          box(g, P, b[0], b[1], b[2], b[3], 0, 16, { wall });
          // витрина и вход с козирка
          faceQuad(g, P, 'left', b, 0.08, 0.92, 1, 9, faceGrad(g, P, 'left', b, 0.5, 1, 9, rgb(0x2f4a5c), rgb(0xa9cde0)));
          for (let i = 1; i < 8; i++) faceQuad(g, P, 'left', b, 0.08 + i * 0.105 - 0.004, 0.08 + i * 0.105 + 0.004, 1, 9, 'rgba(230,235,240,0.8)');
          box(g, P, b[0] + 0.12, b[3], b[0] + 0.32, b[3] + 0.08, 9, 10.5, { wall: brand, edge: false });
          faceQuad(g, P, 'left', b, 0.05, 0.95, 11.5, 15, rgb(brand));
          faceQuad(g, P, 'left', b, 0.3, 0.7, 12.3, 14.2, 'rgba(255,255,255,0.85)');
          roof(g, P, b, 16, 'flat', dim(0x9d9a95), wall, 0, v);
          return;
        }
        // търговска сграда (магазини на партера, офиси отгоре)
        const b: [number, number, number, number] = [-0.38, -0.34, 0.38, 0.36];
        const wall = dim(pick([...WALLS, ...MODERN], t(4)));
        const hh = FLOOR * 4;
        shadow(g, P, b[0], b[1], b[2], b[3], hh);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        for (const f of ['left', 'right'] as Face[]) faceQuad(g, P, f, b, 0.04, 0.96, 1, 9, rgb(0x56778c, f === 'left' ? 1 : 0.75));
        windows(g, P, r, b, FLOOR, hh, { glass: 0x6f8aa0, density: 6, seed: v, lit: 0.15 });
        roof(g, P, b, hh, 'flat', dim(0x8d8a86), wall, 0, v);
        return;
      }
      // търговски център / хотел
      if (t(2) < 0.5) {
        // мол: стъклен атриум-вход, козирка, табела, светлинни отвори на покрива, паркинг отпред
        poly(g, [P(-0.49, -0.49, 0), P(0.49, -0.49, 0), P(0.49, 0.49, 0), P(-0.49, 0.49, 0)], rgb(0x6e6f71));
        parking(g, P, r, -0.47, 0.34, 0.47, 0.49, v + 3, 0.75);
        const b: [number, number, number, number] = [-0.44, -0.44, 0.4, 0.3];
        const wall = dim(pick(MODERN, t(4)));
        const glassC = pick(GLASS, t(5));
        shadow(g, P, b[0], b[1], b[2], b[3], 26);
        box(g, P, b[0], b[1], b[2], b[3], 0, 26, { wall });
        // хоризонтални ленти от панели
        for (const f of ['left', 'right'] as Face[]) for (let z = 6; z < 26; z += 6) faceQuad(g, P, f, b, 0, 1, z, z + 0.6, 'rgba(0,0,0,0.08)');
        for (const f of ['left', 'right'] as Face[]) {
          faceQuad(
            g,
            P,
            f,
            b,
            0.36,
            0.64,
            0,
            25,
            faceGrad(g, P, f, b, 0.5, 0, 25, rgb(glassC, f === 'left' ? 0.75 : 0.55), rgb(mixc(glassC, 0xe5f3ff, 0.5), f === 'left' ? 1 : 0.8)),
          );
          for (let i = 1; i < 6; i++) faceQuad(g, P, f, b, 0.36 + i * 0.047 - 0.003, 0.36 + i * 0.047 + 0.003, 0, 25, 'rgba(235,240,245,0.6)');
          faceQuad(g, P, f, b, 0.06, 0.32, 15, 21, rgb(0xf2f0ea, f === 'left' ? 1 : 0.78));
          faceQuad(g, P, f, b, 0.09, 0.29, 16.5, 19.5, rgb(pick([0xd35400, 0x1f6fb2, 0x8e44ad, 0xc0392b], t(6)), f === 'left' ? 1 : 0.8));
        }
        box(g, P, b[0] + 0.32, b[3], b[0] + 0.58, b[3] + 0.1, 8, 9.5, { wall: 0xdedad2, edge: false });
        roof(g, P, b, 26, 'flat', dim(0xa09d97), wall, 0, v);
        for (let i = 0; i < 4; i++) {
          const u = b[0] + 0.12 + i * 0.18;
          roofPlaneSky(g, P, u, b[1] + 0.12, u + 0.1, b[3] - 0.12, 26);
        }
        return;
      }
      const hh = Math.round(H / FLOOR) * FLOOR;
      const b: [number, number, number, number] = [-0.3, -0.32, 0.3, 0.32];
      const wall = dim(pick([0xe8e2d6, 0xd9cfc0, 0xc7bba8], t(4)));
      shadow(g, P, b[0], b[1], b[2], b[3], hh);
      box(g, P, b[0] - 0.08, b[1] - 0.08, b[2] + 0.08, b[3] + 0.08, 0, FLOOR, { wall: dim(0xcfc6b6) });
      box(g, P, b[0], b[1], b[2], b[3], FLOOR, hh, { wall });
      windows(g, P, r, b, FLOOR, hh, { glass: 0x6a8aa4, density: 7, w: 0.55, seed: v, lit: 0.25 });
      roof(g, P, b, hh, 'flat', dim(0x8e8a84), wall, 0, v);
      faceQuad(g, P, face, b, 0.2, 0.8, hh - 5, hh - 1, rgb(0xc9a84a));
      return;
    }
    if (z === 'O' || z === 'H') {
      if (z === 'H') {
        // технологичен кампус
        const b: [number, number, number, number] = [-0.4, -0.36, 0.3, 0.3];
        poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(0x8db36a, 1, 0.9));
        shadow(g, P, b[0], b[1], b[2], b[3], H);
        box(g, P, b[0], b[1], b[2], b[3], 0, H, { wall: dim(0xe9ecef) });
        windows(g, P, r, b, 0, H, { glass: pick(GLASS, t(5)), band: true, seed: v });
        roof(g, P, b, H, 'flat', dim(0xcfd3d6), 0xe9ecef, 0, v);
        for (let i = 0; i < 4; i++) {
          const u = b[0] + 0.08 + i * 0.15;
          poly(g, [P(u, b[1] + 0.1, H + 1), P(u + 0.11, b[1] + 0.1, H + 1), P(u + 0.11, b[3] - 0.1, H + 3), P(u, b[3] - 0.1, H + 3)], rgb(0x2c4a6e));
        }
        return;
      }
      const hh = Math.round(H / FLOOR) * FLOOR;
      const b: [number, number, number, number] = lvl === 3 ? [-0.3, -0.3, 0.3, 0.3] : [-0.36, -0.34, 0.36, 0.34];
      const glass = dim(pick(GLASS, t(5)));
      const frame = dim(pick(MODERN, t(4)));
      shadow(g, P, b[0], b[1], b[2], b[3], hh);
      if (lvl === 3 && t(6) < 0.5) {
        // кула със стъпаловиден силует
        box(g, P, b[0], b[1], b[2], b[3], 0, hh * 0.7, { wall: frame });
        windows(g, P, r, b, 0, hh * 0.7, { glass, band: true, seed: v });
        const b2: [number, number, number, number] = [b[0] + 0.07, b[1] + 0.07, b[2] - 0.07, b[3] - 0.07];
        roof(g, P, b, hh * 0.7, 'flat', 0x9ea3a8, frame, 0, v + 1);
        box(g, P, b2[0], b2[1], b2[2], b2[3], hh * 0.7, hh, { wall: frame });
        windows(g, P, r, b2, hh * 0.7, hh, { glass, band: true, seed: v });
        roof(g, P, b2, hh, 'flat', 0x9ea3a8, frame, 0, v);
        const top = P(0, 0, hh + 18);
        const bot = P(0, 0, hh);
        g.strokeStyle = '#9aa0a6';
        g.lineWidth = 1.2 * r;
        g.beginPath();
        g.moveTo(bot[0], bot[1]);
        g.lineTo(top[0], top[1]);
        g.stroke();
        return;
      }
      box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall: frame });
      windows(g, P, r, b, 0, hh, { glass, band: true, seed: v });
      // вертикални ребра
      for (const f of ['left', 'right'] as Face[])
        for (let i = 1; i < 4; i++) faceQuad(g, P, f, b, i / 4 - 0.01, i / 4 + 0.01, 0, hh, rgb(frame, f === 'left' ? 0.95 : 0.75));
      door(g, P, b, face, 0.5, 0.2, 10, 0x34495e);
      roof(g, P, b, hh, 'flat', 0x9ea3a8, frame, 0, v);
      return;
    }
    if (z === 'I') {
      if (lvl === 1) {
        // работилница
        const b: [number, number, number, number] = [-0.34, -0.3, 0.3, 0.3];
        poly(g, [P(-0.47, -0.47, 0), P(0.47, -0.47, 0), P(0.47, 0.47, 0), P(-0.47, 0.47, 0)], rgb(0xa29d93));
        const wall = dim(pick([0xb8b2a6, 0xa9a49a, 0xc4b59d], t(4)));
        shadow(g, P, b[0], b[1], b[2], b[3], 18);
        box(g, P, b[0], b[1], b[2], b[3], 0, 14, { wall });
        corrugate(g, P, b, 0, 14, r);
        faceQuad(g, P, face, b, 0.3, 0.7, 0, 10, rgb(0x6f7378, face === 'left' ? 0.95 : 0.75));
        roof(g, P, b, 14, 'gable', dim(0x7a8086), wall, 7, v);
        // палети
        box(g, P, 0.32, -0.4, 0.44, -0.28, 0, 4, { wall: 0xb08a5a, edge: false });
        return;
      }
      if (lvl === 2) {
        // производствено хале с шедов покрив и комин
        const b: [number, number, number, number] = [-0.42, -0.38, 0.3, 0.36];
        poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(0x9a968e));
        const wall = dim(pick([0xb7b1a6, 0xa59f95, 0x9fa6ab], t(4)));
        shadow(g, P, b[0], b[1], b[2], b[3], 30);
        box(g, P, b[0], b[1], b[2], b[3], 0, 18, { wall });
        corrugate(g, P, b, 0, 11, r);
        for (const f of ['left', 'right'] as Face[]) faceQuad(g, P, f, b, 0.05, 0.95, 11, 15, rgb(0x7f97a8, f === 'left' ? 0.95 : 0.72));
        roof(g, P, b, 18, 'sawtooth', dim(0x8a8f94), wall, 7, v);
        if (t(3) < 0.3) cylinder(g, P, r, 0.38, -0.36, 0.045, 0, 40, dim(0xa9542f));
        return;
      }
      // завод: хале + резервоари + високи комини
      const b: [number, number, number, number] = [-0.44, -0.2, 0.2, 0.44];
      poly(g, [P(-0.49, -0.49, 0), P(0.49, -0.49, 0), P(0.49, 0.49, 0), P(-0.49, 0.49, 0)], rgb(0x8f8b84));
      const wall = dim(pick([0xb5b0a7, 0x9ea4a9], t(4)));
      shadow(g, P, b[0], b[1], b[2], b[3], 34);
      cylinder(g, P, r, -0.24, -0.34, 0.11, 0, 22, dim(0xd8d6d0));
      cylinder(g, P, r, 0.0, -0.34, 0.11, 0, 22, dim(0xd8d6d0));
      box(g, P, b[0], b[1], b[2], b[3], 0, 26, { wall });
      windows(g, P, r, b, 0, 26, { glass: 0x7f97a8, band: true, seed: v });
      roof(g, P, b, 26, 'flat', dim(0x7e8388), wall, 0, v);
      if (t(3) < 0.35) cylinder(g, P, r, 0.36, 0.2, 0.045, 0, 48 + t(6) * 14, dim(t(7) < 0.5 ? 0xc9c5bd : 0xb84d33));
      else {
        box(g, P, 0.24, 0.0, 0.44, 0.4, 0, 12, { wall: dim(0xcfcac0) });
        roof(g, P, [0.24, 0.0, 0.44, 0.4], 12, 'gable', dim(0x7e8388), dim(0xcfcac0), 5, v);
      }
      return;
    }
    if (z === 'L') {
      if (lvl === 3 && t(2) < 0.5) {
        // контейнерен терминал
        poly(g, [P(-0.49, -0.49, 0), P(0.49, -0.49, 0), P(0.49, 0.49, 0), P(-0.49, 0.49, 0)], rgb(0x8c8a86));
        const cols = [0xc0392b, 0x2471a3, 0x229954, 0xd68910, 0x7d3c98, 0x5d6d7e, 0xa04000];
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 4; j++) {
            const stack = 1 + Math.floor(h01(v, i, j) * 3);
            for (let s = 0; s < stack; s++) {
              const u0 = -0.4 + i * 0.27;
              const v0 = -0.4 + j * 0.2;
              box(g, P, u0, v0, u0 + 0.22, v0 + 0.15, s * 6, s * 6 + 6, { wall: pick(cols, h01(v, i, j, s)), edge: true });
            }
          }
        // портален кран
        const a = P(-0.45, 0.42, 0);
        const c = P(0.45, 0.42, 0);
        g.strokeStyle = rgb(0xe0a526);
        g.lineWidth = 2 * r;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(a[0], a[1] - 50 * r);
        g.lineTo(c[0], c[1] - 50 * r);
        g.lineTo(c[0], c[1]);
        g.stroke();
        return;
      }
      // склад / разпределителен център с рампи и камиони
      const big = lvl >= 2;
      const b: [number, number, number, number] = big ? [-0.44, -0.42, 0.3, 0.3] : [-0.34, -0.32, 0.26, 0.28];
      poly(g, [P(-0.49, -0.49, 0), P(0.49, -0.49, 0), P(0.49, 0.49, 0), P(-0.49, 0.49, 0)], rgb(0x7f8083));
      const wall = dim(pick([0xd5d2cb, 0xc3c8cc, 0xe0d8c8], t(4)));
      const hh = big ? 20 : 15;
      shadow(g, P, b[0], b[1], b[2], b[3], hh);
      box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
      corrugate(g, P, b, 0, hh, r);
      const docks = big ? 5 : 3;
      for (let i = 0; i < docks; i++) faceQuad(g, P, 'right', b, (i + 0.2) / docks, (i + 0.8) / docks, 0, 9, rgb(0x5d6166, 0.75));
      faceQuad(g, P, 'left', b, 0.05, 0.95, hh - 4, hh - 1, rgb(pick([0x1f5f8b, 0xc0392b, 0x239b56], t(5))));
      roof(g, P, b, hh, 'flat', dim(0xa5a29c), wall, 0, v);
      // камиони
      for (let i = 0; i < (big ? 2 : 1); i++) {
        const vv = b[1] + 0.15 + i * 0.3;
        box(g, P, b[2] + 0.04, vv, b[2] + 0.18, vv + 0.08, 0, 6, { wall: 0xe9e9e9, edge: false });
        box(g, P, b[2] + 0.18, vv, b[2] + 0.24, vv + 0.08, 0, 5, { wall: pick([0xc0392b, 0x2471a3, 0x2e4053], h01(v, i)), edge: false });
      }
      return;
    }
    if (z === 'A') {
      farmTile(g, P, r, v, lvl, dim);
      return;
    }
  });
}

function farmTile(g: Ctx, P: P3, r: number, v: number, lvl: number, dim: (c: number) => number) {
  const t = (n: number) => h01(v, n);
  const crop = dim(pick([0xd9c47a, 0x9cbf5a, 0xa4844f, 0xc9b85a, 0x86ad4f], t(1)));
  poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(crop));
  g.strokeStyle = rgb(crop, 0.82);
  g.lineWidth = 0.6 * r;
  for (let i = -4; i <= 4; i++) {
    const a = P(-0.48, i * 0.11, 0);
    const c = P(0.48, i * 0.11, 0);
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(c[0], c[1]);
    g.stroke();
  }
  const kind = t(2);
  if (kind < 0.4) {
    // плевня
    const b: [number, number, number, number] = [-0.38, -0.36, -0.06, -0.12];
    shadow(g, P, b[0], b[1], b[2], b[3], 20);
    box(g, P, b[0], b[1], b[2], b[3], 0, 12, { wall: dim(0x9e3b2d) });
    faceQuad(g, P, 'left', b, 0.3, 0.7, 0, 9, rgb(0xe8e0d0, 0.9));
    roof(g, P, b, 12, 'gable', dim(0x5d5a57), dim(0x9e3b2d), 9, v);
    if (lvl >= 2) cylinder(g, P, r, 0.0, -0.36, 0.08, 0, 26, dim(0xb9bec2));
  } else if (kind < 0.7) {
    // силози
    cylinder(g, P, r, -0.3, -0.34, 0.09, 0, 30, dim(0xc4c8cc));
    cylinder(g, P, r, -0.1, -0.38, 0.09, 0, 30, dim(0xc4c8cc));
    box(g, P, 0.02, -0.42, 0.22, -0.22, 0, 10, { wall: dim(0xd8cfb8) });
    roof(g, P, [0.02, -0.42, 0.22, -0.22], 10, 'gable', dim(0x6b6b6b), dim(0xd8cfb8), 6, v);
  } else {
    // оранжерии
    for (let i = 0; i < 3; i++) {
      const b: [number, number, number, number] = [-0.4, -0.42 + i * 0.16, 0.1, -0.3 + i * 0.16];
      box(g, P, b[0], b[1], b[2], b[3], 0, 5, { wall: 0xdfeee8, edge: false });
      roof(g, P, b, 5, 'gable', 0xcfe3dc, 0xdfeee8, 4, v + i);
    }
  }
}

function serviceBuilding(key: Extract<BuildingKey, { k: 'service' }>, r: number): Sprite {
  const { s, v, face } = key;
  const t = (n: number) => h01(v, n);
  return makeSprite(r, 120, (g, P) => {
    const lot = (c: number) => poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(c));
    switch (s) {
      case 'parking': {
        // открит паркинг: асфалт, бели линии, паркирани коли, бариера и табела „P“
        lot(0x6a6d72);
        parking(g, P, r, -0.46, -0.42, 0.46, 0.04, v, 0.75);
        parking(g, P, r, -0.46, 0.06, 0.46, 0.46, v + 7, 0.7);
        const [px, py] = P(0.4, 0.42, 0);
        g.strokeStyle = '#3b4046';
        g.lineWidth = 1 * r;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px, py - 14 * r);
        g.stroke();
        g.fillStyle = '#1f5fd6';
        g.fillRect(px - 4 * r, py - 22 * r, 8 * r, 8 * r);
        g.fillStyle = '#fff';
        g.font = `bold ${7 * r}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.fillText('P', px, py - 15.5 * r);
        return;
      }
      case 'park': {
        lot(grass(0x7fae55));
        g.strokeStyle = rgb(0xd9ccaa);
        g.lineWidth = 2.4 * r;
        const a = P(-0.48, 0, 0);
        const b = P(0.48, 0, 0);
        const c = P(0, -0.48, 0);
        const d = P(0, 0.48, 0);
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.moveTo(c[0], c[1]);
        g.lineTo(d[0], d[1]);
        g.stroke();
        const [fx, fy] = P(0, 0, 0);
        g.beginPath();
        g.ellipse(fx, fy, 8 * r, 4 * r, 0, 0, Math.PI * 2);
        g.fillStyle = rgb(0xd9ccaa);
        g.fill();
        g.beginPath();
        g.ellipse(fx, fy, 5 * r, 2.5 * r, 0, 0, Math.PI * 2);
        g.fillStyle = rgb(0x5aa0c8);
        g.fill();
        const spots: [number, number][] = [
          [-0.3, -0.3],
          [0.28, -0.25],
          [-0.25, 0.3],
          [0.3, 0.3],
          [-0.35, 0.05],
          [0.05, -0.35],
        ];
        for (const [i, [u, w]] of spots.entries()) {
          const sp = getSprite({ k: 'tree', t: i % 3 === 0 ? 'birch' : 'oak', v: v + i, size: 1.4 + h01(v, i) * 0.5 }, r);
          const [px, py] = P(u, w, 0);
          g.drawImage(sp.canvas, px - sp.ax, py - sp.ay);
        }
        return;
      }
      case 'school':
      case 'university': {
        lot(0xc9c2b2);
        const uni = s === 'university';
        const wall = uni ? 0xe7e0cf : pick(BRICK, t(1));
        const b: [number, number, number, number] = [-0.42, -0.4, 0.3, 0.2];
        const hh = uni ? FLOOR * 3 + 4 : FLOOR * 2 + 2;
        // спортна площадка
        poly(g, [P(-0.42, 0.26, 0), P(0.1, 0.26, 0), P(0.1, 0.46, 0), P(-0.42, 0.46, 0)], rgb(uni ? 0x8db36a : 0xb5553c));
        shadow(g, P, b[0], b[1], b[2], b[3], hh);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        windows(g, P, r, b, 0, hh, { glass: 0x6d8aa1, density: 7, w: 0.55, seed: v, lit: 0.2 });
        if (uni) {
          for (let i = 0; i < 6; i++) faceQuad(g, P, 'left', b, 0.3 + i * 0.07, 0.33 + i * 0.07, 0, hh - 4, rgb(0xf6f2e8));
          poly(
            g,
            [
              facePt(P, 'left', b[0], b[1], b[2], b[3], 0.27, hh - 4),
              facePt(P, 'left', b[0], b[1], b[2], b[3], 0.73, hh - 4),
              facePt(P, 'left', b[0], b[1], b[2], b[3], 0.5, hh + 6),
            ],
            rgb(0xf2ede0),
          );
          roof(g, P, b, hh, 'hip', 0x6d7b84, wall, 10, v);
          cylinder(g, P, r, -0.06, -0.1, 0.1, hh + 4, hh + 14, 0x7f9aa6);
        } else roof(g, P, b, hh, 'hip', pick(ROOF_TILES, t(2)), wall, 10, v);
        door(g, P, b, face, 0.5, 0.12, 10, 0x34495e);
        return;
      }
      case 'clinic': {
        lot(0xcac6bd);
        const b: [number, number, number, number] = [-0.38, -0.36, 0.34, 0.3];
        const hh = FLOOR * 5;
        shadow(g, P, b[0], b[1], b[2], b[3], hh);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall: 0xf2f2ef });
        windows(g, P, r, b, 0, hh, { glass: 0x86a9bd, band: true, seed: v });
        roof(g, P, b, hh, 'flat', 0xbfc3c4, 0xf2f2ef, 0, v);
        // хеликоптерна площадка и червен кръст
        const [cx, cy] = P(-0.02, -0.03, hh + 0.5);
        g.beginPath();
        g.ellipse(cx, cy, 12 * r, 6 * r, 0, 0, Math.PI * 2);
        g.fillStyle = '#4b5258';
        g.fill();
        g.fillStyle = '#ffffff';
        g.font = `${Math.max(4, 8 * r)}px sans-serif`;
        g.textAlign = 'center';
        g.fillText('H', cx, cy + 3 * r);
        faceQuad(g, P, 'left', b, 0.42, 0.58, hh - 9, hh - 2, '#d62d20');
        faceQuad(g, P, 'left', b, 0.47, 0.53, hh - 12, hh + 1, '#d62d20');
        return;
      }
      case 'police_station':
      case 'fire_station': {
        const fire = s === 'fire_station';
        lot(0xa8a59f);
        const wall = fire ? 0xa94a35 : 0xe9ecef;
        const b: [number, number, number, number] = [-0.38, -0.36, 0.3, 0.28];
        const hh = FLOOR * 2 + 2;
        shadow(g, P, b[0], b[1], b[2], b[3], hh + 14);
        box(g, P, b[0], b[1], b[2], b[3], 0, hh, { wall });
        if (fire) {
          for (let i = 0; i < 3; i++) faceQuad(g, P, 'left', b, 0.08 + i * 0.3, 0.3 + i * 0.3, 0, 12, rgb(0xd8d4cc, 0.9));
          box(g, P, b[2] - 0.12, b[1], b[2], b[1] + 0.12, hh, hh + 16, { wall });
        } else {
          faceQuad(g, P, 'left', b, 0.05, 0.95, hh - 6, hh - 3, '#1f4e8c');
          windows(g, P, r, b, 0, hh, { glass: 0x5c7d96, density: 6, seed: v });
        }
        roof(g, P, b, hh, 'flat', 0x8c8f92, wall, 0, v);
        return;
      }
      case 'bus_depot': {
        lot(0x77787a);
        const b: [number, number, number, number] = [-0.42, -0.4, 0.3, 0.1];
        shadow(g, P, b[0], b[1], b[2], b[3], 16);
        box(g, P, b[0], b[1], b[2], b[3], 0, 14, { wall: 0xd7d3cb });
        for (let i = 0; i < 4; i++) faceQuad(g, P, 'left', b, 0.05 + i * 0.24, 0.25 + i * 0.24, 0, 10, rgb(0x4f5357, 0.9));
        roof(g, P, b, 14, 'gable', 0x7d8287, 0xd7d3cb, 6, v);
        for (let i = 0; i < 3; i++) {
          const vv = 0.18 + i * 0.1;
          box(g, P, -0.4, vv, 0.05, vv + 0.07, 0, 7, { wall: pick([0xf1c40f, 0x2e86c1, 0xe74c3c], h01(v, i)), top: 0xe8e8e8, edge: false });
        }
        return;
      }
      case 'power_coal': {
        lot(0x7d7a74);
        cylinder(g, P, r, -0.18, -0.2, 0.24, 0, 64, 0xc8c4bc, 0.28);
        const b: [number, number, number, number] = [0.02, -0.04, 0.42, 0.42];
        shadow(g, P, b[0], b[1], b[2], b[3], 30);
        box(g, P, b[0], b[1], b[2], b[3], 0, 30, { wall: 0x9e9a92 });
        roof(g, P, b, 30, 'flat', 0x6c6a66, 0x9e9a92, 0, v);
        cylinder(g, P, r, 0.36, 0.0, 0.05, 30, 90, 0xb8452f);
        // дим
        const [sx, sy] = P(0.36, 0, 92);
        for (let i = 0; i < 4; i++) {
          g.beginPath();
          g.arc(sx + i * 5 * r, sy - i * 6 * r, (4 + i * 2) * r, 0, Math.PI * 2);
          g.fillStyle = `rgba(220,220,220,${0.5 - i * 0.1})`;
          g.fill();
        }
        return;
      }
      case 'power_wind': {
        lot(0x8fb36a);
        const [bx, by] = P(0, 0, 0);
        g.fillStyle = '#e9edf0';
        g.beginPath();
        g.moveTo(bx - 2 * r, by);
        g.lineTo(bx - 0.8 * r, by - 80 * r);
        g.lineTo(bx + 0.8 * r, by - 80 * r);
        g.lineTo(bx + 2 * r, by);
        g.fill();
        g.strokeStyle = '#f4f6f7';
        g.lineWidth = 2.2 * r;
        const hx = bx;
        const hy = by - 80 * r;
        const a0 = h01(v, 1) * Math.PI * 2;
        for (let i = 0; i < 3; i++) {
          const a = a0 + (i * Math.PI * 2) / 3;
          g.beginPath();
          g.moveTo(hx, hy);
          g.lineTo(hx + Math.cos(a) * 30 * r, hy + Math.sin(a) * 30 * r);
          g.stroke();
        }
        g.beginPath();
        g.arc(hx, hy, 2.4 * r, 0, Math.PI * 2);
        g.fillStyle = '#d5dade';
        g.fill();
        return;
      }
      case 'water_pump': {
        lot(0xa9b0a0);
        const b: [number, number, number, number] = [-0.36, -0.1, 0.0, 0.3];
        box(g, P, b[0], b[1], b[2], b[3], 0, 12, { wall: 0xdcd8cf });
        roof(g, P, b, 12, 'gable', 0x4f6a7a, 0xdcd8cf, 6, v);
        cylinder(g, P, r, 0.18, -0.2, 0.13, 0, 30, 0x8fb3c8);
        return;
      }
      case 'sewage_plant': {
        lot(0xa29f96);
        for (const [u, w] of [
          [-0.22, -0.22],
          [0.22, -0.22],
          [-0.22, 0.22],
          [0.22, 0.22],
        ]) {
          cylinder(g, P, r, u, w, 0.16, 0, 4, 0xbdbab3);
          const [cx, cy] = P(u, w, 4);
          g.beginPath();
          g.ellipse(cx, cy, 12 * r, 6 * r, 0, 0, Math.PI * 2);
          g.fillStyle = '#6f8a6a';
          g.fill();
        }
        return;
      }
      case 'landfill': {
        lot(0x8f7f62);
        for (let i = 0; i < 5; i++) {
          const [cx, cy] = P(-0.25 + h01(v, i) * 0.5, -0.25 + h01(v, i, 1) * 0.5, 0);
          g.beginPath();
          g.ellipse(cx, cy - 4 * r, (12 + i) * r, (8 + i) * r, 0, Math.PI, 0);
          g.fillStyle = rgb(pick([0x7a6a4f, 0x8a7a5c, 0x6d6656], h01(v, i, 2)));
          g.fill();
        }
        return;
      }
      default: {
        lot(0xb5b1a8);
        const b: [number, number, number, number] = [-0.34, -0.32, 0.3, 0.3];
        box(g, P, b[0], b[1], b[2], b[3], 0, 20, { wall: 0xdedad2 });
        roof(g, P, b, 20, 'flat', 0x8c8f92, 0xdedad2, 0, v);
      }
    }
  });
}

function facilityBuilding(key: Extract<BuildingKey, { k: 'facility' }>, r: number): Sprite {
  const { f, v } = key;
  const t = (n: number) => h01(v, n);
  return makeSprite(r, 110, (g, P) => {
    const lot = (c: number) => poly(g, [P(-0.48, -0.48, 0), P(0.48, -0.48, 0), P(0.48, 0.48, 0), P(-0.48, 0.48, 0)], rgb(c));
    switch (f) {
      case 'farm':
        farmTile(g, P, r, v, 2, (c) => c);
        return;
      case 'lumber_camp': {
        lot(0x8d7a5a);
        for (let i = 0; i < 4; i++) {
          const vv = -0.35 + i * 0.12;
          box(g, P, -0.35, vv, 0.05, vv + 0.08, 0, 5, { wall: 0x8a5a36, top: 0xc49a6c, edge: false });
        }
        box(g, P, 0.1, -0.1, 0.4, 0.3, 0, 12, { wall: 0x7a5236 });
        roof(g, P, [0.1, -0.1, 0.4, 0.3], 12, 'gable', 0x4d4a47, 0x7a5236, 6, v);
        return;
      }
      case 'iron_mine':
      case 'coal_mine': {
        const coal = f === 'coal_mine';
        lot(coal ? 0x5d5852 : 0x8c6d55);
        for (let i = 0; i < 3; i++) {
          const [cx, cy] = P(-0.25 + i * 0.12, 0.2 - i * 0.05, 0);
          g.beginPath();
          g.ellipse(cx, cy, 14 * r, 7 * r, 0, Math.PI, 0);
          g.fillStyle = coal ? '#2b2b2b' : '#8a4b2e';
          g.fill();
        }
        // копър (шахтова кула)
        const [bx, by] = P(0.15, -0.2, 0);
        g.strokeStyle = '#4a4f55';
        g.lineWidth = 1.4 * r;
        g.beginPath();
        g.moveTo(bx - 10 * r, by);
        g.lineTo(bx, by - 54 * r);
        g.lineTo(bx + 10 * r, by);
        g.moveTo(bx - 6 * r, by - 20 * r);
        g.lineTo(bx + 6 * r, by - 20 * r);
        g.stroke();
        g.beginPath();
        g.arc(bx, by - 54 * r, 5 * r, 0, Math.PI * 2);
        g.stroke();
        box(g, P, 0.15, 0.05, 0.42, 0.35, 0, 12, { wall: 0x9a9690 });
        roof(g, P, [0.15, 0.05, 0.42, 0.35], 12, 'shed', 0x6f7276, 0x9a9690, 5, v);
        return;
      }
      case 'steel_mill': {
        lot(0x6f6c68);
        const b: [number, number, number, number] = [-0.44, -0.1, 0.1, 0.42];
        shadow(g, P, b[0], b[1], b[2], b[3], 34);
        box(g, P, b[0], b[1], b[2], b[3], 0, 28, { wall: 0x7d7f82 });
        roof(g, P, b, 28, 'gable', 0x5a5d61, 0x7d7f82, 8, v);
        cylinder(g, P, r, 0.26, -0.24, 0.14, 0, 56, 0x6b4a3a, 0.2);
        cylinder(g, P, r, 0.36, 0.2, 0.05, 0, 84, 0xb8452f);
        cylinder(g, P, r, 0.22, 0.32, 0.05, 0, 76, 0xcfcac2);
        return;
      }
      case 'food_plant':
      case 'factory':
      case 'machinery_plant': {
        lot(0x9a968e);
        const b: [number, number, number, number] = [-0.44, -0.36, 0.26, 0.38];
        const wall = f === 'food_plant' ? 0xe3ddd0 : f === 'factory' ? 0xb7b1a6 : 0x9fa6ab;
        shadow(g, P, b[0], b[1], b[2], b[3], 26);
        if (f === 'food_plant') {
          cylinder(g, P, r, 0.36, -0.34, 0.08, 0, 36, 0xd0d4d7);
          cylinder(g, P, r, 0.36, -0.12, 0.08, 0, 36, 0xd0d4d7);
        }
        box(g, P, b[0], b[1], b[2], b[3], 0, 20, { wall });
        for (const fc of ['left', 'right'] as Face[]) faceQuad(g, P, fc, b, 0.05, 0.95, 12, 16, rgb(0x7f97a8, fc === 'left' ? 0.95 : 0.72));
        roof(g, P, b, 20, f === 'machinery_plant' ? 'flat' : 'sawtooth', 0x8a8f94, wall, 7, v);
        if (f !== 'food_plant') cylinder(g, P, r, 0.38, 0.3, 0.05, 0, 58 + t(1) * 10, 0xa9542f);
        return;
      }
      case 'warehouse': {
        lot(0x7f8083);
        const b: [number, number, number, number] = [-0.42, -0.4, 0.3, 0.3];
        shadow(g, P, b[0], b[1], b[2], b[3], 18);
        box(g, P, b[0], b[1], b[2], b[3], 0, 18, { wall: 0xd5d2cb });
        for (let i = 0; i < 4; i++) faceQuad(g, P, 'right', b, (i + 0.2) / 4, (i + 0.8) / 4, 0, 9, rgb(0x5d6166, 0.75));
        roof(g, P, b, 18, 'flat', 0xa5a29c, 0xd5d2cb, 0, v);
        return;
      }
      case 'coal_power': {
        lot(0x7d7a74);
        cylinder(g, P, r, -0.2, -0.2, 0.22, 0, 58, 0xc8c4bc, 0.28);
        box(g, P, 0.02, -0.02, 0.42, 0.42, 0, 26, { wall: 0x9e9a92 });
        roof(g, P, [0.02, -0.02, 0.42, 0.42], 26, 'flat', 0x6c6a66, 0x9e9a92, 0, v);
        cylinder(g, P, r, 0.36, 0.04, 0.05, 26, 80, 0xb8452f);
        return;
      }
      case 'solar_farm': {
        lot(0x9fb27a);
        for (let i = 0; i < 5; i++)
          for (let j = 0; j < 2; j++) {
            const u0 = -0.44 + j * 0.46;
            const v0 = -0.44 + i * 0.18;
            poly(g, [P(u0, v0, 2), P(u0 + 0.42, v0, 2), P(u0 + 0.42, v0 + 0.12, 6), P(u0, v0 + 0.12, 6)], rgb(0x2c4a6e));
            g.strokeStyle = 'rgba(180,200,230,0.5)';
            g.lineWidth = 0.4 * r;
            const a = P(u0 + 0.21, v0, 2);
            const c = P(u0 + 0.21, v0 + 0.12, 6);
            g.beginPath();
            g.moveTo(a[0], a[1]);
            g.lineTo(c[0], c[1]);
            g.stroke();
          }
        return;
      }
      default: {
        lot(0x9a968e);
        box(g, P, -0.34, -0.32, 0.3, 0.3, 0, 18, { wall: 0xc4bdb0 });
        roof(g, P, [-0.34, -0.32, 0.3, 0.3], 18, 'flat', 0x8c8f92, 0xc4bdb0, 0, v);
      }
    }
  });
}
