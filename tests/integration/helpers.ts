import { getPrisma } from '@gce/database';
import { addGoods, build, ensureWorld, foundCity, foundCompany, getCity, register, worldGen } from '@gce/domain';
import { BALANCE, tileKey } from '@gce/shared';
import { withTx } from '@gce/database';
import { checkInvariants } from '../../apps/worker/src/invariants';

export const prisma = getPrisma();

const TABLES = [
  'User',
  'Session',
  'PasswordReset',
  'World',
  'TickRun',
  'Account',
  'LedgerEntry',
  'City',
  'Parcel',
  'CityStat',
  'Company',
  'Shareholding',
  'CompanyRole',
  'Facility',
  'Inventory',
  'MarketState',
  'MarketOrder',
  'Trade',
  'PriceHistory',
  'Shipment',
  'Contract',
  'Loan',
  'Proposal',
  'Vote',
  'ResearchProject',
  'Patent',
  'License',
  'Alliance',
  'AllianceMember',
  'AllianceInvite',
  'AllianceSanction',
  'ChatMessage',
  'Friendship',
  'Block',
  'Report',
  'Notification',
  'WorldEvent',
  'CompanyStat',
  'IdempotencyRecord',
  'AuditLog',
  'WorkerLease',
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(',')} CASCADE`);
  await ensureWorld(prisma, 'integration-seed', 1);
}

let n = 0;
export async function player(prefix = 'P') {
  n++;
  const name = `${prefix}${n}_${Math.random().toString(36).slice(2, 6)}`;
  const r = await register(prisma, { username: name, email: `${name.toLowerCase()}@test.local`, password: 'password123' });
  return { id: r.user.id, token: r.token, name };
}

/** Град с път и основни услуги; връща и свободни плочки до пътя. */
export async function cityWithRoad(userId: string) {
  const city = await foundCity(prisma, userId, `Град ${userId.slice(-4)}`);
  const view = (await getCity(prisma, city.id, userId)) as { parcels: { px: number; py: number }[] };
  const s = BALANCE.world.parcelSize;
  const ox = Math.min(...view.parcels.map((p) => p.px)) * s;
  const oy = Math.min(...view.parcels.map((p) => p.py)) * s;
  const gen = await worldGen(prisma);
  const road: { x: number; y: number }[] = [];
  for (let x = 0; x < 24; x++) if (gen.buildable(ox + x, oy + 10)) road.push({ x: ox + x, y: oy + 10 });
  await build(prisma, userId, city.id, { action: 'road', tiles: road });
  const free: { x: number; y: number }[] = [];
  for (let x = 0; x < 24; x++) for (const dy of [9, 11]) if (gen.buildable(ox + x, oy + dy)) free.push({ x: ox + x, y: oy + dy });
  return { city, ox, oy, free, road, key: (x: number, y: number) => tileKey(x, y) };
}

export async function companyIn(userId: string, cityId: string, capital = 2_000_000) {
  return foundCompany(prisma, userId, { name: `Co_${userId.slice(-5)}_${Math.random().toString(36).slice(2, 5)}`, hqCityId: cityId, capital });
}

/** Тестова наличност (подготовка на сценарий). */
export async function giveGoods(companyId: string, cityId: string, good: Parameters<typeof addGoods>[3], qty: number) {
  await withTx(prisma, (tx) => addGoods(tx, companyId, cityId, good, qty, 100));
}

export async function balance(id: string) {
  const a = await prisma.account.findUnique({ where: { id } });
  return Number(a?.balance ?? 0n);
}

export async function expectInvariants() {
  const r = await checkInvariants(prisma);
  const failed = r.checks.filter((c) => !c.ok);
  if (failed.length) throw new Error(`Нарушени инварианти: ${failed.map((f) => `${f.name}: ${f.detail}`).join(' | ')}`);
}
