/**
 * Граница между градове: когато територията на един град опре до друг, двата могат да се свържат само с
 * градска магистрала. Докато в града няма магистрала от поне BORDER_HIGHWAY_MIN плочки, която стига до
 * границата със съседа, кметът може да строи само магистрала (и да събаря/отменя) – нищо друго.
 */
import { BALANCE, tileKey, type TileMap } from '@gce/shared';
import type { PrismaClient, Tx } from '@gce/database';

export const BORDER_HIGHWAY_MIN = 20;

export interface BorderStatus {
  /** съседни градове (територията им опира до нашата) */
  neighbors: { id: string; name: string }[];
  /** съседите, до чиято граница вече стига магистрала от поне 20 плочки */
  linked: string[];
  /** най-дългата магистрала (свързана, в плочки), която стига до граница със съсед */
  longest: number;
  /** строенето е блокирано, докато не се построи магистралата */
  blocked: boolean;
}

/** Състоянието на границите на града (по парцелите и плочките му). */
export async function borderStatus(db: PrismaClient | Tx, city: { id: string; parcels: { px: number; py: number }[]; tiles: unknown }): Promise<BorderStatus> {
  const mine = new Set(city.parcels.map((p) => `${p.px},${p.py}`));
  const around = new Set<string>();
  for (const p of city.parcels)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const k = `${p.px + dx},${p.py + dy}`;
      if (!mine.has(k)) around.add(k);
    }
  if (!around.size) return { neighbors: [], linked: [], longest: 0, blocked: false };
  const coords = [...around].map((k) => k.split(',').map(Number));
  const others = await db.parcel.findMany({
    where: { OR: coords.map(([px, py]) => ({ px, py })), NOT: { cityId: city.id } },
    select: { px: true, py: true, cityId: true },
  });
  if (!others.length) return { neighbors: [], linked: [], longest: 0, blocked: false };
  const ids = [...new Set(others.map((o) => o.cityId))];
  const names = await db.city.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  // плочките на чуждата територия до нашата граница (по съседен парцел)
  const S = BALANCE.world.parcelSize;
  const foreign = new Map<string, string>();
  for (const o of others) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) foreign.set(tileKey(o.px * S + i, o.py * S + j), o.cityId);
  // свързани компоненти от магистрални плочки
  const tiles = city.tiles as TileMap;
  const hw = new Set(Object.entries(tiles).filter(([, t]) => t.t === 'road' && t.c === 'highway').map(([k]) => k));
  const seen = new Set<string>();
  const linked = new Set<string>();
  let longest = 0;
  for (const start of hw) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const [x, y] = k.split(',').map(Number);
      for (const n of [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)])
        if (hw.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }
    // до кои съседи стига този участък (плочка до чужда територия)
    const reaches = new Set<string>();
    for (const k of comp) {
      const [x, y] = k.split(',').map(Number);
      for (const n of [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)]) {
        const c = foreign.get(n);
        if (c) reaches.add(c);
      }
    }
    if (reaches.size) longest = Math.max(longest, comp.length);
    if (comp.length >= BORDER_HIGHWAY_MIN) for (const c of reaches) linked.add(c);
  }
  const neighbors = names.map((n) => ({ id: n.id, name: n.name }));
  return { neighbors, linked: [...linked], longest, blocked: neighbors.some((n) => !linked.has(n.id)) };
}
