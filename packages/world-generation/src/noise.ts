import { mulberry32 } from '@gce/shared';

/** Seeded 2D Perlin шум (класически, с градиенти). Детерминистичен за даден seed. */
export class Perlin2D {
  private perm: Uint8Array;

  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private static fade(t: number) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private static grad(h: number, x: number, y: number) {
    switch (h & 7) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      case 3:
        return -x - y;
      case 4:
        return x;
      case 5:
        return -x;
      case 6:
        return y;
      default:
        return -y;
    }
  }

  /** Стойност приблизително в [-1, 1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const X = xi & 255;
    const Y = yi & 255;
    const xf = x - xi;
    const yf = y - yi;
    const u = Perlin2D.fade(xf);
    const v = Perlin2D.fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = Perlin2D.grad(aa, xf, yf) + u * (Perlin2D.grad(ba, xf - 1, yf) - Perlin2D.grad(aa, xf, yf));
    const x2 = Perlin2D.grad(ab, xf, yf - 1) + u * (Perlin2D.grad(bb, xf - 1, yf - 1) - Perlin2D.grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.95;
  }

  /** Фрактален шум (fBm), резултат в [0, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return Math.min(1, Math.max(0, (sum / norm) * 0.5 + 0.5));
  }
}
