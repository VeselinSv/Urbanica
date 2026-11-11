import { BALANCE, FACILITIES, GOOD_IDS, roleAllows, tileKey, type CompanyAction, type FacilityType, type GoodId, type TileMap } from '@gce/shared';
import { Prisma, isUniqueViolation, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, ensureAccount, transfer } from './ledger';
import { idempotent } from './idempotency';
import { currentTick, refPrices, territoryKeys, worldGen } from './world';
import { lockCity } from './cities';
import { logEvent } from './events';
import { tryTakeGoods } from './inventory';

export async function rolesOf(db: Tx | PrismaClient, companyId: string, userId: string): Promise<string[]> {
  const rows = await db.companyRole.findMany({ where: { companyId, userId } });
  return rows.map((r) => r.role);
}

/**
 * Проверка на правата за корпоративно действие. Ролята в компанията-майка дава същите права в дъщерните дружества.
 */
export async function requirePermission(db: Tx | PrismaClient, companyId: string, userId: string, action: CompanyAction) {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw notFound('Компанията');
  if (company.status !== 'ACTIVE') throw new DomainError('COMPANY_INACTIVE', `Компанията е в статус ${company.status}`, 409);
  let roles = await rolesOf(db, companyId, userId);
  if (!roleAllows(roles, action) && company.parentCompanyId) roles = await rolesOf(db, company.parentCompanyId, userId);
  if (!roleAllows(roles, action)) throw forbidden(`Нужна е роля с право „${action}“ в компанията`);
  return company;
}

export async function foundCompany(prisma: PrismaClient, userId: string, input: { name: string; hqCityId: string; capital: number }, idemKey?: string) {
  try {
    return await withTx(prisma, (tx) =>
      idempotent(tx, userId, idemKey ? `company:${idemKey}` : undefined, async () => {
        const hq = await tx.city.findUnique({ where: { id: input.hqCityId } });
        if (!hq) throw notFound('Градът за седалище');
        const tick = await currentTick(tx);
        const company = await tx.company.create({
          data: {
            name: input.name,
            founderId: userId,
            hqCityId: input.hqCityId,
            totalShares: BALANCE.company.defaultShares,
            createdTick: tick,
            lastTick: tick - 1,
          },
        });
        const cAcc = await ensureAccount(tx, 'COMPANY', company.id);
        await transfer(tx, {
          from: acc.user(userId),
          to: cAcc,
          amount: input.capital,
          kind: 'CAPITAL_CONTRIBUTION',
          tick,
          key: `company-capital:${company.id}`,
          refType: 'Company',
          refId: company.id,
        });
        await tx.shareholding.create({ data: { companyId: company.id, holderType: 'USER', holderId: userId, shares: BALANCE.company.defaultShares } });
        await tx.companyRole.createMany({
          data: [
            { companyId: company.id, userId, role: 'CEO' },
            { companyId: company.id, userId, role: 'BOARD' },
          ],
        });
        await logEvent(tx, { tick, kind: 'company_founded', message: `Основана е компания „${input.name}“`, userId });
        return company;
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Компания с това име вече съществува');
    throw e;
  }
}

/** Може ли компанията да строи в този град: градове на собственика или на съюзници. */
async function canInvestInCity(tx: Tx, userId: string, cityOwnerId: string): Promise<boolean> {
  if (userId === cityOwnerId) return true;
  const [a, b] = await Promise.all([tx.allianceMember.findUnique({ where: { userId } }), tx.allianceMember.findUnique({ where: { userId: cityOwnerId } })]);
  return Boolean(a && b && a.allianceId === b.allianceId);
}

export async function buildFacility(
  prisma: PrismaClient,
  userId: string,
  companyId: string,
  input: { cityId: string; type: FacilityType; x: number; y: number },
  idemKey?: string,
) {
  const gen = await worldGen(prisma);
  const def = FACILITIES[input.type];
  try {
    return await withTx(prisma, (tx) =>
      idempotent(tx, userId, idemKey ? `facility:${idemKey}` : undefined, async () => {
        await requirePermission(tx, companyId, userId, 'operate');
        const city = await lockCity(tx, input.cityId);
        if (!(await canInvestInCity(tx, userId, city.ownerId))) throw forbidden('Може да строите само в свои градове или в градове на съюзници');
        const k = tileKey(input.x, input.y);
        if (!territoryKeys(city.parcels).includes(k)) throw bad('Плочката не е в територията на града');
        const tiles = { ...(city.tiles as unknown as TileMap) };
        if (tiles[k]) throw bad('Плочката е заета');
        const placement = gen.satisfiesPlacement(def.placement, input.x, input.y);
        if (!placement.ok) throw bad(placement.reason ?? 'Неподходящо място');
        const mult = gen.roadCostMult(input.x, input.y);
        const cost = Math.round(def.cost * (Number.isFinite(mult) ? Math.min(mult, 2) : 2));
        const tick = await currentTick(tx);
        const facility = await tx.facility.create({
          data: { companyId, cityId: input.cityId, type: input.type, x: input.x, y: input.y, builtTick: tick, cost: BigInt(cost) },
        });
        await transfer(tx, {
          from: acc.company(companyId),
          to: SYS.WORLD,
          amount: cost,
          kind: 'FACILITY_CONSTRUCTION',
          tick,
          key: `facility-build:${facility.id}`,
          refType: 'Facility',
          refId: facility.id,
        });
        tiles[k] = { t: 'facility', f: input.type, companyId, facilityId: facility.id };
        await tx.city.update({ where: { id: city.id }, data: { tiles: tiles as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
        return { ...facility, cost, placementFactor: placement.factor };
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Плочката вече е заета от друго съоръжение');
    throw e;
  }
}

/** Модернизация с машини: изразходва машини от склада в същия град, +25% капацитет. */
export async function upgradeFacility(prisma: PrismaClient, userId: string, facilityId: string) {
  return withTx(prisma, async (tx) => {
    const f = await tx.facility.findUnique({ where: { id: facilityId } });
    if (!f) throw notFound('Съоръжението');
    await requirePermission(tx, f.companyId, userId, 'operate');
    if (f.upgrades >= BALANCE.company.maxUpgrades) throw bad('Достигнат е максимумът модернизации');
    if (FACILITIES[f.type as FacilityType].storageBonus) throw bad('Складовете не се модернизират');
    const ok = await tryTakeGoods(tx, f.companyId, f.cityId, 'machinery', BALANCE.company.machineryUpgradeUnits);
    if (!ok) throw bad(`Нужни са ${BALANCE.company.machineryUpgradeUnits} машини в склада в този град`);
    return tx.facility.update({ where: { id: facilityId }, data: { upgrades: { increment: 1 } } });
  });
}

/** Премахване на съоръжение с частично възстановяване на стойността (изпълнява се след гласуване SELL_FACILITY). */
export async function sellFacility(tx: Tx, facilityId: string, tick: number): Promise<number> {
  const f = await tx.facility.findUnique({ where: { id: facilityId } });
  if (!f) throw notFound('Съоръжението');
  const city = await lockCity(tx, f.cityId);
  const tiles = { ...(city.tiles as unknown as TileMap) };
  delete tiles[tileKey(f.x, f.y)];
  await tx.city.update({ where: { id: city.id }, data: { tiles: tiles as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
  await tx.facility.delete({ where: { id: facilityId } });
  const proceeds = Math.round(Number(f.cost) * BALANCE.company.facilityResaleShare * f.condition);
  await transfer(tx, {
    from: SYS.WORLD,
    to: acc.company(f.companyId),
    amount: proceeds,
    kind: 'ASSET_SALE',
    tick,
    key: `facility-sale:${facilityId}`,
    refType: 'Facility',
    refId: facilityId,
  });
  return proceeds;
}

/** Балансова стойност: пари + стоки по референтни цени + съоръжения (амортизирани) − дълг. */
export async function companyValuation(db: Tx | PrismaClient, companyId: string) {
  const [account, inv, facilities, loans, prices] = await Promise.all([
    db.account.findUnique({ where: { id: acc.company(companyId) } }),
    db.inventory.findMany({ where: { companyId } }),
    db.facility.findMany({ where: { companyId } }),
    db.loan.findMany({ where: { borrowerType: 'COMPANY', borrowerId: companyId, status: { in: ['ACTIVE', 'RESTRUCTURED', 'DEFAULTED'] } } }),
    refPrices(db),
  ]);
  const cash = Number(account?.balance ?? 0n);
  let inventoryValue = 0;
  for (const i of inv) inventoryValue += (i.quantity + i.reserved) * (prices[i.good as GoodId] ?? 0);
  let fixedAssets = 0;
  for (const f of facilities) fixedAssets += Number(f.cost) * 0.6 * f.condition;
  const debt = loans.reduce((a, l) => a + Number(l.outstanding), 0);
  const assets = cash + inventoryValue + Math.round(fixedAssets);
  return { cash, inventoryValue, fixedAssets: Math.round(fixedAssets), assets, debt, equity: assets - debt };
}

export async function listCompanies(prisma: PrismaClient) {
  const companies = await prisma.company.findMany({ orderBy: { createdAt: 'asc' }, take: 300 });
  const founders = await prisma.user.findMany({ where: { id: { in: companies.map((c) => c.founderId) } }, select: { id: true, username: true } });
  const fname = new Map(founders.map((f) => [f.id, f.username]));
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    founder: fname.get(c.founderId) ?? '?',
    status: c.status,
    rating: c.rating,
    totalShares: c.totalShares,
    hqCityId: c.hqCityId,
    parentCompanyId: c.parentCompanyId,
  }));
}

/** Публична част на компания + поверителна част за ролите и акционерите (проверка на сървъра). */
export async function getCompany(prisma: PrismaClient, companyId: string, viewerId: string) {
  const c = await prisma.company.findUnique({ where: { id: companyId } });
  if (!c) throw notFound('Компанията');
  const [holders, roles, facilities, valuation, stats, lastTrade] = await Promise.all([
    prisma.shareholding.findMany({ where: { companyId, shares: { gt: 0 } } }),
    prisma.companyRole.findMany({ where: { companyId } }),
    prisma.facility.findMany({ where: { companyId }, orderBy: { builtTick: 'asc' } }),
    companyValuation(prisma, companyId),
    prisma.companyStat.findMany({ where: { companyId }, orderBy: { tick: 'desc' }, take: 60 }),
    prisma.trade.findFirst({ where: { instrument: `SHARE:${companyId}` }, orderBy: { id: 'desc' } }),
  ]);
  const userIds = [...new Set([...holders.filter((h) => h.holderType === 'USER').map((h) => h.holderId), ...roles.map((r) => r.userId)])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } });
  const companyHolders = await prisma.company.findMany({
    where: { id: { in: holders.filter((h) => h.holderType === 'COMPANY').map((h) => h.holderId) } },
    select: { id: true, name: true },
  });
  const uname = new Map(users.map((u) => [u.id, u.username]));
  const cname = new Map(companyHolders.map((x) => [x.id, x.name]));
  const myRoles = roles.filter((r) => r.userId === viewerId).map((r) => r.role);
  const parentRoles = c.parentCompanyId ? await rolesOf(prisma, c.parentCompanyId, viewerId) : [];
  const isInsider = myRoles.length > 0 || parentRoles.length > 0;
  const myShares = holders.find((h) => h.holderType === 'USER' && h.holderId === viewerId)?.shares ?? 0;
  const bookPerShare = Math.max(0, Math.round(valuation.equity / c.totalShares));
  // Публичен финансов отчет: обобщени месечни данни за всички; подробности само за вътрешни лица и акционери.
  const publicReport = stats.slice(0, 30).reduce(
    (a, s) => {
      const d = s.data as Record<string, number>;
      a.revenue += d.revenue ?? 0;
      a.costs += d.costs ?? 0;
      a.profit += d.profit ?? 0;
      return a;
    },
    { revenue: 0, costs: 0, profit: 0, days: Math.min(30, stats.length) },
  );
  const base = {
    id: c.id,
    name: c.name,
    status: c.status,
    rating: c.rating,
    creditScore: c.creditScore,
    hqCityId: c.hqCityId,
    parentCompanyId: c.parentCompanyId,
    totalShares: c.totalShares,
    shareholders: holders.map((h) => ({
      holderType: h.holderType,
      holderId: h.holderId,
      name: h.holderType === 'USER' ? uname.get(h.holderId) : cname.get(h.holderId),
      shares: h.shares,
      pct: Math.round((h.shares / c.totalShares) * 10000) / 100,
    })),
    roles: roles.map((r) => ({ userId: r.userId, username: uname.get(r.userId), role: r.role })),
    facilities: facilities.map((f) => ({ id: f.id, type: f.type, cityId: f.cityId, x: f.x, y: f.y })),
    valuation: {
      assets: valuation.assets,
      debt: valuation.debt,
      equity: valuation.equity,
      bookPerShare,
      lastSharePrice: lastTrade ? Number(lastTrade.price) : null,
    },
    publicReport,
    myRoles,
    parentRoles,
    myShares,
  };
  if (!isInsider && myShares === 0) return base;
  const [inventory, orders, contracts, loans, research, shipments] = await Promise.all([
    prisma.inventory.findMany({ where: { companyId } }),
    prisma.marketOrder.findMany({ where: { traderType: 'COMPANY', traderId: companyId, status: 'OPEN' } }),
    prisma.contract.findMany({ where: { OR: [{ sellerCompanyId: companyId }, { buyerCompanyId: companyId }] }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.loan.findMany({ where: { borrowerType: 'COMPANY', borrowerId: companyId }, orderBy: { createdAt: 'desc' } }),
    prisma.researchProject.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    prisma.shipment.findMany({ where: { companyId, status: 'IN_TRANSIT' } }),
  ]);
  return {
    ...base,
    insider: isInsider,
    cash: valuation.cash,
    valuationDetail: valuation,
    facilitiesDetail: facilities,
    inventory,
    orders,
    contracts,
    loans,
    research,
    shipments,
    stats: stats.reverse().map((s) => ({ tick: s.tick, ...(s.data as object) })),
  };
}

export async function myCompanies(prisma: PrismaClient, userId: string) {
  const roles = await prisma.companyRole.findMany({ where: { userId } });
  const holdings = await prisma.shareholding.findMany({ where: { holderType: 'USER', holderId: userId, shares: { gt: 0 } } });
  const ids = [...new Set([...roles.map((r) => r.companyId), ...holdings.map((h) => h.companyId)])];
  const companies = await prisma.company.findMany({ where: { id: { in: ids } } });
  const accounts = await prisma.account.findMany({ where: { id: { in: ids.map((i) => acc.company(i)) } } });
  const bal = new Map(accounts.map((a) => [a.ownerId, Number(a.balance)]));
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    rating: c.rating,
    hqCityId: c.hqCityId,
    cash: roles.some((r) => r.companyId === c.id) ? (bal.get(c.id) ?? 0) : null,
    roles: roles.filter((r) => r.companyId === c.id).map((r) => r.role),
    shares: holdings.find((h) => h.companyId === c.id)?.shares ?? 0,
    totalShares: c.totalShares,
  }));
}

export { GOOD_IDS };
