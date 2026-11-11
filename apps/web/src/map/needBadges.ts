/**
 * Значки над сградите: какво им липсва, за да се построят или надградят.
 * Съседните сгради с една и съща липса се групират в една значка (с брой), за да няма шум.
 */
import { UPGRADE_REQUIREMENT_LABELS, ZONES, parseKey, tileKey, type CityDerived, type TileMap, type UpgradeRequirement } from '@gce/shared';
import type { CityDetail } from '../store';
import { REQ_ICON } from '../ui/needs';
import type { NeedBadge } from './life';

/** Липси, които играчът оправя директно с инструмент – само те се показват като значки. */
const BADGE_REQS: UpgradeRequirement[] = ['road', 'power', 'water', 'sidewalk'];

export function computeNeedBadges(city: CityDetail, derived: CityDerived | null): NeedBadge[] {
  const tiles = city.tiles as TileMap;
  // достъп до път (до 2 плочки, както в симулацията)
  const access = new Set<string>();
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'road') continue;
    const [x, y] = parseKey(k);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 2) access.add(tileKey(x + dx, y + dy));
  }
  const noPower = (city.stats?.power?.supply ?? 1) <= 0;
  const noWater = (city.stats?.water?.supply ?? 1) <= 0;
  const groups = new Map<string, { req: UpgradeRequirement; sev: 1 | 2; keys: string[] }>();
  const add = (req: UpgradeRequirement, sev: 1 | 2, k: string) => {
    const id = `${req}|${sev}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { req, sev, keys: [] }));
    g.keys.push(k);
  };
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'zone' || t.ab) continue;
    if (t.lvl === 0) {
      if (t.prog > 0) continue;
      const util = ZONES[t.z].needsUtilities;
      if (!access.has(k)) add('road', 1, k);
      else if (util && noPower) add('power', 1, k);
      else if (util && noWater) add('water', 1, k);
      continue;
    }
    const info = derived?.levels?.[k];
    if (!info) continue;
    const keep = info.keep.find((r) => BADGE_REQS.includes(r));
    if (keep) {
      add(keep, 2, k);
      continue;
    }
    const next = info.next.find((r) => BADGE_REQS.includes(r));
    if (next) add(next, 1, k);
  }
  // групиране на съседни плочки (8 посоки)
  const out: NeedBadge[] = [];
  for (const g of groups.values()) {
    const left = new Set(g.keys);
    for (const start of g.keys) {
      if (!left.has(start)) continue;
      left.delete(start);
      const comp = [start];
      for (let i = 0; i < comp.length; i++) {
        const [x, y] = parseKey(comp[i]);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = tileKey(x + dx, y + dy);
            if (left.has(n)) {
              left.delete(n);
              comp.push(n);
            }
          }
      }
      let sx = 0;
      let sy = 0;
      for (const k of comp) {
        const [x, y] = parseKey(k);
        sx += x;
        sy += y;
      }
      sx /= comp.length;
      sy /= comp.length;
      let best = comp[0];
      let bd = Infinity;
      for (const k of comp) {
        const [x, y] = parseKey(k);
        const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      const [bx, by] = parseKey(best);
      const verb = g.sev === 2 ? 'губят ниво' : 'чакат';
      out.push({
        x: bx,
        y: by,
        icon: REQ_ICON[g.req],
        count: comp.length,
        sev: g.sev,
        title: `${comp.length} сгради ${verb}: ${UPGRADE_REQUIREMENT_LABELS[g.req]}`,
      });
    }
  }
  return out;
}
