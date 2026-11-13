/**
 * Кеш в паметта на тежките данни на град (плочки, население, парцели), валиден за точна версия на реда.
 *
 * При ден от 1 секунда градът се чете от базата всяка секунда, а клиентите го опресняват на ~2.5 s –
 * това е основният трафик към базата. Плочките, населението и парцелите се променят само заедно с
 * `version` (строене, симулация, покупка на парцел, политики), затова е достатъчно да се прочете малкият
 * ред с версията: при съвпадение тежките данни идват от паметта. При няколко процеса кешът просто
 * пропуска (версията не съвпада) – коректността не зависи от него.
 */
import type { PrismaClient } from '@gce/database';

export interface CityHeavy {
  version: number;
  tiles: unknown;
  pop: unknown;
  parcels: { px: number; py: number }[];
}

const MAX = 1000;
const cache = new Map<string, CityHeavy>();

export function cachedCity(cityId: string, version: number): CityHeavy | null {
  const e = cache.get(cityId);
  return e && e.version === version ? e : null;
}

export function rememberCity(cityId: string, e: CityHeavy) {
  cache.delete(cityId);
  cache.set(cityId, e);
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
}

export function forgetCity(cityId: string) {
  cache.delete(cityId);
}

/** Тежките данни за версията `version` – от паметта или (веднъж) от базата. null: градът е изчезнал или е сменен междувременно. */
export async function loadCityHeavy(prisma: PrismaClient, cityId: string, version: number): Promise<CityHeavy | null> {
  const hit = cachedCity(cityId, version);
  if (hit) return hit;
  const row: CityHeavy | null = await prisma.city.findUnique({
    where: { id: cityId },
    select: { version: true, tiles: true, pop: true, parcels: { select: { px: true, py: true } } },
  });
  if (!row) {
    forgetCity(cityId);
    return null;
  }
  rememberCity(cityId, row);
  return row.version === version ? row : null;
}
