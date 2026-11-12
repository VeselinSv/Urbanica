/**
 * Процедурни спрайтове на колите и пешеходците за живия слой.
 * Колите се рисуват като истински 3D обеми (каросерия, кабина със стъкла, гуми, фарове, стопове),
 * проектирани изометрично под 16 ъгъла – завоите изглеждат плавни. Всеки модел/цвят е една лента
 * от 16 кадъра в една текстура. Пешеходците имат 4 фази на ходене и 2 посоки (към/от зрителя).
 */
import { Rectangle, Texture } from 'pixi.js';

export type CarModel = 'sedan' | 'hatch' | 'suv' | 'van' | 'taxi' | 'police' | 'bus' | 'truck' | 'crew' | 'ambulance' | 'garbage' | 'plow';
export const HEADINGS = 16;

const RES = 2;
const FW = 50;
const FH = 44;
const OX = 25;
const OY = 28;

/** Дължина (в плочки) – нужна за дистанцията между колите. */
export const CAR_LEN: Record<CarModel, number> = {
  sedan: 0.3,
  hatch: 0.26,
  suv: 0.31,
  van: 0.33,
  taxi: 0.3,
  police: 0.3,
  bus: 0.62,
  truck: 0.52,
  crew: 0.34,
  ambulance: 0.35,
  garbage: 0.5,
  plow: 0.5,
};
const CAR_W: Record<CarModel, number> = {
  sedan: 0.14,
  hatch: 0.14,
  suv: 0.15,
  van: 0.15,
  taxi: 0.14,
  police: 0.14,
  bus: 0.17,
  truck: 0.16,
  crew: 0.15,
  ambulance: 0.155,
  garbage: 0.16,
  plow: 0.16,
};
/** Специални возила – с мигаща лампа на покрива. */
export const BEACON: Partial<Record<CarModel, number>> = { crew: 0xff9f1a, ambulance: 0x3b82f6, police: 0x3b82f6, plow: 0xff9f1a, garbage: 0xff9f1a };

/** Реалистична палитра – преобладават бяло, сребристо, черно и сиво. */
export const CAR_PALETTE = [
  0xf2f2ef, 0xf2f2ef, 0xb9bec4, 0xb9bec4, 0x23262b, 0x23262b, 0x5b6068, 0x1f3a5f, 0x8e1b1b, 0x5a1f2b, 0xc9b99a, 0x2f4a3a, 0x6f9bc4, 0xc75a1a,
];

type Ctx = CanvasRenderingContext2D;
type V2 = [number, number];

function rgb(c: number, k = 1, a = 1) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** Светлина отгоре-вляво: лице към +y е по-светло (0.94), към +x – по-тъмно (0.68). */
function shadeFor(nx: number, ny: number) {
  const w1 = Math.max(0, nx);
  const w2 = Math.max(0, ny);
  return (0.68 * w1 + 0.94 * w2) / Math.max(1e-6, w1 + w2);
}

type Mat = number | 'glass' | 'glassFront' | 'dark' | 'light' | 'tail';

interface Prism {
  /** Основа и връх: [a0, a1, b0, b1] в локални координати (a – напред, b – надясно), h – височина (px). */
  base: [number, number, number, number];
  top: [number, number, number, number];
  h0: number;
  h1: number;
  side: Mat | ((front: number) => Mat);
  topMat: Mat;
}

function drawCar(g: Ctx, model: CarModel, color: number, yaw: number) {
  const L = CAR_LEN[model];
  const W = CAR_W[model];
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const P = (a: number, b: number, h: number): V2 => {
    const wx = a * ca - b * sa;
    const wy = a * sa + b * ca;
    return [(wx - wy) * 32, (wx + wy) * 16 - h];
  };
  const poly = (pts: V2[], fill: string | CanvasGradient) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  const matFill = (m: Mat, shade: number, n: V2, front: number): string | CanvasGradient => {
    if (typeof m === 'number') return rgb(m, shade);
    if (m === 'glass') return rgb(mixc(0x1e2a36, 0x8fb2cc, 0.18 + 0.3 * Math.max(0, n[1])), 1);
    if (m === 'glassFront') return rgb(mixc(0x22303d, 0xa7c6dc, 0.25 + 0.35 * Math.max(0, n[1]) + 0.1 * front), 1);
    if (m === 'dark') return rgb(0x1f2226, shade);
    if (m === 'light') return rgb(0xe8e6df, shade);
    return rgb(0x9b1c17, shade);
  };
  /**
   * Материалът на лицето като градиент: лакът е по-светъл горе (отразява небето) и по-тъмен долу,
   * покривът има отблясък по диагонал, а стъклата – светла ивица от отразеното небе.
   */
  const faceFill = (m: Mat, shade: number, n: V2, front: number, pts: V2[], top = false): string | CanvasGradient => {
    const ys = pts.map((p) => p[1]);
    const xs = pts.map((p) => p[0]);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    if (typeof m === 'number') {
      if (top) {
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, rgb(m, shade * 1.02));
        gr.addColorStop(0.42, rgb(mixc(m, 0xffffff, 0.28), shade));
        gr.addColorStop(0.58, rgb(m, shade * 1.0));
        gr.addColorStop(1, rgb(m, shade * 0.86));
        return gr;
      }
      if (y1 - y0 < 0.5) return rgb(m, shade);
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, rgb(mixc(m, 0xffffff, 0.16), shade * 1.04));
      gr.addColorStop(0.45, rgb(m, shade));
      gr.addColorStop(1, rgb(m, shade * 0.7));
      return gr;
    }
    if ((m === 'glass' || m === 'glassFront') && x1 - x0 > 1) {
      const base = matFill(m, shade, n, front) as string;
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, base);
      gr.addColorStop(0.35, base);
      gr.addColorStop(0.45, 'rgba(225,238,248,0.95)');
      gr.addColorStop(0.55, base);
      gr.addColorStop(1, base);
      return gr;
    }
    return matFill(m, shade, n, front);
  };
  const prism = (p: Prism) => {
    const [a0, a1, b0, b1] = p.base;
    const [ta0, ta1, tb0, tb1] = p.top;
    const B: [number, number][] = [
      [a0, b0],
      [a1, b0],
      [a1, b1],
      [a0, b1],
    ];
    const T: [number, number][] = [
      [ta0, tb0],
      [ta1, tb0],
      [ta1, tb1],
      [ta0, tb1],
    ];
    const ca2 = (a0 + a1) / 2;
    const cb2 = (b0 + b1) / 2;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      // нормала на лицето в локални координати → в света
      const ma = (B[i][0] + B[j][0]) / 2 - ca2;
      const mb = (B[i][1] + B[j][1]) / 2 - cb2;
      const ea = B[j][0] - B[i][0];
      const eb = B[j][1] - B[i][1];
      let na = eb;
      let nb = -ea;
      if (na * ma + nb * mb < 0) {
        na = -na;
        nb = -nb;
      }
      const nl = Math.hypot(na, nb) || 1;
      na /= nl;
      nb /= nl;
      const nx = na * ca - nb * sa;
      const ny = na * sa + nb * ca;
      if (nx + ny <= 0.001) continue;
      const front = na; // +1 – предно лице, -1 – задно
      const m = typeof p.side === 'function' ? p.side(front) : p.side;
      const quad = [P(B[i][0], B[i][1], p.h0), P(B[j][0], B[j][1], p.h0), P(T[j][0], T[j][1], p.h1), P(T[i][0], T[i][1], p.h1)];
      poly(quad, faceFill(m, shadeFor(nx, ny), [nx, ny], front, quad));
    }
    const topPts = T.map(([a, b]) => P(a, b, p.h1));
    poly(topPts, faceFill(p.topMat, 1.06, [0, 0], 0, topPts, true));
  };

  // сянка (светлината е отгоре-вляво → сянката пада надясно-надолу)
  g.save();
  g.translate(2.2, 1.2);
  poly([P(-L / 2 - 0.01, -W / 2, 0), P(L / 2 + 0.01, -W / 2, 0), P(L / 2 + 0.01, W / 2, 0), P(-L / 2 - 0.01, W / 2, 0)], 'rgba(10,14,20,0.32)');
  g.restore();
  // гуми
  const wheelA = L / 2 - (model === 'bus' || model === 'truck' ? 0.08 : 0.055);
  for (const a of [-wheelA, wheelA, ...(model === 'truck' ? [-wheelA + 0.09] : [])])
    for (const b of [-W / 2 + 0.008, W / 2 - 0.008]) {
      const [x, y] = P(a, b, 1.3);
      g.fillStyle = '#121416';
      g.beginPath();
      g.ellipse(x, y, 1.7, 1.25, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#8a8f96';
      g.beginPath();
      g.ellipse(x, y, 0.7, 0.5, 0, 0, Math.PI * 2);
      g.fill();
    }

  const body = color;
  const hw = W / 2;
  const glassSides = (f: number): Mat => (f > 0.5 ? 'glassFront' : 'glass');
  const parts: Prism[] = [];
  const lightsAt: { a: number; h0: number; h1: number }[] = [];
  switch (model) {
    case 'bus': {
      parts.push({ base: [-L / 2, L / 2, -hw, hw], top: [-L / 2 + 0.005, L / 2 - 0.005, -hw + 0.004, hw - 0.004], h0: 1.6, h1: 6, side: body, topMat: body });
      parts.push({
        base: [-L / 2 + 0.005, L / 2 - 0.005, -hw + 0.004, hw - 0.004],
        top: [-L / 2 + 0.008, L / 2 - 0.012, -hw + 0.006, hw - 0.006],
        h0: 6,
        h1: 10.6,
        side: (f) => (f < -0.5 ? body : glassSides(f)),
        topMat: body,
      });
      parts.push({
        base: [-L / 2 + 0.008, L / 2 - 0.012, -hw + 0.006, hw - 0.006],
        top: [-L / 2 + 0.01, L / 2 - 0.014, -hw + 0.008, hw - 0.008],
        h0: 10.6,
        h1: 12,
        side: body,
        topMat: 0xd9dcdf,
      });
      parts.push({ base: [-0.12, 0.02, -0.04, 0.04], top: [-0.115, 0.015, -0.035, 0.035], h0: 12, h1: 13.4, side: 'light', topMat: 'light' });
      lightsAt.push({ a: L / 2, h0: 2.6, h1: 3.8 });
      break;
    }
    case 'truck':
    case 'garbage':
    case 'plow': {
      const cab0 = L / 2 - 0.12;
      const cargo: Mat = model === 'truck' ? 'light' : model === 'garbage' ? 0x2e7d4f : 0x4a4f57;
      parts.push({ base: [-L / 2, L / 2, -hw * 0.7, hw * 0.7], top: [-L / 2, L / 2, -hw * 0.7, hw * 0.7], h0: 1, h1: 2.4, side: 'dark', topMat: 'dark' });
      parts.push({
        base: [-L / 2, cab0 - 0.02, -hw, hw],
        top: [-L / 2 + (model === 'plow' ? 0.03 : 0), cab0 - 0.02, -hw + (model === 'plow' ? 0.02 : 0), hw - (model === 'plow' ? 0.02 : 0)],
        h0: 2.4,
        h1: model === 'plow' ? 7 : 11.5,
        side: cargo,
        topMat: model === 'plow' ? 0xd8d4c8 : cargo,
      });
      // гребло на снегорина
      if (model === 'plow')
        parts.push({
          base: [L / 2 + 0.01, L / 2 + 0.05, -hw - 0.03, hw + 0.03],
          top: [L / 2 + 0.02, L / 2 + 0.05, -hw - 0.03, hw + 0.03],
          h0: 0.5,
          h1: 4,
          side: 0xf59e0b,
          topMat: 0xf59e0b,
        });
      parts.push({ base: [cab0, L / 2, -hw, hw], top: [cab0, L / 2 - 0.02, -hw + 0.004, hw - 0.004], h0: 1.6, h1: 5.6, side: body, topMat: body });
      parts.push({
        base: [cab0, L / 2 - 0.02, -hw + 0.004, hw - 0.004],
        top: [cab0 + 0.005, L / 2 - 0.04, -hw + 0.01, hw - 0.01],
        h0: 5.6,
        h1: 9.4,
        side: (f) => (f > 0.5 ? 'glassFront' : body),
        topMat: body,
      });
      lightsAt.push({ a: L / 2, h0: 2.4, h1: 3.4 });
      break;
    }
    case 'van':
    case 'crew':
    case 'ambulance': {
      parts.push({ base: [-L / 2, L / 2, -hw, hw], top: [-L / 2 + 0.004, L / 2 - 0.03, -hw + 0.003, hw - 0.003], h0: 1.4, h1: 5.2, side: body, topMat: body });
      parts.push({
        base: [-L / 2 + 0.004, L / 2 - 0.03, -hw + 0.003, hw - 0.003],
        top: [-L / 2 + 0.008, L / 2 - 0.085, -hw + 0.01, hw - 0.01],
        h0: 5.2,
        h1: 10.4,
        side: (f) => (f > 0.5 ? 'glassFront' : body),
        topMat: body,
      });
      if (model === 'ambulance')
        parts.push({
          base: [-L / 2 + 0.01, L / 2 - 0.09, -hw + 0.01, hw - 0.01],
          top: [-L / 2 + 0.01, L / 2 - 0.09, -hw + 0.01, hw - 0.01],
          h0: 3.4,
          h1: 4.4,
          side: 0xd62828,
          topMat: 0xd62828,
        });
      if (model === 'crew' || model === 'ambulance') {
        const bar = model === 'crew' ? 0xff9f1a : 0x3b82f6;
        parts.push({ base: [0.02, 0.06, -0.045, 0.045], top: [0.022, 0.058, -0.04, 0.04], h0: 10.4, h1: 11.8, side: bar, topMat: bar });
      }
      lightsAt.push({ a: L / 2, h0: 2.6, h1: 3.8 });
      break;
    }
    default: {
      const suv = model === 'suv';
      const hatch = model === 'hatch';
      const hb = suv ? 5.6 : 4.5;
      const hc = suv ? 9.6 : hatch ? 8 : 7.6;
      parts.push({ base: [-L / 2, L / 2, -hw, hw], top: [-L / 2 + 0.01, L / 2 - 0.012, -hw + 0.008, hw - 0.008], h0: 1.3, h1: hb, side: body, topMat: body });
      const c0 = hatch ? -L / 2 + 0.012 : suv ? -L / 2 + 0.02 : -0.085;
      const c1 = hatch ? 0.05 : suv ? 0.07 : 0.07;
      const t0 = hatch ? -L / 2 + 0.02 : suv ? -L / 2 + 0.025 : -0.06;
      const t1 = hatch ? 0.015 : suv ? 0.035 : 0.03;
      parts.push({ base: [c0, c1, -hw + 0.012, hw - 0.012], top: [t0, t1, -hw + 0.027, hw - 0.027], h0: hb, h1: hc, side: glassSides, topMat: body });
      if (model === 'taxi')
        parts.push({ base: [-0.02, 0.015, -0.026, 0.026], top: [-0.016, 0.011, -0.022, 0.022], h0: hc, h1: hc + 1.8, side: 0xfafafa, topMat: 0xf4d03f });
      if (model === 'police') {
        parts.push({ base: [-0.015, 0.012, -0.045, 0], top: [-0.015, 0.012, -0.045, 0], h0: hc, h1: hc + 1.3, side: 0xd62828, topMat: 0xff4d4d });
        parts.push({ base: [-0.015, 0.012, 0, 0.045], top: [-0.015, 0.012, 0, 0.045], h0: hc, h1: hc + 1.3, side: 0x1f5fd6, topMat: 0x4d8dff });
      }
      lightsAt.push({ a: L / 2, h0: 2.4, h1: 3.4 });
    }
  }
  // ред на рисуване: частите една върху друга – отдолу нагоре; съседните – отзад напред (по дълбочина)
  const depth = (p: Prism) => {
    const a = (p.base[0] + p.base[1]) / 2;
    const b = (p.base[2] + p.base[3]) / 2;
    return a * ca - b * sa + (a * sa + b * ca);
  };
  const before = (p: Prism, q: Prism) => {
    if (p.h1 <= q.h0 + 0.01) return true;
    if (q.h1 <= p.h0 + 0.01) return false;
    return depth(p) < depth(q);
  };
  for (let i = 0; i < parts.length; i++)
    for (let j = 0; j < parts.length - 1 - i; j++)
      if (!before(parts[j], parts[j + 1]) && before(parts[j + 1], parts[j])) [parts[j], parts[j + 1]] = [parts[j + 1], parts[j]];
  for (const p of parts) prism(p);

  // фарове и стопове (само ако лицето се вижда)
  const fx = ca;
  const fy = sa;
  const frontVis = fx + fy > 0.05;
  const backVis = -fx - fy > 0.05;
  for (const side of [-1, 1]) {
    const b0 = side * (W / 2 - 0.035);
    const b1 = side * (W / 2 - 0.012);
    if (frontVis) {
      const { a, h0, h1 } = lightsAt[0];
      poly([P(a + 0.001, b0, h0), P(a + 0.001, b1, h0), P(a + 0.001, b1, h1), P(a + 0.001, b0, h1)], '#fff5c8');
    }
    if (backVis) {
      const a = -L / 2 - 0.001;
      poly([P(a, b0, 2.6), P(a, b1, 2.6), P(a, b1, 3.8), P(a, b0, 3.8)], '#c0261c');
    }
  }
  // отблясък по горния ръб на покрива
  const top = parts[parts.length - 1];
  if (top) {
    const [ta0, ta1, , tb1] = top.top;
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 0.5;
    g.beginPath();
    const a = P(ta0, tb1, top.h1);
    const b = P(ta1, tb1, top.h1);
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
  }
}

function mixc(a: number, b: number, t: number) {
  const k = Math.max(0, Math.min(1, t));
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const carCache = new Map<string, Texture[]>();

/** 16 кадъра (по ъгъл) за модел и цвят. Котва: (OX/FW, OY/FH) – центърът на колата на земята. */
export function carFrames(model: CarModel, color: number): Texture[] {
  const key = `${model}|${color}`;
  const hit = carCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = FW * RES * HEADINGS;
  c.height = FH * RES;
  const g = c.getContext('2d')!;
  for (let i = 0; i < HEADINGS; i++) {
    g.setTransform(RES, 0, 0, RES, (i * FW + OX) * RES, OY * RES);
    drawCar(g, model, color, (i / HEADINGS) * Math.PI * 2);
  }
  const base = Texture.from(c);
  const frames: Texture[] = [];
  for (let i = 0; i < HEADINGS; i++) frames.push(new Texture({ source: base.source, frame: new Rectangle(i * FW * RES, 0, FW * RES, FH * RES) }));
  carCache.set(key, frames);
  return frames;
}

export const CAR_ANCHOR = { x: OX / FW, y: OY / FH, scale: 1 / RES };

/** Индекс на кадъра по посоката на движение (в света). */
export function headingFrame(hx: number, hy: number) {
  const a = Math.atan2(hy, hx);
  return ((Math.round((a / (Math.PI * 2)) * HEADINGS) % HEADINGS) + HEADINGS) % HEADINGS;
}

// ------------------------------------------------------------------ пешеходци
const PRES = 3;
const PW = 12;
const PH = 18;
const POX = 6;
const POY = 15;
const SHIRTS = [0xc0392b, 0x2471a3, 0xf2f2ef, 0x1e8449, 0xf1c40f, 0x8e44ad, 0xe67e22, 0x34495e, 0xd35d8a, 0x16a085, 0x7f8c8d];
const PANTS = [0x2c3e50, 0x1b2631, 0x5d6d7e, 0x34495e, 0x6e5845, 0x283747];
const SKIN = [0xf1c6a8, 0xe0ac87, 0xc68863, 0x8d5a3b];
const HAIR = [0x2b1d16, 0x4a3122, 0x8a5a2b, 0xd8b26a, 0x1a1a1a, 0xb8b8b8];

function drawPerson(g: Ctx, v: number, away: boolean, phase: number) {
  const shirt = SHIRTS[v % SHIRTS.length];
  const pants = PANTS[(v >>> 2) % PANTS.length];
  const skin = SKIN[(v >>> 4) % SKIN.length];
  const hair = HAIR[(v >>> 6) % HAIR.length];
  const dress = (v >>> 9) % 4 === 0;
  const swing = [0, 0.75, 0, -0.75][phase];
  const bob = phase % 2 === 0 ? 0 : -0.15;
  // сянка
  g.fillStyle = 'rgba(10,14,20,0.32)';
  g.beginPath();
  g.ellipse(0.7, 0.2, 1.8, 0.7, 0, 0, Math.PI * 2);
  g.fill();
  // крака
  g.strokeStyle = rgb(pants);
  g.lineCap = 'round';
  g.lineWidth = 0.75;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 0.35, -3 + bob);
    g.lineTo(s * 0.35 + s * swing * 0.9, 0);
    g.stroke();
  }
  // тяло (рокля или риза)
  const tg = g.createLinearGradient(-1.1, 0, 1.1, 0);
  tg.addColorStop(0, rgb(shirt, 1.12));
  tg.addColorStop(1, rgb(shirt, 0.72));
  g.fillStyle = tg;
  g.beginPath();
  if (dress) {
    g.moveTo(-0.85, -5.6 + bob);
    g.lineTo(0.85, -5.6 + bob);
    g.lineTo(1.25, -2.4 + bob);
    g.lineTo(-1.25, -2.4 + bob);
  } else {
    g.moveTo(-0.95, -5.6 + bob);
    g.lineTo(0.95, -5.6 + bob);
    g.lineTo(0.85, -2.9 + bob);
    g.lineTo(-0.85, -2.9 + bob);
  }
  g.closePath();
  g.fill();
  // ръце
  g.strokeStyle = rgb(shirt, 0.85);
  g.lineWidth = 0.55;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 0.95, -5.3 + bob);
    g.lineTo(s * 1.15 - s * swing * 0.7, -3.3 + bob);
    g.stroke();
  }
  // глава
  g.fillStyle = rgb(skin);
  g.beginPath();
  g.arc(0, -6.6 + bob, 0.95, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = rgb(hair);
  g.beginPath();
  if (away) g.arc(0, -6.6 + bob, 1, 0, Math.PI * 2);
  else g.arc(0, -6.85 + bob, 0.98, Math.PI * 1.05, Math.PI * 1.95);
  g.fill();
}

const pedCache = new Map<number, Texture[]>();
export const PED_VARIANTS = 64;

/** 8 кадъра: 0..3 – към зрителя (фази на ходене), 4..7 – с гръб. Огледално обръщане – чрез scale.x. */
export function personFrames(v: number): Texture[] {
  const hit = pedCache.get(v);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = PW * PRES * 8;
  c.height = PH * PRES;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.setTransform(PRES, 0, 0, PRES, (i * PW + POX) * PRES, POY * PRES);
    drawPerson(g, Math.imul(v + 1, 2654435761) >>> 0, i >= 4, i % 4);
  }
  const base = Texture.from(c);
  const frames: Texture[] = [];
  for (let i = 0; i < 8; i++) frames.push(new Texture({ source: base.source, frame: new Rectangle(i * PW * PRES, 0, PW * PRES, PH * PRES) }));
  pedCache.set(v, frames);
  return frames;
}

export const PED_ANCHOR = { x: POX / PW, y: POY / PH, scale: 1 / PRES };
