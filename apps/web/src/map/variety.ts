/**
 * Разнообразни градски сгради: 10 материала × 10 форми, избрани „на случаен принцип“ (детерминирано по
 * плочката), така че никои две съседни сгради не изглеждат еднакво. Използва се за офиси, търговски центрове,
 * високи жилищни сгради и за обединените групи (2 и 4 парцела).
 */
import { FLOOR, h01, mixc, rgb } from './sprites';
type Ctx = CanvasRenderingContext2D;
import { drawSmoothCar, type SmoothModel } from './carmodel';

export type B4 = [number, number, number, number];
type P3 = (u: number, v: number, h: number) => [number, number];
type Face = 'left' | 'right';

/** Помощните функции за рисуване идват от sprites.ts (за да няма цикличен импорт). */
export interface Kit {
  box: (g: Ctx, P: P3, u0: number, v0: number, u1: number, v1: number, z0: number, z1: number, s: { wall: number; top?: number; edge?: boolean }) => void;
  faceQuad: (g: Ctx, P: P3, face: Face, b: B4, s0: number, s1: number, z0: number, z1: number, fill: string | CanvasGradient) => void;
  windows: (g: Ctx, P: P3, r: number, b: B4, z0: number, z1: number, ws: Record<string, unknown> & { glass: number; seed: number }) => void;
  shadow: (g: Ctx, P: P3, u0: number, v0: number, u1: number, v1: number, h: number) => void;
  poly: (g: Ctx, pts: (readonly [number, number])[], fill: string | CanvasGradient) => void;
  line: (g: Ctx, a: readonly [number, number], b: readonly [number, number], color: string, w: number) => void;
  cylinder: (g: Ctx, P: P3, r: number, u: number, v: number, rad: number, z0: number, z1: number, color: number) => void;
  tree: (g: Ctx, P: P3, r: number, u: number, v: number, seed: number, size: number) => void;
}

export interface Material {
  name: string;
  wall: number;
  kind: 'plaster' | 'brick' | 'concrete' | 'glass' | 'wood' | 'stone' | 'metal';
  glass: number;
  frame?: number;
  accent?: number;
}

/** 10 материала на фасадите. */
export const MATERIALS: Material[] = [
  { name: 'бяла мазилка', wall: 0xf1ece2, kind: 'plaster', glass: 0x6f8aa0, frame: 0xffffff },
  { name: 'пясъчник', wall: 0xd9c09a, kind: 'stone', glass: 0x6a8296, frame: 0xeadcc0 },
  { name: 'червени тухли', wall: 0xa65b3f, kind: 'brick', glass: 0x5f7d92, frame: 0xf3eee4 },
  { name: 'жълти тухли', wall: 0xcfae6c, kind: 'brick', glass: 0x5f7d92, frame: 0xffffff },
  { name: 'бетон', wall: 0xaaa9a4, kind: 'concrete', glass: 0x5d7486 },
  { name: 'тъмно стъкло', wall: 0x3f4a55, kind: 'glass', glass: 0x2f4b63 },
  { name: 'синьо стъкло', wall: 0xb9c3cc, kind: 'glass', glass: 0x5d8fb8 },
  { name: 'дърво', wall: 0xb27c4e, kind: 'wood', glass: 0x52697a },
  { name: 'травертин', wall: 0xe6dcc6, kind: 'stone', glass: 0x557089, frame: 0xd5c8ad },
  { name: 'метални панели', wall: 0x8e99a5, kind: 'metal', glass: 0x4f6b82, accent: 0xd35400 },
];

export const SHAPE_NAMES = ['кутия', 'стъпаловидна', 'Г-образна', 'П-образна', 'близнаци', 'кула на подиум', 'кръгла', 'терасовидна', 'пластина с крило', 'конзола'];

/** Обем с фасада от избрания материал и плосък покрив с парапет. */
function mass(K: Kit, g: Ctx, P: P3, r: number, b: B4, z0: number, z1: number, m: Material, seed: number, dim: (c: number) => number, roofTop = true) {
  const wall = dim(m.wall);
  K.box(g, P, b[0], b[1], b[2], b[3], z0, z1, { wall });
  const detail = r >= 0.55;
  const faces: Face[] = ['left', 'right'];
  switch (m.kind) {
    case 'glass':
      K.windows(g, P, r, b, z0, z1, { glass: dim(m.glass), band: true, seed });
      break;
    case 'brick':
      if (detail) for (const f of faces) for (let z = z0 + 1.6; z < z1; z += 1.8) K.faceQuad(g, P, f, b, 0, 1, z, z + 0.25, 'rgba(60,30,20,0.12)');
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: m.frame, density: 5, w: 0.45, hgt: 0.6, seed, lit: 0.12 });
      break;
    case 'concrete':
      if (detail)
        for (const f of faces) {
          for (let z = z0 + FLOOR; z < z1; z += FLOOR) K.faceQuad(g, P, f, b, 0, 1, z - 0.3, z + 0.3, 'rgba(0,0,0,0.12)');
          for (let i = 1; i < 4; i++) K.faceQuad(g, P, f, b, i / 4 - 0.003, i / 4 + 0.003, z0, z1, 'rgba(0,0,0,0.1)');
        }
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: 0x8f8e89, density: 8, w: 0.85, hgt: 0.42, seed, lit: 0.1 });
      break;
    case 'wood':
      if (detail) for (const f of faces) for (let i = 1; i < 30; i++) K.faceQuad(g, P, f, b, i / 30 - 0.002, i / 30 + 0.002, z0, z1, 'rgba(40,20,5,0.16)');
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: 0x3b3f44, density: 4, w: 0.55, hgt: 0.72, seed, lit: 0.12 });
      break;
    case 'stone':
      if (detail) for (const f of faces) for (let i = 0; i <= 5; i++) K.faceQuad(g, P, f, b, i / 5 - 0.012, i / 5 + 0.012, z0, z1, rgb(mixc(wall, 0xffffff, 0.25), f === 'left' ? 1 : 0.72));
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: m.frame, density: 5, w: 0.4, hgt: 0.62, seed, lit: 0.14 });
      // корниз
      K.box(g, P, b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02, z1 - 1.2, z1, { wall: mixc(wall, 0xffffff, 0.3), edge: false });
      break;
    case 'metal':
      if (detail) for (const f of faces) for (let z = z0; z < z1; z += FLOOR) K.faceQuad(g, P, f, b, 0, 1, z, z + FLOOR * 0.35, rgb(mixc(wall, 0x2b3036, 0.25), f === 'left' ? 1 : 0.75));
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: 0x5d656e, density: 9, w: 0.92, hgt: 0.45, seed, lit: 0.1 });
      if (m.accent) for (const f of faces) K.faceQuad(g, P, f, b, 0, 1, z1 - 3, z1 - 1.5, rgb(m.accent, f === 'left' ? 1 : 0.75));
      break;
    default:
      K.windows(g, P, r, b, z0, z1, { glass: m.glass, frame: m.frame, density: 6, w: 0.48, seed, lit: 0.14, balcony: h01(seed, 5) < 0.4 ? 0.3 : 0 });
  }
  if (!roofTop) return;
  // плосък покрив: парапет, малко по-тъмна настилка, климатици/шахти
  const roofC = dim(mixc(wall, 0x6f6c68, 0.55));
  K.poly(g, [P(b[0] + 0.02, b[1] + 0.02, z1), P(b[2] - 0.02, b[1] + 0.02, z1), P(b[2] - 0.02, b[3] - 0.02, z1), P(b[0] + 0.02, b[3] - 0.02, z1)], rgb(roofC, 1.05));
  const w = b[2] - b[0];
  const d = b[3] - b[1];
  if (w > 0.2 && d > 0.2) {
    for (let i = 0; i < 2; i++) {
      const u = b[0] + w * (0.2 + 0.45 * h01(seed, i, 61));
      const v = b[1] + d * (0.2 + 0.45 * h01(seed, i, 62));
      K.box(g, P, u, v, u + Math.min(0.1, w * 0.2), v + Math.min(0.08, d * 0.2), z1, z1 + 3 + h01(seed, i, 63) * 3, { wall: 0xc9ccd0, edge: false });
    }
  }
}

/** Вход с козирка на лицевата страна. */
function entrance(K: Kit, g: Ctx, P: P3, b: B4, face: Face) {
  K.faceQuad(g, P, face, b, 0.38, 0.62, 0, 9, rgb(0x2c3e50, face === 'left' ? 0.95 : 0.72));
  K.faceQuad(g, P, face, b, 0.42, 0.58, 0.5, 8, rgb(0x9fc3da, face === 'left' ? 0.9 : 0.65));
  const [u0, v0, u1, v1] = b;
  if (face === 'left') K.box(g, P, u0 + (u1 - u0) * 0.34, v1, u0 + (u1 - u0) * 0.66, v1 + 0.08, 9, 10.2, { wall: 0xe3e5e8, edge: false });
  else K.box(g, P, u1, v0 + (v1 - v0) * 0.34, u1 + 0.08, v0 + (v1 - v0) * 0.66, 9, 10.2, { wall: 0xe3e5e8, edge: false });
}

const inset = (b: B4, k: number): B4 => {
  const du = (b[2] - b[0]) * k;
  const dv = (b[3] - b[1]) * k;
  return [b[0] + du, b[1] + dv, b[2] - du, b[3] - dv];
};

/**
 * Сграда с една от 10-те форми и един от 10-те материала. b – отпечатък (в плочки, центърът е 0,0), H – височина.
 * shape/material: 0..9 (по подразбиране – по семето).
 */
export function variedBuilding(
  K: Kit,
  g: Ctx,
  P: P3,
  r: number,
  o: { b: B4; H: number; seed: number; face: Face; dim: (c: number) => number; shape?: number; material?: number; plaza?: boolean },
) {
  const { b, seed, face, dim } = o;
  const H = Math.max(FLOOR * 2, Math.round(o.H / FLOOR) * FLOOR);
  const shape = o.shape ?? Math.floor(h01(seed, 101) * 10);
  const m = MATERIALS[o.material ?? Math.floor(h01(seed, 102) * 10)];
  const m2 = MATERIALS[(MATERIALS.indexOf(m) + 3 + Math.floor(h01(seed, 103) * 4)) % 10];
  const W = b[2] - b[0];
  const D = b[3] - b[1];
  const fl = (x: number) => Math.max(FLOOR, Math.round(x / FLOOR) * FLOOR);
  // площад/тротоар около сградата
  if (o.plaza !== false) {
    const pad = 0.06;
    K.poly(g, [P(b[0] - pad, b[1] - pad, 0), P(b[2] + pad, b[1] - pad, 0), P(b[2] + pad, b[3] + pad, 0), P(b[0] - pad, b[3] + pad, 0)], rgb(dim(0xcfc9bd)));
  }
  K.shadow(g, P, b[0], b[1], b[2], b[3], H);
  type Part = { b: B4; z0: number; z1: number; m: Material };
  const parts: Part[] = [];
  switch (shape) {
    case 1: {
      // стъпаловидна
      parts.push({ b, z0: 0, z1: fl(H * 0.5), m });
      parts.push({ b: inset(b, 0.12), z0: fl(H * 0.5), z1: fl(H * 0.8), m });
      parts.push({ b: inset(b, 0.24), z0: fl(H * 0.8), z1: H, m });
      break;
    }
    case 2: {
      // Г-образна: висок основен корпус + по-ниско крило отзад вдясно
      parts.push({ b: [b[0] + W * 0.55, b[1], b[2], b[1] + D * 0.5], z0: 0, z1: fl(H * 0.55), m: m2 });
      parts.push({ b: [b[0], b[1], b[0] + W * 0.55, b[3]], z0: 0, z1: H, m });
      break;
    }
    case 3: {
      // П-образна: задно крило + две странични, отворен двор отпред
      const h = fl(H * 0.7);
      parts.push({ b: [b[0], b[1], b[2], b[1] + D * 0.35], z0: 0, z1: h, m });
      parts.push({ b: [b[2] - W * 0.3, b[1] + D * 0.35, b[2], b[3]], z0: 0, z1: h, m });
      parts.push({ b: [b[0], b[1] + D * 0.35, b[0] + W * 0.3, b[3]], z0: 0, z1: h, m });
      K.poly(g, [P(b[0] + W * 0.3, b[1] + D * 0.35, 0.3), P(b[2] - W * 0.3, b[1] + D * 0.35, 0.3), P(b[2] - W * 0.3, b[3], 0.3), P(b[0] + W * 0.3, b[3], 0.3)], rgb(dim(0x7aa556)));
      break;
    }
    case 4: {
      // близнаци на общ подиум
      const pod = fl(Math.min(H * 0.2, FLOOR * 2));
      parts.push({ b, z0: 0, z1: pod, m: m2 });
      const gap = W * 0.12;
      parts.push({ b: [b[0] + W * 0.05, b[1] + D * 0.15, b[0] + (W - gap) / 2, b[3] - D * 0.15], z0: pod, z1: H, m });
      parts.push({ b: [b[0] + (W + gap) / 2, b[1] + D * 0.15, b[2] - W * 0.05, b[3] - D * 0.15], z0: pod, z1: fl(H * 0.82), m });
      break;
    }
    case 5: {
      // тънка кула на широк подиум
      const pod = fl(Math.min(H * 0.25, FLOOR * 3));
      parts.push({ b, z0: 0, z1: pod, m: m2 });
      parts.push({ b: inset(b, 0.27), z0: pod, z1: H, m });
      break;
    }
    case 6: {
      // кръгла: цилиндър с ленти (стена/стъкло) по етажи
      const rad = Math.min(W, D) * 0.45;
      const cu = (b[0] + b[2]) / 2;
      const cv = (b[1] + b[3]) / 2;
      for (let z = 0; z < H; z += FLOOR) {
        K.cylinder(g, P, r, cu, cv, rad, z, z + FLOOR * 0.38, dim(m.kind === 'glass' ? 0xd5dbe0 : m.wall));
        K.cylinder(g, P, r, cu, cv, rad * 0.97, z + FLOOR * 0.38, z + FLOOR, dim(mixc(m.glass, 0x9fc3da, 0.3)));
      }
      K.cylinder(g, P, r, cu, cv, rad * 1.02, H, H + 1.5, dim(0xd8dade));
      return;
    }
    case 7: {
      // терасовидна: по-ниско отпред, по-високо отзад (зелени тераси)
      const steps = 3;
      for (let i = 0; i < steps; i++) {
        const vb: B4 = [b[0], b[1] + (D * i) / steps, b[2], b[1] + (D * (i + 1)) / steps];
        parts.push({ b: vb, z0: 0, z1: fl(H * (1 - i * 0.28)), m });
      }
      break;
    }
    case 8: {
      // висока пластина отзад + ниско широко крило отпред
      parts.push({ b: [b[0], b[1], b[2], b[1] + D * 0.45], z0: 0, z1: H, m });
      parts.push({ b: [b[0] + W * 0.08, b[1] + D * 0.5, b[2] - W * 0.08, b[3]], z0: 0, z1: fl(Math.max(FLOOR * 2, H * 0.22)), m: m2 });
      break;
    }
    case 9: {
      // конзола: тесен долен корпус, горната част е по-широка и надвиснала
      const z = fl(H * 0.45);
      parts.push({ b: inset(b, 0.16), z0: 0, z1: z, m: m2 });
      parts.push({ b, z0: z, z1: H, m });
      break;
    }
    default:
      parts.push({ b, z0: 0, z1: H, m });
  }
  // отзад напред (по-малко u+v първо), отдолу нагоре
  parts.sort((a, c) => a.b[2] + a.b[3] - (c.b[2] + c.b[3]) || a.z0 - c.z0);
  for (const [i, p] of parts.entries()) mass(K, g, P, r, p.b, p.z0, p.z1, p.m, seed + i * 7, dim);
  const front = parts.reduce((a, p) => (p.z0 === 0 && p.b[2] + p.b[3] > a.b[2] + a.b[3] ? p : a), parts[0]);
  entrance(K, g, P, front.b, face);
  if (o.plaza !== false) dressing(K, g, P, r, b, seed, face);
  // антена или хеликоптерна площадка на високите
  if (H > 110) {
    const top = parts.reduce((a, p) => (p.z1 > a.z1 ? p : a), parts[0]);
    const cu = (top.b[0] + top.b[2]) / 2;
    const cv = (top.b[1] + top.b[3]) / 2;
    if (h01(seed, 104) < 0.5) K.line(g, P(cu, cv, top.z1), P(cu, cv, top.z1 + 22), '#9aa0a6', 1.1 * r);
    else {
      const [x, y] = P(cu, cv, top.z1 + 0.2);
      g.beginPath();
      g.ellipse(x, y, 7 * r, 3.5 * r, 0, 0, Math.PI * 2);
      g.strokeStyle = '#f2f2f2';
      g.lineWidth = 0.8 * r;
      g.stroke();
    }
  }
}

/**
 * Озеленяване на площада пред сградата: дърво в предния ъгъл, саксии с цветя и пейка покрай лицевата
 * стена, велостойка – сградите не стоят на голо, а в оформено пространство (като парка).
 */
export function dressing(K: Kit, g: Ctx, P: P3, r: number, b: B4, seed: number, face: Face) {
  const fu = b[2] + 0.07;
  const fv = b[3] + 0.07;
  // саксии с храсти покрай лицевата стена
  for (let i = 0; i < 3; i++) {
    const s = 0.15 + i * 0.35;
    const [u, v] = face === 'left' ? [b[0] + (b[2] - b[0]) * s, fv - 0.02] : [fu - 0.02, b[1] + (b[3] - b[1]) * s];
    if (Math.abs(s - 0.5) < 0.12) continue; // входът
    K.box(g, P, u - 0.03, v - 0.02, u + 0.03, v + 0.02, 0, 2.2, { wall: 0x9c9890, edge: false });
    const [x, y] = P(u, v, 3.2);
    g.fillStyle = rgb(h01(seed, i, 111) < 0.5 ? 0x5d8f3e : 0x6f9a4a);
    g.beginPath();
    g.ellipse(x, y, 2.6 * r, 1.8 * r, 0, 0, Math.PI * 2);
    g.fill();
    if (h01(seed, i, 112) < 0.6) {
      g.fillStyle = rgb([0xe8505b, 0xf2c94c, 0xb56be0][i % 3]);
      g.beginPath();
      g.arc(x + 0.8 * r, y - 0.6 * r, 0.8 * r, 0, Math.PI * 2);
      g.fill();
    }
  }
  // пейка
  const [bu, bv] = face === 'left' ? [b[0] + (b[2] - b[0]) * 0.32, fv + 0.02] : [fu + 0.02, b[1] + (b[3] - b[1]) * 0.32];
  K.box(g, P, bu - 0.05, bv - 0.012, bu + 0.05, bv + 0.012, 1, 2, { wall: 0x8b5e3c, edge: false });
  // дърво в предния ъгъл
  K.tree(g, P, r, Math.min(0.45, fu), Math.min(0.45, fv), seed + 5, 0.75 + h01(seed, 113) * 0.25);
}

// ------------------------------------------------------------------ паркинг с истински коли
const PARKED: SmoothModel[] = ['sedan', 'hatch', 'suv', 'sedan', 'hatch', 'van', 'sedan', 'suv'];
const CAR_COLORS = [0xc0392b, 0xecf0f1, 0x2c3e50, 0x2471a3, 0x7f8c8d, 0xf1c40f, 0x1e8449, 0xd5d8dc, 0x111418, 0x8e44ad, 0xa04000];

/** Паркирана кола (гладкият модел) в точка (u,v) – yaw 0 = по оста u. */
export function parkedCar(g: Ctx, P: P3, r: number, u: number, v: number, yaw: number, seed: number, model?: SmoothModel, color?: number) {
  const [x, y] = P(u, v, 0);
  g.save();
  g.translate(x, y);
  g.scale(r * 0.78, r * 0.78);
  drawSmoothCar(g, model ?? PARKED[Math.floor(h01(seed, 71) * PARKED.length)], color ?? CAR_COLORS[Math.floor(h01(seed, 72) * CAR_COLORS.length)], yaw);
  g.restore();
}

/**
 * Паркинг: асфалт до ръба на плочката (съседните паркинги се сливат), два реда места с бели линии,
 * алея по средата и паркирани коли (с празни места на случаен принцип), островчета с дървета в краищата.
 */
export function parkingLot(K: Kit, g: Ctx, P: P3, r: number, b: B4, seed: number, fill = 0.72, alongU = true) {
  const [u0, v0, u1, v1] = b;
  K.poly(g, [P(u0, v0, 0), P(u1, v0, 0), P(u1, v1, 0), P(u0, v1, 0)], rgb(0x5f6266));
  // редове: по дължина на u (колите стоят по v)
  const rows = alongU ? [v0 + (v1 - v0) * 0.04, v0 + (v1 - v0) * 0.62] : [u0 + (u1 - u0) * 0.04, u0 + (u1 - u0) * 0.62];
  const len = alongU ? u1 - u0 : v1 - v0;
  const depth = (alongU ? v1 - v0 : u1 - u0) * 0.34;
  const n = Math.max(3, Math.round(len / 0.13));
  for (const [ri, a0] of rows.entries()) {
    for (let i = 0; i <= n; i++) {
      const s = (alongU ? u0 : v0) + (len * i) / n;
      const p0 = alongU ? P(s, a0, 0.05) : P(a0, s, 0.05);
      const p1 = alongU ? P(s, a0 + depth, 0.05) : P(a0 + depth, s, 0.05);
      K.line(g, p0, p1, 'rgba(255,255,255,0.75)', 0.5 * r);
    }
    for (let i = 0; i < n; i++) {
      if (h01(seed, ri, i, 73) > fill) continue;
      const s = (alongU ? u0 : v0) + (len * (i + 0.5)) / n;
      const c = a0 + depth * 0.5;
      // колите са с муцуната към алеята (по оста, перпендикулярна на реда)
      const yaw = alongU ? (ri === 0 ? Math.PI / 2 : -Math.PI / 2) : ri === 0 ? 0 : Math.PI;
      if (alongU) parkedCar(g, P, r, s, c, yaw, seed * 31 + ri * 97 + i);
      else parkedCar(g, P, r, c, s, yaw, seed * 31 + ri * 97 + i);
    }
  }
  // стрелки на алеята
  const mid = (rows[0] + depth + rows[1]) / 2;
  for (let i = 1; i < 3; i++) {
    const s = (alongU ? u0 : v0) + (len * i) / 3;
    const a = alongU ? P(s - 0.04, mid, 0.06) : P(mid, s - 0.04, 0.06);
    const c = alongU ? P(s + 0.04, mid, 0.06) : P(mid, s + 0.04, 0.06);
    K.line(g, a, c, 'rgba(255,255,255,0.55)', 0.7 * r);
  }
}

// ------------------------------------------------------------------ обединени паркове
/**
 * Парк върху група плочки (1, 2 или 4): моравата стига до ръба (съседните паркове се сливат), лъкатушни алеи,
 * езерце с мостче в голям парк, детска площадка, пейки, цветни лехи и много дървета.
 */
export function bigPark(K: Kit, g: Ctx, P: P3, r: number, su: number, sv: number, seed: number, winter: boolean) {
  const lawn = winter ? 0xe8edf0 : 0x79aa52;
  K.poly(g, [P(-su, -sv, 0), P(su, -sv, 0), P(su, sv, 0), P(-su, sv, 0)], rgb(lawn));
  // ивици от косене
  if (!winter)
    for (let i = 0; i < 8; i++) {
      const a = -sv + (2 * sv * i) / 8;
      if (i % 2) K.poly(g, [P(-su, a, 0.02), P(su, a, 0.02), P(su, a + sv / 4, 0.02), P(-su, a + sv / 4, 0.02)], rgb(lawn, 1.06, 0.6));
    }
  const path = rgb(0xd8cba8);
  // лъкатушна алея по диагонала + напречна
  const curve = (pts: [number, number][], w: number) => {
    g.beginPath();
    const p0 = P(pts[0][0], pts[0][1], 0.1);
    g.moveTo(p0[0], p0[1]);
    for (let i = 1; i < pts.length - 1; i += 2) {
      const c = P(pts[i][0], pts[i][1], 0.1);
      const e = P(pts[i + 1][0], pts[i + 1][1], 0.1);
      g.quadraticCurveTo(c[0], c[1], e[0], e[1]);
    }
    g.strokeStyle = path;
    g.lineWidth = w * r;
    g.lineCap = 'round';
    g.stroke();
  };
  curve(
    [
      [-su, 0],
      [-su * 0.4, -sv * 0.5],
      [0, 0],
      [su * 0.45, sv * 0.5],
      [su, 0],
    ],
    3,
  );
  curve(
    [
      [0, -sv],
      [sv > 0.6 ? su * 0.35 : 0.1, -sv * 0.3],
      [0, 0],
      [-su * 0.3, sv * 0.4],
      [0, sv],
    ],
    2.4,
  );
  const big = su > 0.6 && sv > 0.6;
  if (big) {
    // езерце с мостче и патици
    const [x, y] = P(-su * 0.45, sv * 0.35, 0);
    g.beginPath();
    g.ellipse(x, y, 26 * r, 11 * r, 0, 0, Math.PI * 2);
    g.fillStyle = rgb(0xcbbf9b);
    g.fill();
    g.beginPath();
    g.ellipse(x, y, 23 * r, 9.5 * r, 0, 0, Math.PI * 2);
    g.fillStyle = winter ? rgb(0xd6e6ee) : rgb(0x4f9cc4);
    g.fill();
    g.beginPath();
    g.ellipse(x - 5 * r, y - 2 * r, 12 * r, 3 * r, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fill();
    if (!winter)
      for (let i = 0; i < 3; i++) {
        g.fillStyle = '#f5f5f0';
        g.beginPath();
        g.ellipse(x + (i * 6 - 4) * r, y + (i % 2) * 3 * r, 1.6 * r, 0.9 * r, 0, 0, Math.PI * 2);
        g.fill();
      }
    K.line(g, [x + 12 * r, y - 7 * r], [x + 22 * r, y + 2 * r], rgb(0x8b5e3c), 2.4 * r);
  } else {
    // фонтан
    const [fx, fy] = P(0, 0, 0);
    g.beginPath();
    g.ellipse(fx, fy, 9 * r, 4.5 * r, 0, 0, Math.PI * 2);
    g.fillStyle = rgb(0xd9d2c0);
    g.fill();
    g.beginPath();
    g.ellipse(fx, fy, 6.5 * r, 3.2 * r, 0, 0, Math.PI * 2);
    g.fillStyle = winter ? rgb(0xd6e6ee) : rgb(0x5aa0c8);
    g.fill();
    K.line(g, [fx, fy], [fx, fy - 6 * r], 'rgba(220,240,255,0.8)', 1.2 * r);
  }
  // детска площадка (пясъчник, пързалка, люлка) в голям или двоен парк
  if (su > 0.6 || sv > 0.6) {
    const pu = su * 0.5;
    const pv = -sv * 0.55;
    K.poly(g, [P(pu - 0.16, pv - 0.12, 0.05), P(pu + 0.16, pv - 0.12, 0.05), P(pu + 0.16, pv + 0.12, 0.05), P(pu - 0.16, pv + 0.12, 0.05)], rgb(0xe3c98f));
    K.box(g, P, pu - 0.08, pv - 0.05, pu - 0.02, pv + 0.01, 0, 7, { wall: 0xe74c3c, edge: false });
    K.line(g, P(pu - 0.02, pv - 0.02, 7), P(pu + 0.1, pv - 0.02, 0.5), rgb(0xf1c40f), 1.6 * r);
    K.line(g, P(pu + 0.02, pv + 0.07, 0), P(pu + 0.02, pv + 0.07, 8), rgb(0x2e86c1), 0.8 * r);
    K.line(g, P(pu + 0.12, pv + 0.07, 0), P(pu + 0.12, pv + 0.07, 8), rgb(0x2e86c1), 0.8 * r);
    K.line(g, P(pu + 0.02, pv + 0.07, 8), P(pu + 0.12, pv + 0.07, 8), rgb(0x2e86c1), 0.8 * r);
  }
  // цветни лехи
  if (!winter)
    for (let i = 0; i < 3; i++) {
      const u = (h01(seed, i, 81) * 2 - 1) * su * 0.7;
      const v = (h01(seed, i, 82) * 2 - 1) * sv * 0.7;
      const [x, y] = P(u, v, 0.1);
      const cols = [0xe8505b, 0xf2c94c, 0xb56be0, 0xf08a3c];
      for (let k = 0; k < 7; k++) {
        g.fillStyle = rgb(cols[(i + k) % cols.length]);
        g.beginPath();
        g.arc(x + (k - 3) * 1.6 * r, y + ((k * 7) % 3) * 0.8 * r, 1.1 * r, 0, Math.PI * 2);
        g.fill();
      }
    }
  // пейки покрай алеите
  for (let i = 0; i < 4; i++) {
    const u = (i % 2 ? 1 : -1) * su * 0.25;
    const v = (i < 2 ? -1 : 1) * sv * 0.18;
    K.box(g, P, u - 0.05, v, u + 0.05, v + 0.025, 1, 2.2, { wall: 0x8b5e3c, edge: false });
  }
  // дървета: повече в по-голям парк, отзад напред
  const n = Math.round(4 * su * sv * 2) + 3;
  const spots: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    // по-често към краищата на парка
    const edge = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), 0.55);
    const u = edge(h01(seed, i, 83) * 2 - 1) * (su - 0.1);
    const v = edge(h01(seed, i, 84) * 2 - 1) * (sv - 0.1);
    // не върху езерото/алеите в центъра
    if (Math.abs(u) < 0.12 && Math.abs(v) < 0.12) continue;
    if (big && Math.hypot(u + su * 0.45, (v - sv * 0.35) * 1.6) < 0.4) continue;
    spots.push([u, v, i]);
  }
  spots.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  // дърветата по края, а не в средата – алеите, езерото и площадката да се виждат
  for (const [u, v, i] of spots) K.tree(g, P, r, u, v, seed + i, 0.85 + h01(seed, i, 85) * 0.45);
}
