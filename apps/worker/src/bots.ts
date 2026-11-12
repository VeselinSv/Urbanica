import { BALANCE, FACILITIES, tileKey, type FacilityType, type ServiceType, type ZoneType, ECON } from '@gce/shared';
import type { PrismaClient } from '@gce/database';
import { build, buildFacility, foundCity, foundCompany, getCity, register, worldGen } from '@gce/domain';

/**
 * Автоматизиран тестов играч: създава акаунт, град по шаблон и компания с производствена верига.
 * Използва само публичните домейн операции (същите като API) – без заобикаляне на правилата.
 */
export interface Bot {
  userId: string;
  token: string;
  username: string;
  cityId: string;
  companyId: string | null;
  facilities: { id: string; type: FacilityType }[];
}

export async function createBot(prisma: PrismaClient, name: string, opts: { company?: boolean; facilities?: FacilityType[] } = {}): Promise<Bot> {
  const reg = await register(prisma, { username: name, email: `${name.toLowerCase()}@bots.test`, password: 'bot-password-123' });
  const city = await foundCity(prisma, reg.user.id, `${name} Сити`);
  const view = (await getCity(prisma, city.id, reg.user.id)) as { parcels: { px: number; py: number }[] };
  const s = BALANCE.world.parcelSize;
  const px0 = Math.min(...view.parcels.map((p) => p.px));
  const py0 = Math.min(...view.parcels.map((p) => p.py));
  const ox = px0 * s;
  const oy = py0 * s;
  const gen = await worldGen(prisma);
  const size = BALANCE.world.startParcels * s;
  const land = (x: number, y: number) => gen.buildable(ox + x, oy + y);
  // Пътна мрежа: хоризонтални улици на всеки 5 реда и една вертикална в средата.
  const road: { x: number; y: number }[] = [];
  for (const ry of [2, 7, 12, 17, 22]) for (let x = 0; x < size; x++) if (land(x, ry)) road.push({ x: ox + x, y: oy + ry });
  for (let y = 0; y < size; y++) if (land(12, y)) road.push({ x: ox + 12, y: oy + y });
  await build(prisma, reg.user.id, city.id, { action: 'road', tiles: road });
  const taken = new Set(road.map((r) => tileKey(r.x, r.y)));
  const free = (x: number, y: number) => land(x, y) && !taken.has(tileKey(ox + x, oy + y));
  // Обществени услуги на ред 1 – по реалните цени стартовият бюджет стига за ток от вятър, вода и основни услуги.
  const services: ServiceType[] = ['power_wind', 'power_wind', 'water_pump', 'school', 'fire_station', 'police_station'];
  let sx = 0;
  for (const svc of services) {
    while (sx < size && !free(sx, 1)) sx++;
    if (sx >= size) break;
    await build(prisma, reg.user.id, city.id, { action: 'service', service: svc, tiles: [{ x: ox + sx, y: oy + 1 }] }).catch((e: Error) =>
      console.warn(`[bot ${name}] ${svc} at x=${sx}: ${e.message}`),
    );
    taken.add(tileKey(ox + sx, oy + 1));
    sx += 2;
  }
  // Зони около улиците.
  const zoneRows: [ZoneType, number[]][] = [
    ['R', [3, 6, 8, 11]],
    ['C', [13]],
    ['I', [16, 18]],
    ['O', [21]],
    ['A', [23]],
  ];
  for (const [z, rows] of zoneRows) {
    const tiles: { x: number; y: number }[] = [];
    for (const y of rows) for (let x = 0; x < size; x++) if (free(x, y)) tiles.push({ x: ox + x, y: oy + y });
    for (const t of tiles) taken.add(tileKey(t.x, t.y));
    // Оставяме по няколко плочки свободни за предприятия.
    if (tiles.length)
      await build(prisma, reg.user.id, city.id, { action: 'zone', zone: z, tiles: tiles.slice(0, Math.max(1, tiles.length - 4)) }).catch((e: Error) =>
        console.warn(`[bot ${name}] zone ${z}: ${e.message}`),
      );
    for (const t of tiles.slice(Math.max(1, tiles.length - 4))) taken.delete(tileKey(t.x, t.y));
  }
  const bot: Bot = { userId: reg.user.id, token: reg.token, username: name, cityId: city.id, companyId: null, facilities: [] };
  if (opts.company === false) return bot;
  const company = await foundCompany(prisma, reg.user.id, { name: `${name} Индъстрис`, hqCityId: city.id, capital: 4_000_000 * ECON });
  bot.companyId = company.id;
  for (const type of opts.facilities ?? []) {
    const def = FACILITIES[type];
    let placed = false;
    for (let y = 0; y < size && !placed; y++)
      for (let x = 0; x < size && !placed; x++) {
        if (!free(x, y)) continue;
        // Близо до път (разстояние ≤ 2), за да получи ток и работници.
        const nearRoad = road.some((r) => Math.abs(r.x - (ox + x)) + Math.abs(r.y - (oy + y)) <= 2);
        if (!nearRoad) continue;
        if (!gen.satisfiesPlacement(def.placement, ox + x, oy + y).ok) continue;
        try {
          const f = await buildFacility(prisma, reg.user.id, company.id, { cityId: city.id, type, x: ox + x, y: oy + y });
          bot.facilities.push({ id: f.id, type });
          taken.add(tileKey(ox + x, oy + y));
          placed = true;
        } catch {
          /* опит на следваща плочка */
        }
      }
  }
  return bot;
}
