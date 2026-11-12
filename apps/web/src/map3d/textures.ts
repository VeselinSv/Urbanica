/**
 * Процедурни текстури за 3D изгледа: асфалт с маркировка, тротоарни плочки, фасади с прозорци
 * (по един етаж и една „ос“ – повтарят се по сградата), керемиди, бетон, трева и зърно за терена.
 * Всички се генерират в Canvas веднъж и се кешират.
 */
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function rnd(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function finish(key: string, c: HTMLCanvasElement, repeat = true, srgb = true): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}

/** Шум (зърно) за терена и материалите – сиво около 0.85, с петна. */
export function grainTexture(): THREE.Texture {
  const hit = cache.get('grain');
  if (hit) return hit;
  const S = 256;
  const { c, g } = canvas(S, S);
  const img = g.createImageData(S, S);
  const r = rnd(7);
  for (let i = 0; i < S * S; i++) {
    const x = i % S;
    const y = Math.floor(i / S);
    const blot = Math.sin(x * 0.11) * Math.cos(y * 0.13) * 10 + Math.sin((x + y) * 0.05) * 8;
    const v = 205 + (r() - 0.5) * 50 + blot;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish('grain', c, true, false);
}

/** Асфалт: тъмна основа със зърно и петна; lanes – пунктирана ос (по дължина на текстурата = посока на пътя). */
export function asphaltTexture(kind: 'lane' | 'plain' | 'cross' | 'highway'): THREE.Texture {
  const key = `asphalt:${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 256;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#3b3d40';
  g.fillRect(0, 0, S, S);
  const r = rnd(11);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + r() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 2},${0.35 + r() * 0.4})`;
    g.fillRect(r() * S, r() * S, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  // износени ивици от гумите
  g.fillStyle = 'rgba(25,25,28,0.22)';
  for (const x of [0.3, 0.38, 0.62, 0.7]) g.fillRect(x * S, 0, 0.05 * S, S);
  // кръпки
  for (let i = 0; i < 3; i++) {
    g.fillStyle = `rgba(${48 + i * 6},${48 + i * 6},${52 + i * 6},0.7)`;
    g.fillRect(r() * S * 0.8, r() * S * 0.8, 20 + r() * 40, 14 + r() * 30);
  }
  if (kind === 'lane' || kind === 'highway') {
    // бели ръбови линии и пунктирана (или двойна жълта) ос
    g.fillStyle = 'rgba(235,235,230,0.9)';
    g.fillRect(0.06 * S, 0, 0.018 * S, S);
    g.fillRect(0.922 * S, 0, 0.018 * S, S);
    if (kind === 'highway') {
      g.fillStyle = 'rgba(232,197,71,0.95)';
      g.fillRect(0.485 * S, 0, 0.012 * S, S);
      g.fillRect(0.503 * S, 0, 0.012 * S, S);
      g.fillStyle = 'rgba(235,235,230,0.85)';
      for (const x of [0.27, 0.73]) for (let y = 0; y < S; y += 64) g.fillRect(x * S - 2, y, 4, 34);
    } else {
      g.fillStyle = 'rgba(240,240,235,0.92)';
      for (let y = 0; y < S; y += 64) g.fillRect(0.49 * S, y + 8, 0.02 * S, 34);
    }
  }
  if (kind === 'cross') {
    // пешеходни пътеки „зебра“ от четирите страни
    g.fillStyle = 'rgba(240,240,235,0.9)';
    for (let i = 0; i < 6; i++) {
      const p = 0.2 + i * 0.11;
      g.fillRect(p * S, 0.02 * S, 0.06 * S, 0.12 * S);
      g.fillRect(p * S, 0.86 * S, 0.06 * S, 0.12 * S);
      g.fillRect(0.02 * S, p * S, 0.12 * S, 0.06 * S);
      g.fillRect(0.86 * S, p * S, 0.12 * S, 0.06 * S);
    }
  }
  return finish(key, c);
}

/** Тротоарни плочки (сиво-бежови, на квадрати). */
export function pavingTexture(): THREE.Texture {
  const hit = cache.get('paving');
  if (hit) return hit;
  const S = 128;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#b9b2a6';
  g.fillRect(0, 0, S, S);
  const r = rnd(3);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const v = 168 + r() * 30;
      g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
      g.fillRect(x * 32 + 1, y * 32 + 1, 30, 30);
    }
  return finish('paving', c);
}

/** Керемиди (редове с леко различни нюанси) или тъмна битумна покривка. */
export function roofTexture(color: number, kind: 'tiles' | 'flat'): THREE.Texture {
  const key = `roof:${kind}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 128;
  const { c, g } = canvas(S, S);
  const base = new THREE.Color(color);
  const r = rnd(color);
  if (kind === 'tiles') {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 8; x++) {
        const k = 0.82 + r() * 0.3;
        g.fillStyle = `rgb(${base.r * 255 * k},${base.g * 255 * k},${base.b * 255 * k})`;
        const ox = y % 2 ? 8 : 0;
        g.fillRect(x * 16 + ox, y * 8, 15, 7);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x * 16 + ox, y * 8 + 6, 15, 1.5);
      }
  } else {
    g.fillStyle = `rgb(${base.r * 255},${base.g * 255},${base.b * 255})`;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2500; i++) {
      const v = r() * 40 - 20;
      g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},0.18)`;
      g.fillRect(r() * S, r() * S, 2, 2);
    }
  }
  return finish(key, c);
}

export interface FacadeStyle {
  wall: number;
  glass: number;
  frame: number;
  /** Прозорец като дял от ширината/височината на „клетката“. */
  winW: number;
  winH: number;
  /** Стъклена фасада (офиси) – ленти стъкло. */
  curtain?: boolean;
  /** Тухла вместо мазилка. */
  brick?: boolean;
  /** Витрина на партера (магазини). */
  shopfront?: number;
}

/**
 * Фасада: една клетка = един етаж × една ос на прозорец (повтаря се по UV). Втората (emissive) текстура
 * съдържа само светнатите прозорци – за нощта.
 */
export function facadeTextures(st: FacadeStyle, seed: number): { map: THREE.Texture; emissive: THREE.Texture } {
  const key = `facade:${JSON.stringify(st)}:${seed % 3}`;
  const hit = cache.get(key);
  if (hit) return { map: hit, emissive: cache.get(key + ':e')! };
  // 4×4 клетки в една текстура – прозорците се различават (пердета, светнати)
  const C = 64;
  const N = 4;
  const { c, g } = canvas(C * N, C * N);
  const e = canvas(C * N, C * N);
  e.g.fillStyle = '#000';
  e.g.fillRect(0, 0, C * N, C * N);
  const wall = new THREE.Color(st.wall);
  const r = rnd(seed + 17);
  const css = (col: THREE.Color, k = 1) => `rgb(${Math.min(255, col.r * 255 * k)},${Math.min(255, col.g * 255 * k)},${Math.min(255, col.b * 255 * k)})`;
  g.fillStyle = css(wall);
  g.fillRect(0, 0, C * N, C * N);
  // материал на стената
  if (st.brick) {
    for (let y = 0; y < C * N; y += 6)
      for (let x = 0; x < C * N; x += 14) {
        g.fillStyle = css(wall, 0.85 + r() * 0.25);
        g.fillRect(x + ((y / 6) % 2 ? 7 : 0), y, 13, 5);
      }
  } else {
    for (let i = 0; i < 6000; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + r() * 0.04})`;
      g.fillRect(r() * C * N, r() * C * N, 2, 2);
    }
  }
  const glass = new THREE.Color(st.glass);
  const frame = new THREE.Color(st.frame);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x0 = i * C;
      const y0 = j * C;
      // междуетажен корниз
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(x0, y0 + C - 3, C, 3);
      if (st.curtain) {
        const gr = g.createLinearGradient(x0, y0, x0 + C, y0 + C);
        gr.addColorStop(0, css(glass, 1.25));
        gr.addColorStop(0.5, css(glass, 0.85));
        gr.addColorStop(1, css(glass, 1.05));
        g.fillStyle = gr;
        g.fillRect(x0, y0 + 4, C, C - 10);
        g.fillStyle = css(frame);
        g.fillRect(x0, y0, C, 4);
        g.fillRect(x0, y0 + C - 6, C, 6);
        g.fillRect(x0 + C / 2 - 1, y0, 2, C);
        if (r() < 0.25) {
          e.g.fillStyle = 'rgba(255,214,150,0.9)';
          e.g.fillRect(x0 + 2, y0 + 6, C - 4, C - 14);
        }
        continue;
      }
      const w = C * st.winW;
      const h = C * st.winH;
      const wx = x0 + (C - w) / 2;
      const wy = y0 + (C - h) * 0.45;
      // рамка и перваз
      g.fillStyle = css(frame);
      g.fillRect(wx - 3, wy - 3, w + 6, h + 6);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(wx - 4, wy + h + 3, w + 8, 3);
      // стъкло с отражение на небето
      const gr = g.createLinearGradient(wx, wy, wx + w * 0.6, wy + h);
      gr.addColorStop(0, css(glass, 1.4));
      gr.addColorStop(0.45, css(glass, 0.95));
      gr.addColorStop(1, css(glass, 0.6));
      g.fillStyle = gr;
      g.fillRect(wx, wy, w, h);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(wx + w * 0.6, wy + 2, w * 0.12, h - 4);
      // кръстосана рамка
      g.fillStyle = css(frame);
      g.fillRect(wx + w / 2 - 1.5, wy, 3, h);
      if (r() < 0.35) {
        g.fillStyle = 'rgba(236,226,206,0.75)';
        g.fillRect(wx, wy, w * 0.3, h);
      }
      if (r() < 0.3) {
        e.g.fillStyle = r() < 0.5 ? 'rgba(255,214,150,1)' : 'rgba(255,236,190,1)';
        e.g.fillRect(wx, wy, w, h);
      }
    }
  const map = finish(key, c);
  const em = finish(key + ':e', e.c);
  return { map, emissive: em };
}

/** Витрина на партер: стъкло с надпис над нея. */
export function shopfrontTexture(color: number): THREE.Texture {
  const key = `shop:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, g } = canvas(128, 64);
  g.fillStyle = '#d8d4cc';
  g.fillRect(0, 0, 128, 64);
  const col = new THREE.Color(color);
  g.fillStyle = `rgb(${col.r * 255},${col.g * 255},${col.b * 255})`;
  g.fillRect(0, 0, 128, 16);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(10, 5, 60, 6);
  const gr = g.createLinearGradient(0, 18, 128, 64);
  gr.addColorStop(0, '#9fc3dc');
  gr.addColorStop(1, '#3e5a70');
  g.fillStyle = gr;
  g.fillRect(4, 20, 120, 42);
  g.fillStyle = '#e6e2da';
  for (const x of [42, 84]) g.fillRect(x, 20, 3, 42);
  return finish(key, c);
}
