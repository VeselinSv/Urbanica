import { DAYS_PER_MONTH, DAYS_PER_YEAR } from './balance';

/** Игрово време: тик 0 = ден 1, месец 1, година 1. Един тик = един игрови ден. */
export function gameDate(tick: number): { year: number; month: number; day: number; label: string } {
  const year = Math.floor(tick / DAYS_PER_YEAR) + 1;
  const dayOfYear = tick % DAYS_PER_YEAR;
  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1;
  const day = (dayOfYear % DAYS_PER_MONTH) + 1;
  return { year, month, day, label: `Д${day} М${month} Г${year}` };
}

export function isMonthEnd(tick: number): boolean {
  return (tick + 1) % DAYS_PER_MONTH === 0;
}

/** Парите се пазят като цели центове. 1 € = 100 евроцента. */
export function formatMoney(cents: number | bigint): string {
  const v = Number(cents) / 100;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)} млрд €`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)} млн €`;
  if (abs >= 1e4) return `${sign}${(abs / 1e3).toFixed(1)} хил €`;
  return `${sign}${abs.toFixed(2)} €`;
}

/** Превръща изчислена сума в цели центове с проверка за безопасен диапазон. */
export function toCents(value: number): number {
  const r = Math.round(value);
  if (!Number.isSafeInteger(r)) throw new Error(`Unsafe money value: ${value}`);
  return r;
}

export function bigToNum(v: bigint | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`Unsafe integer: ${v}`);
  return n;
}

/** Детерминистичен хеш на низ (FNV-1a). */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** Детерминистично псевдослучайно число в [0,1) от набор цели числа. */
export function rand01(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = hash2(h, p | 0, ((p * 7919) | 0) ^ 0x5bd1e995);
  return (h >>> 8) / 16777216;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const tileKey = (x: number, y: number) => `${x},${y}`;
export function parseKey(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}
