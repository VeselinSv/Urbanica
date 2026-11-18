/**
 * Обхват на услугите – смята се в браузъра от плочките на града със същите правила като симулацията
 * (радиус на сградата, спирките дават обхват само ако има автобусно депо). Силата спада към края на кръга.
 */
import { BALANCE, SERVICES, tileKey, type ServiceType, type TileMap } from '@gce/shared';
import type { CoverageOf } from '../store';

export const COVERAGE_KINDS: Exclude<CoverageOf, 'all'>[] = ['police_station', 'fire_station', 'clinic', 'school', 'university', 'bus_depot', 'park', 'parking'];
/** Основните услуги, от които зависят растежът и удовлетвореността (режим „Всички“). */
export const CORE_KINDS: Exclude<CoverageOf, 'all'>[] = ['police_station', 'fire_station', 'clinic', 'school'];

export const COVERAGE_ICON: Record<Exclude<CoverageOf, 'all'>, string> = {
  police_station: '👮',
  fire_station: '🚒',
  clinic: '🏥',
  school: '🏫',
  university: '🎓',
  bus_depot: '🚌',
  park: '🌳',
  parking: '🅿',
};

export function serviceColor(kind: ServiceType): number {
  return SERVICES[kind].color ?? 0x60a5fa;
}

/** Сила на обхвата (0..1) по плочки за една услуга. */
export function coverageFor(tiles: TileMap, territory: string[], kind: Exclude<CoverageOf, 'all'>): Record<string, number> {
  const srcs: { x: number; y: number; r: number }[] = [];
  let hasDepot = false;
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t === 'service' && t.s === kind) {
      const [x, y] = k.split(',').map(Number);
      srcs.push({ x, y, r: SERVICES[kind].radius });
    }
    if (t.t === 'service' && t.s === 'bus_depot') hasDepot = true;
  }
  if (kind === 'bus_depot' && hasDepot)
    for (const [k, t] of Object.entries(tiles))
      if (t.t === 'road' && t.st) {
        const [x, y] = k.split(',').map(Number);
        srcs.push({ x, y, r: BALANCE.construction.busStopRadius });
      }
  const out: Record<string, number> = {};
  if (!srcs.length) return out;
  for (const k of territory) {
    const [x, y] = k.split(',').map(Number);
    let best = 0;
    for (const s of srcs) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= s.r) best = Math.max(best, 1 - (d / (s.r + 1)) * 0.5);
    }
    if (best > 0) out[k] = best;
  }
  return out;
}

export function territoryOf(parcels: { px: number; py: number }[]): string[] {
  const P = BALANCE.world.parcelSize;
  const out: string[] = [];
  for (const p of parcels) for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) out.push(tileKey(p.px * P + i, p.py * P + j));
  return out;
}

export interface CoverageView {
  /** плочка → [цвят, прозрачност] */
  cells: Record<string, [number, number]>;
  /** заети сгради (зони с ниво > 0) с/без обхват */
  covered: number;
  uncovered: number;
  /** брой сгради на услугата */
  sources: number;
}

/** Какво да се нарисува: една услуга (нейният цвят, по-силно до сградата) или „Всички“ – колко от 4-те основни стигат. */
export function coverageView(tiles: TileMap, parcels: { px: number; py: number }[], of: CoverageOf): CoverageView {
  const territory = territoryOf(parcels);
  const buildings = Object.entries(tiles).filter(([, t]) => t.t === 'zone' && t.lvl > 0);
  const cells: Record<string, [number, number]> = {};
  let covered = 0;
  let sources = 0;
  if (of === 'all') {
    const maps = CORE_KINDS.map((k) => coverageFor(tiles, territory, k));
    for (const k of territory) {
      const n = maps.reduce((a, m) => a + (m[k] ? 1 : 0), 0);
      // 0 → червено, 2 → жълто, 4 → зелено
      cells[k] = [n >= 4 ? 0x22c55e : n === 3 ? 0x84cc16 : n === 2 ? 0xeab308 : n === 1 ? 0xf97316 : 0xef4444, n ? 0.38 : 0.2];
    }
    for (const [k] of buildings) if (maps.every((m) => m[k])) covered++;
    for (const t of Object.values(tiles)) if (t.t === 'service' && (CORE_KINDS as string[]).includes(t.s)) sources++;
  } else {
    const m = coverageFor(tiles, territory, of);
    const color = serviceColor(of);
    for (const [k, v] of Object.entries(m)) cells[k] = [color, 0.18 + 0.4 * v];
    for (const [k] of buildings) {
      if (m[k]) covered++;
      else cells[k] = [0xef4444, 0.35];
    }
    for (const t of Object.values(tiles)) if (t.t === 'service' && t.s === of) sources++;
  }
  return { cells, covered, uncovered: buildings.length - covered, sources };
}
