/**
 * Следи на сигналите върху терена (дупки, теч, боклук, катастрофа, паднало дърво…), нарисувани като
 * истински материали: начупен асфалт с ръб и дълбочина, мокра настилка с отблясък, торби с гънки,
 * кора и листа. Всяка следа е малка текстура (2x), кеширана по вид, тежест и вариант.
 */
import { Texture } from 'pixi.js';
import { newCanvas } from './canvas';

type Ctx = CanvasRenderingContext2D;
const RES = 2;
const W = 80;
const H = 48;

/** Детерминистичен шум 0..1. */
function rnd(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Неправилен изометричен „петно“-контур около (cx, cy): rx по хоризонтала, ry = rx/2 по вертикала. */
function blob(g: Ctx, cx: number, cy: number, rx: number, ry: number, seed: number, jag = 0.25, n = 14) {
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 - jag / 2 + rnd(seed, i % n) * jag;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

function pothole(g: Ctx, cx: number, cy: number, s: number, seed: number, wet: boolean) {
  // натрошен асфалт около дупката (по-светъл, на парчета)
  for (let i = 0; i < 6; i++) {
    const a = rnd(seed, i, 1) * Math.PI * 2;
    const d = 9 * s + rnd(seed, i, 2) * 4 * s;
    blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.5, 2.2 * s, 1.1 * s, seed + i, 0.6, 6);
    g.fillStyle = `rgba(${96 + i * 4},${94 + i * 4},${92 + i * 3},0.85)`;
    g.fill();
  }
  // ръб: изронен асфалт
  blob(g, cx, cy, 11 * s, 5.6 * s, seed, 0.38);
  g.fillStyle = '#5c5955';
  g.fill();
  // дълбочина: тъмно към далечния (горен) ръб, по-светла основа отпред
  blob(g, cx + 0.5, cy + 0.4, 9 * s, 4.4 * s, seed + 3, 0.32);
  const gr = g.createLinearGradient(cx, cy - 4.4 * s, cx, cy + 4.4 * s);
  gr.addColorStop(0, '#121110');
  gr.addColorStop(0.55, '#2b2723');
  gr.addColorStop(1, '#4a443c');
  g.fillStyle = gr;
  g.fill();
  // чакъл на дъното
  for (let i = 0; i < 10; i++) {
    g.fillStyle = `rgba(150,140,125,${0.35 + rnd(seed, i, 4) * 0.4})`;
    g.fillRect(cx + (rnd(seed, i, 5) - 0.5) * 12 * s, cy + (rnd(seed, i, 6) - 0.2) * 4 * s, 0.9, 0.7);
  }
  if (wet) {
    // локва в дупката: отразява небето
    blob(g, cx + 1, cy + 1, 6 * s, 2.4 * s, seed + 7, 0.3);
    const wg = g.createLinearGradient(cx - 6 * s, cy, cx + 6 * s, cy + 2 * s);
    wg.addColorStop(0, 'rgba(120,150,175,0.85)');
    wg.addColorStop(1, 'rgba(60,80,100,0.85)');
    g.fillStyle = wg;
    g.fill();
    g.fillStyle = 'rgba(230,240,250,0.55)';
    g.fillRect(cx - 2 * s, cy + 0.2 * s, 3 * s, 0.6);
  }
  // пукнатини, тръгващи от дупката
  g.strokeStyle = 'rgba(25,24,22,0.75)';
  g.lineWidth = 0.7;
  for (let i = 0; i < 4; i++) {
    const a = rnd(seed, i, 8) * Math.PI * 2;
    let x = cx + Math.cos(a) * 10 * s;
    let y = cy + Math.sin(a) * 5 * s;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += Math.cos(a + (rnd(seed, i, k, 9) - 0.5) * 1.4) * 4 * s;
      y += Math.sin(a + (rnd(seed, i, k, 10) - 0.5) * 1.4) * 2 * s;
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

function puddle(g: Ctx, cx: number, cy: number, s: number, seed: number, dirty: boolean) {
  // мокра (потъмняла) настилка около теча
  blob(g, cx, cy, 26 * s, 12 * s, seed, 0.45, 18);
  g.fillStyle = 'rgba(20,24,30,0.28)';
  g.fill();
  blob(g, cx + 2, cy + 1, 18 * s, 8 * s, seed + 1, 0.5, 18);
  const gr = g.createLinearGradient(cx - 18 * s, cy - 8 * s, cx + 18 * s, cy + 8 * s);
  if (dirty) {
    gr.addColorStop(0, 'rgba(120,118,70,0.85)');
    gr.addColorStop(1, 'rgba(70,72,40,0.85)');
  } else {
    gr.addColorStop(0, 'rgba(150,185,210,0.8)');
    gr.addColorStop(0.6, 'rgba(85,120,150,0.8)');
    gr.addColorStop(1, 'rgba(55,80,105,0.85)');
  }
  g.fillStyle = gr;
  g.fill();
  // отблясъци и вълнички
  g.strokeStyle = 'rgba(240,248,255,0.55)';
  g.lineWidth = 0.6;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.ellipse(cx + (rnd(seed, i, 2) - 0.5) * 16 * s, cy + (rnd(seed, i, 3) - 0.5) * 6 * s, 3 + i * 1.5, 1.2 + i * 0.6, 0, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
  }
  if (!dirty) {
    // шахта, от която блика водата
    g.fillStyle = '#3a3f45';
    g.beginPath();
    g.ellipse(cx - 4 * s, cy - 1, 3.4, 1.7, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(200,230,255,0.8)';
    g.beginPath();
    g.ellipse(cx - 4 * s, cy - 1, 4.6, 2.3, 0, 0, Math.PI * 2);
    g.stroke();
  }
}

function garbage(g: Ctx, cx: number, cy: number, sev: number, seed: number) {
  const n = 3 + sev * 2;
  // разпилени дребни боклуци
  for (let i = 0; i < 12 + sev * 6; i++) {
    g.fillStyle = ['#d9d4c7', '#c94f3d', '#e2c25a', '#7aa3c7', '#9a8f7a'][i % 5];
    g.globalAlpha = 0.85;
    g.fillRect(cx + (rnd(seed, i, 1) - 0.5) * 34, cy + (rnd(seed, i, 2) - 0.5) * 14, 1.4, 0.9);
  }
  g.globalAlpha = 1;
  // торби: тъмни, лъскави, с гънка и възел
  for (let i = 0; i < n; i++) {
    const x = cx + (rnd(seed, i, 3) - 0.5) * 24;
    const y = cy + (rnd(seed, i, 4) - 0.5) * 9;
    const r = 3.4 + rnd(seed, i, 5) * 1.6;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath();
    g.ellipse(x + 1.5, y + r * 0.55, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
    g.fill();
    const col = rnd(seed, i, 6) < 0.6 ? [30, 33, 36] : [42, 70, 44];
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.6, 0.5, x, y - r * 0.3, r * 1.2);
    gr.addColorStop(0, `rgb(${col[0] + 70},${col[1] + 70},${col[2] + 70})`);
    gr.addColorStop(0.35, `rgb(${col[0] + 18},${col[1] + 18},${col[2] + 18})`);
    gr.addColorStop(1, `rgb(${col[0]},${col[1]},${col[2]})`);
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(x, y - r * 0.35, r, r * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `rgb(${col[0] + 10},${col[1] + 10},${col[2] + 10})`;
    g.beginPath();
    g.moveTo(x - 1, y - r * 1.05);
    g.lineTo(x + 1.2, y - r * 1.05);
    g.lineTo(x + 0.6, y - r * 1.5);
    g.lineTo(x - 0.4, y - r * 1.45);
    g.fill();
  }
}

function crash(g: Ctx, cx: number, cy: number, seed: number) {
  // стъкла и масло по пътя
  blob(g, cx + 2, cy + 3, 14, 5, seed, 0.6);
  g.fillStyle = 'rgba(20,18,30,0.45)';
  g.fill();
  for (let i = 0; i < 14; i++) {
    g.fillStyle = 'rgba(220,235,245,0.8)';
    g.fillRect(cx + (rnd(seed, i, 1) - 0.5) * 22, cy + (rnd(seed, i, 2) - 0.5) * 9, 0.8, 0.6);
  }
  // две смачкани коли (каросерия с покрив и стъкла)
  const car = (x: number, y: number, col: string, roof: string, flip: number) => {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.ellipse(x + 1, y + 2.5, 8, 3, flip * 0.3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x - 7, y + flip);
    g.lineTo(x + 1, y - 3 - flip);
    g.lineTo(x + 8, y - flip);
    g.lineTo(x, y + 3 + flip);
    g.closePath();
    g.fill();
    g.fillStyle = roof;
    g.beginPath();
    g.moveTo(x - 3, y - 2 + flip * 0.5);
    g.lineTo(x + 1, y - 4.5 - flip * 0.5);
    g.lineTo(x + 4.5, y - 2.5 - flip * 0.5);
    g.lineTo(x + 0.5, y - 0.3 + flip * 0.5);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(60,85,110,0.9)';
    g.fillRect(x - 2.6, y - 2.6, 2.2, 1);
  };
  car(cx - 6, cy - 1, '#b8312a', '#8e2620', 0.4);
  car(cx + 7, cy + 2, '#e9ecef', '#c3c8cd', -0.4);
  // конуси
  for (const dx of [-20, 19]) {
    const x = cx + dx;
    const y = cy + (dx > 0 ? 4 : -3);
    g.fillStyle = '#ff7a1a';
    g.beginPath();
    g.moveTo(x - 2, y + 1.5);
    g.lineTo(x, y - 5);
    g.lineTo(x + 2, y + 1.5);
    g.fill();
    g.fillStyle = '#ffffff';
    g.fillRect(x - 1, y - 2, 2, 0.9);
  }
}

function fallenTree(g: Ctx, cx: number, cy: number, seed: number) {
  // сянка
  blob(g, cx + 2, cy + 4, 22, 6, seed, 0.4);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fill();
  // ствол с кора: градиент по дебелината
  const x0 = cx - 18;
  const y0 = cy - 5;
  const x1 = cx + 12;
  const y1 = cy + 6;
  const gr = g.createLinearGradient(x0, y0 - 2, x0 + 1.5, y0 + 2.5);
  gr.addColorStop(0, '#8a6a4c');
  gr.addColorStop(0.5, '#5d4433');
  gr.addColorStop(1, '#3a2a20');
  g.strokeStyle = gr;
  g.lineCap = 'round';
  g.lineWidth = 4.2;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  // счупеният край и пън
  g.fillStyle = '#c9a77c';
  g.beginPath();
  g.ellipse(x0, y0, 2.1, 1.6, 0.4, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(40,28,20,0.6)';
  g.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const t = 0.2 + i * 0.18;
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * t - 0.6, y0 + (y1 - y0) * t - 1.6);
    g.lineTo(x0 + (x1 - x0) * t + 0.8, y0 + (y1 - y0) * t + 1.4);
    g.stroke();
  }
  // корона: много листни купчини със светлина отгоре-вляво
  for (let i = 0; i < 9; i++) {
    const x = x1 + (rnd(seed, i, 1) - 0.4) * 14;
    const y = y1 + (rnd(seed, i, 2) - 0.6) * 7;
    const r = 3 + rnd(seed, i, 3) * 2.8;
    const lg = g.createRadialGradient(x - r * 0.4, y - r * 0.5, 0.4, x, y, r);
    lg.addColorStop(0, '#7fae55');
    lg.addColorStop(0.6, '#4f7f3a');
    lg.addColorStop(1, '#2f5226');
    g.fillStyle = lg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

const cache = new Map<string, Texture>();

/** Текстура на следата на сигнала; anchor (0.5, 0.5) е центърът на плочката. */
export function decalTexture(kind: string, severity: number, seed: number, wet: boolean): Texture | null {
  const v = Math.abs(seed) % 4;
  const id = `${kind}:${severity}:${v}:${wet ? 1 : 0}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const c = newCanvas();
  c.width = W * RES;
  c.height = H * RES;
  const g = c.getContext('2d') as Ctx | null;
  if (!g) return null;
  g.scale(RES, RES);
  const cx = W / 2;
  const cy = H / 2;
  const s = 0.7 + severity * 0.25;
  switch (kind) {
    case 'pothole':
      pothole(g, cx, cy, s, v + 1, wet || severity >= 2);
      break;
    case 'water_leak':
      puddle(g, cx, cy, s * 0.9, v + 11, false);
      break;
    case 'sewage':
      puddle(g, cx, cy, s * 0.9, v + 21, true);
      break;
    case 'garbage':
      garbage(g, cx, cy, severity, v + 31);
      break;
    case 'accident':
      crash(g, cx, cy, v + 41);
      break;
    case 'fallen_tree':
      fallenTree(g, cx, cy, v + 51);
      break;
    case 'streetlight':
    case 'power_outage': {
      // тъмно петно (без осветление) с мек край
      const gr = g.createRadialGradient(cx, cy, 2, cx, cy, 26);
      gr.addColorStop(0, 'rgba(5,10,20,0.45)');
      gr.addColorStop(1, 'rgba(5,10,20,0)');
      g.fillStyle = gr;
      g.save();
      g.translate(cx, cy);
      g.scale(1, 0.5);
      g.beginPath();
      g.arc(0, 0, 26, 0, Math.PI * 2);
      g.restore();
      g.fill();
      break;
    }
    case 'graffiti': {
      const cols = ['rgba(217,70,239,0.7)', 'rgba(56,189,248,0.7)', 'rgba(250,204,21,0.7)'];
      g.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        g.strokeStyle = cols[i % 3];
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(cx - 12 + i * 5, cy + 3);
        g.quadraticCurveTo(cx - 9 + i * 5, cy - 6 + rnd(v, i) * 4, cx - 6 + i * 5, cy + 2);
        g.stroke();
      }
      break;
    }
    default:
      return null;
  }
  const tex = Texture.from(c);
  cache.set(id, tex);
  return tex;
}

export const DECAL_W = W;
export const DECAL_H = H;
