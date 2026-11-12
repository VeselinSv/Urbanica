/**
 * Гладки модели на леките коли: каросерията е „изтеглена“ по дължината от заоблени сечения
 * (суперелипса) по профил – нисък капак, наклонено предно стъкло, покрив, задно стъкло, багажник;
 * кабината е по-тясна от каросерията. Колелата са цилиндри с гума и сребриста джанта.
 * Всеки многоъгълник се осветява (дифузно + отблясък по лака и стъклата) и се рисува отзад напред.
 */
type Ctx = CanvasRenderingContext2D;
type V3 = [number, number, number];

export type SmoothModel = 'sedan' | 'hatch' | 'suv' | 'van' | 'taxi' | 'police';

interface Profile {
  L: number; // дължина (плочки)
  W: number; // ширина (плочки)
  clear: number; // просвет (px)
  belt: number; // височина на линията на прозорците (px)
  /** Станции по дължината: a (дял от L, -0.5 отзад … 0.5 отпред), горна височина (px), ширина (дял). */
  st: [number, number, number][];
  /** Кабина (стъкла) между тези a – извън тях над линията е лак (капак, багажник). */
  cab: [number, number];
  /** Стеснение на кабината нагоре (0..1). */
  taper: number;
  /** Заобленост на сечението (по-голямо – по-ръбесто). */
  p: number;
  wheel: number; // радиус на колелото (px)
  axle: number; // разстояние на осите от краищата (дял от L)
}

const PROFILES: Record<SmoothModel, Profile> = {
  sedan: {
    L: 0.3,
    W: 0.14,
    clear: 1.1,
    belt: 4.3,
    st: [
      [-0.5, 3.5, 0.82],
      [-0.46, 4.2, 0.96],
      [-0.36, 4.45, 1],
      [-0.24, 4.55, 1],
      [-0.1, 6.9, 1],
      [0.08, 7.0, 1],
      [0.24, 4.6, 1],
      [0.36, 4.25, 1],
      [0.46, 3.85, 0.96],
      [0.5, 3.1, 0.8],
    ],
    cab: [-0.24, 0.24],
    taper: 0.38,
    p: 4,
    wheel: 1.75,
    axle: 0.2,
  },
  hatch: {
    L: 0.26,
    W: 0.14,
    clear: 1.1,
    belt: 4.3,
    st: [
      [-0.5, 4.4, 0.85],
      [-0.47, 6.6, 0.95],
      [-0.4, 7.4, 1],
      [0.08, 7.5, 1],
      [0.22, 4.9, 1],
      [0.36, 4.5, 1],
      [0.46, 4.0, 0.95],
      [0.5, 3.3, 0.8],
    ],
    cab: [-0.47, 0.22],
    taper: 0.36,
    p: 4,
    wheel: 1.7,
    axle: 0.19,
  },
  suv: {
    L: 0.31,
    W: 0.15,
    clear: 1.7,
    belt: 5.8,
    st: [
      [-0.5, 5.0, 0.88],
      [-0.47, 8.8, 0.97],
      [-0.4, 9.4, 1],
      [0.1, 9.5, 1],
      [0.22, 6.2, 1],
      [0.36, 5.8, 1],
      [0.47, 5.3, 0.95],
      [0.5, 4.4, 0.85],
    ],
    cab: [-0.47, 0.22],
    taper: 0.2,
    p: 4.5,
    wheel: 2.1,
    axle: 0.19,
  },
  van: {
    L: 0.33,
    W: 0.15,
    clear: 1.4,
    belt: 5.6,
    st: [
      [-0.5, 9.6, 0.92],
      [-0.47, 10.4, 0.98],
      [0.2, 10.4, 1],
      [0.32, 6.4, 1],
      [0.44, 5.6, 0.96],
      [0.5, 4.6, 0.86],
    ],
    cab: [0.14, 0.32],
    taper: 0.08,
    p: 5,
    wheel: 1.9,
    axle: 0.17,
  },
  taxi: null as unknown as Profile,
  police: null as unknown as Profile,
};
PROFILES.taxi = PROFILES.sedan;
PROFILES.police = PROFILES.sedan;

// светлина отгоре-вляво (както сградите) и камерата на изометрията
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const LIGHT = norm([0.12, 0.6, 0.8]);
const CAM = norm([0.612, 0.612, 0.5]);
const HALF = norm([LIGHT[0] + CAM[0], LIGHT[1] + CAM[1], LIGHT[2] + CAM[2]]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** 1 плочка ≈ 36 px в пространството (за еднакъв мащаб на нормалите). */
const S = 36;

function rgbOf(c: number): V3 {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
function css(c: V3, a = 1) {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

type Mat = 'paint' | 'glass' | 'tire' | 'rim' | 'dark' | 'sign' | 'red' | 'blue' | 'chrome';
interface Face {
  pts: V3[]; // (a, b, h) – локално
  mat: Mat;
}

/** Рисува гладката кола в текущата трансформация (центърът на колата в 0,0). */
export function drawSmoothCar(g: Ctx, model: SmoothModel, color: number, yaw: number) {
  const pr = PROFILES[model];
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  // локално (a напред, b надясно, h нагоре в px) → свят (S-мащаб) и екран
  const world = (p: V3): V3 => {
    const wx = p[0] * ca - p[1] * sa;
    const wy = p[0] * sa + p[1] * ca;
    return [wx * S, wy * S, p[2]];
  };
  const screen = (p: V3): [number, number] => {
    const wx = p[0] * ca - p[1] * sa;
    const wy = p[0] * sa + p[1] * ca;
    return [(wx - wy) * 32, (wx + wy) * 16 - p[2]];
  };
  const faces: Face[] = [];
  // ---- каросерия: станции (с подразделяне) × пръстен от суперелипса
  const stations: [number, number, number][] = [];
  for (let i = 0; i < pr.st.length - 1; i++) {
    const [a0, t0, w0] = pr.st[i];
    const [a1, t1, w1] = pr.st[i + 1];
    const n = 2;
    for (let k = 0; k < n; k++) {
      const u = k / n;
      stations.push([a0 + (a1 - a0) * u, t0 + (t1 - t0) * u, w0 + (w1 - w0) * u]);
    }
  }
  stations.push(pr.st[pr.st.length - 1]);
  const M = 18;
  const rings: V3[][] = stations.map(([af, top, wf]) => {
    const a = af * pr.L;
    const zb = pr.clear;
    const zc = (zb + top) / 2;
    const hz = (top - zb) / 2;
    const hw = (pr.W / 2) * wf;
    const ring: V3[] = [];
    for (let j = 0; j < M; j++) {
      const th = (j / M) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const e = 2 / pr.p;
      let y = Math.sign(c) * Math.pow(Math.abs(c), e) * hw;
      const z = zc + Math.sign(s) * Math.pow(Math.abs(s), e) * hz;
      // кабината е по-тясна от каросерията (над линията на прозорците)
      if (z > pr.belt) y *= 1 - pr.taper * Math.min(1, (z - pr.belt) / Math.max(1, top - pr.belt));
      ring.push([a, y, z]);
    }
    return ring;
  });
  const cabA0 = pr.cab[0] * pr.L;
  const cabA1 = pr.cab[1] * pr.L;
  const pillarsA = [cabA0 + 0.012, (cabA0 + cabA1) / 2 - 0.004, cabA1 - 0.012];
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M;
      const q: V3[] = [rings[i][j], rings[i + 1][j], rings[i + 1][j2], rings[i][j2]];
      const ca2 = (q[0][0] + q[1][0]) / 2;
      const cz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      let mat: Mat = 'paint';
      const inCab = ca2 > cabA0 - 0.004 && ca2 < cabA1 + 0.004;
      const roofTop = Math.abs(cy) < (pr.W / 2) * 0.45;
      if (inCab && cz > pr.belt + 0.25 && !roofTop) {
        mat = 'glass';
        // колони на кабината (A, B, C) – лак
        const side = Math.abs(cy) > (pr.W / 2) * 0.5;
        if (side && pillarsA.some((pa) => Math.abs(ca2 - pa) < 0.009)) mat = 'paint';
      }
      if (cz < pr.clear + 1.0) mat = 'dark'; // прагове и брони отдолу
      if (model === 'police' && mat === 'paint' && cz > 2.8 && cz < 3.6 && Math.abs(cy) > (pr.W / 2) * 0.8) mat = 'blue';
      faces.push({ pts: q, mat });
    }
  // капачки отпред и отзад
  faces.push({ pts: [...rings[0]].reverse(), mat: 'paint' });
  faces.push({ pts: rings[rings.length - 1], mat: 'paint' });
  // ---- колела: гума (цилиндър) и джанта
  const R = pr.wheel;
  const ra = R / S; // радиус в плочки по дължината
  for (const sa2 of [-1, 1])
    for (const sb of [-1, 1]) {
      const a = sa2 * (pr.L / 2 - pr.axle * pr.L);
      const b = sb * (pr.W / 2 - 0.006);
      const K = 12;
      const out: V3[] = [];
      const inn: V3[] = [];
      for (let k = 0; k < K; k++) {
        const t = (k / K) * Math.PI * 2;
        out.push([a + Math.cos(t) * ra, b + sb * 0.008, R + Math.sin(t) * R]);
        inn.push([a + Math.cos(t) * ra, b - sb * 0.014, R + Math.sin(t) * R]);
      }
      for (let k = 0; k < K; k++) faces.push({ pts: [out[k], out[(k + 1) % K], inn[(k + 1) % K], inn[k]], mat: 'tire' });
      faces.push({ pts: sb > 0 ? out : [...out].reverse(), mat: 'tire' });
      const rim = out.map((p): V3 => [a + (p[0] - a) * 0.62, p[1] + sb * 0.0005, R + (p[2] - R) * 0.62]);
      faces.push({ pts: sb > 0 ? rim : [...rim].reverse(), mat: 'rim' });
    }
  // ---- табела на таксито, лампа на полицията
  const boxF = (a0: number, a1: number, b0: number, b1: number, z0: number, z1: number, mat: Mat) => {
    const c = (a: number, b: number, z: number): V3 => [a, b, z];
    faces.push({ pts: [c(a0, b0, z1), c(a1, b0, z1), c(a1, b1, z1), c(a0, b1, z1)], mat });
    faces.push({ pts: [c(a1, b0, z0), c(a1, b1, z0), c(a1, b1, z1), c(a1, b0, z1)], mat });
    faces.push({ pts: [c(a0, b1, z0), c(a0, b0, z0), c(a0, b0, z1), c(a0, b1, z1)], mat });
    faces.push({ pts: [c(a0, b1, z0), c(a1, b1, z0), c(a1, b1, z1), c(a0, b1, z1)], mat });
    faces.push({ pts: [c(a1, b0, z0), c(a0, b0, z0), c(a0, b0, z1), c(a1, b0, z1)], mat });
  };
  const roofZ = Math.max(...pr.st.map((s) => s[1]));
  if (model === 'taxi') boxF(-0.016, 0.014, -0.022, 0.022, roofZ - 0.2, roofZ + 1.7, 'sign');
  if (model === 'police') {
    boxF(-0.012, 0.012, -0.042, 0, roofZ - 0.2, roofZ + 1.2, 'red');
    boxF(-0.012, 0.012, 0, 0.042, roofZ - 0.2, roofZ + 1.2, 'blue');
  }

  // ---- осветяване и рисуване отзад напред
  const paint = rgbOf(color);
  const shaded = faces
    .map((f) => {
      const w = f.pts.map(world);
      // нормала (Нюел) – независима от реда на върховете при неравни многоъгълници
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < w.length; i++) {
        const p = w[i];
        const q = w[(i + 1) % w.length];
        nx += (p[1] - q[1]) * (p[2] + q[2]);
        ny += (p[2] - q[2]) * (p[0] + q[0]);
        nz += (p[0] - q[0]) * (p[1] + q[1]);
      }
      let n = norm([nx, ny, nz]);
      // нормалата навън: спрямо центъра на колата
      const c = w.reduce((acc, p) => [acc[0] + p[0] / w.length, acc[1] + p[1] / w.length, acc[2] + p[2] / w.length] as V3, [0, 0, 0] as V3);
      const out: V3 = [c[0], c[1], c[2] - (pr.clear + roofZ) / 2];
      if (f.mat !== 'tire' && f.mat !== 'rim' && dot(n, out) < 0) n = [-n[0], -n[1], -n[2]];
      return { f, n, depth: dot(c, CAM) };
    })
    .filter((x) => dot(x.n, CAM) > 0.01)
    .sort((a, b) => a.depth - b.depth);

  // сянка под колата
  g.save();
  g.fillStyle = 'rgba(10,14,20,0.35)';
  g.beginPath();
  const sh = [
    [-pr.L / 2, -pr.W / 2],
    [pr.L / 2, -pr.W / 2],
    [pr.L / 2, pr.W / 2],
    [-pr.L / 2, pr.W / 2],
  ].map(([a, b]) => screen([a, b, 0]));
  g.translate(1.6, 0.9);
  g.moveTo(sh[0][0], sh[0][1]);
  for (const p of sh.slice(1)) g.lineTo(p[0], p[1]);
  g.closePath();
  g.fill();
  g.restore();

  for (const { f, n } of shaded) {
    const diff = Math.max(0, dot(n, LIGHT));
    const spec = Math.pow(Math.max(0, dot(n, HALF)), 36);
    const up = Math.max(0, n[2]);
    let col: V3;
    const alpha = 1;
    switch (f.mat) {
      case 'paint': {
        const k = 0.42 + 0.68 * diff;
        col = [paint[0] * k + 255 * spec * 0.75 + 30 * up, paint[1] * k + 255 * spec * 0.75 + 32 * up, paint[2] * k + 255 * spec * 0.75 + 36 * up];
        break;
      }
      case 'glass': {
        // тъмно стъкло с отражение на небето отгоре и отблясък
        const sky: V3 = [150, 190, 220];
        const dark: V3 = [24, 34, 46];
        const t = 0.18 + 0.55 * up;
        col = [dark[0] + (sky[0] - dark[0]) * t + 255 * spec, dark[1] + (sky[1] - dark[1]) * t + 255 * spec, dark[2] + (sky[2] - dark[2]) * t + 255 * spec];
        break;
      }
      case 'tire':
        col = [26 + 30 * diff, 27 + 30 * diff, 29 + 30 * diff];
        break;
      case 'rim':
        col = [150 + 80 * diff, 156 + 80 * diff, 165 + 80 * diff];
        break;
      case 'dark':
        col = [38 + 40 * diff, 40 + 40 * diff, 44 + 40 * diff];
        break;
      case 'sign':
        col = [245, 200 + 40 * diff, 60];
        break;
      case 'red':
        col = [220, 50, 40];
        break;
      case 'blue':
        col = [40 + 40 * diff, 90 + 40 * diff, 210 + 30 * diff];
        break;
      default:
        col = [200, 200, 200];
    }
    const s2 = f.pts.map(screen);
    g.beginPath();
    g.moveTo(s2[0][0], s2[0][1]);
    for (const p of s2.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
    g.fillStyle = css(col, alpha);
    g.fill();
    // тънък контур в същия цвят – без пролуки между многоъгълниците
    g.strokeStyle = css(col, alpha);
    g.lineWidth = 0.12;
    g.stroke();
  }

  // фарове и стопове
  const frontVis = ca + sa > 0.05;
  const backVis = -ca - sa > 0.05;
  const lamp = (a: number, b: number, z: number, c: string, rx: number) => {
    const [x, y] = screen([a, b, z]);
    g.fillStyle = c;
    g.beginPath();
    g.ellipse(x, y, rx, rx * 0.6, 0, 0, Math.PI * 2);
    g.fill();
  };
  const fz = PROFILES[model].st[PROFILES[model].st.length - 2][1] - 1.2;
  for (const sb of [-1, 1]) {
    if (frontVis) lamp(pr.L / 2 - 0.004, sb * pr.W * 0.32, Math.min(fz, pr.belt - 1), '#fff6cf', 0.9);
    if (backVis) lamp(-pr.L / 2 + 0.004, sb * pr.W * 0.33, Math.min(PROFILES[model].st[1][1] - 1, pr.belt - 0.8), '#c0261c', 0.85);
  }
}

export const SMOOTH_MODELS = new Set<string>(['sedan', 'hatch', 'suv', 'van', 'taxi', 'police']);
