import { BALANCE, FACILITIES, type FacilityType, type GoodId, type PopulationState } from '@gce/shared';
import { produce, requiredJobs, techEffects } from '@gce/economy-engine';
import type { PrismaClient } from '@gce/database';
import { notFound } from './errors';
import { SYS, acc } from './ledger';
import { refPrices, worldGen, worldRow } from './world';
import { companyValuation } from './companies';

/** Обща картина на световната икономика (публична). */
export async function worldOverview(prisma: PrismaClient) {
  const w = await worldRow(prisma);
  const [mint, world, fees, bank, escrow, cities, companies, users, runs] = await Promise.all([
    prisma.account.findUnique({ where: { id: SYS.MINT } }),
    prisma.account.findUnique({ where: { id: SYS.WORLD } }),
    prisma.account.findUnique({ where: { id: SYS.FEES } }),
    prisma.account.findUnique({ where: { id: SYS.BANK } }),
    prisma.account.findUnique({ where: { id: SYS.ESCROW } }),
    prisma.city.findMany({ select: { stats: true } }),
    prisma.company.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count(),
    prisma.tickRun.findMany({ orderBy: { tick: 'desc' }, take: 20 }),
  ]);
  let population = 0;
  let gdp = 0;
  for (const c of cities) {
    const s = c.stats as Record<string, number>;
    population += s.population ?? 0;
    gdp += s.gdp ?? 0;
  }
  const durations = runs.map((r) => r.durationMs ?? 0).filter(Boolean);
  return {
    tick: w.tick,
    baseRate: w.baseRate,
    priceIndex: w.priceIndex,
    creditOutstanding: Number(w.creditOutstanding),
    moneyCreated: -Number(mint?.balance ?? 0n),
    worldNetPosition: Number(world?.balance ?? 0n),
    feesCollected: Number(fees?.balance ?? 0n),
    bankReserves: Number(bank?.balance ?? 0n),
    escrow: Number(escrow?.balance ?? 0n),
    population,
    gdp,
    cities: cities.length,
    companies,
    players: users,
    avgAttractiveness: w.avgAttractiveness,
    sim: {
      avgTickMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      lastTicks: runs.map((r) => ({ tick: r.tick, durationMs: r.durationMs, phases: r.phases })),
    },
  };
}

/** Класация по нетна стойност: портфейл + акции по балансова стойност. */
export async function leaderboard(prisma: PrismaClient) {
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  const wallets = await prisma.account.findMany({ where: { ownerType: 'USER' } });
  const wallet = new Map(wallets.map((a) => [a.ownerId, Number(a.balance)]));
  const holdings = await prisma.shareholding.findMany({ where: { holderType: 'USER', shares: { gt: 0 } } });
  const companies = await prisma.company.findMany({ where: { status: 'ACTIVE' } });
  const perShare = new Map<string, number>();
  for (const c of companies) {
    const v = await companyValuation(prisma, c.id);
    perShare.set(c.id, Math.max(0, v.equity) / c.totalShares);
  }
  const cities = await prisma.city.findMany({ select: { ownerId: true, stats: true } });
  return users
    .map((u) => {
      const shares = holdings.filter((h) => h.holderId === u.id).reduce((a, h) => a + h.shares * (perShare.get(h.companyId) ?? 0), 0);
      const myCities = cities.filter((c) => c.ownerId === u.id);
      const population = myCities.reduce((a, c) => a + ((c.stats as Record<string, number>).population ?? 0), 0);
      return { userId: u.id, username: u.username, netWorth: Math.round((wallet.get(u.id) ?? 0) + shares), population, cities: myCities.length };
    })
    .sort((a, b) => b.netWorth - a.netWorth)
    .slice(0, 50);
}

/** Линейна регресия за кратка прогноза на времеви ред (с доверителен интервал ±2σ на остатъците). */
export function forecast(series: number[], horizon: number) {
  const n = series.length;
  if (n < 3) return { slope: 0, points: [] as { step: number; value: number; low: number; high: number }[] };
  const xs = series.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (series[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const icpt = my - slope * mx;
  const resid = Math.sqrt(series.reduce((a, y, i) => a + (y - (icpt + slope * i)) ** 2, 0) / Math.max(1, n - 2));
  const points = [];
  for (let h = 1; h <= horizon; h++) {
    const v = icpt + slope * (n - 1 + h);
    points.push({ step: h, value: Math.round(v), low: Math.round(v - 2 * resid), high: Math.round(v + 2 * resid) });
  }
  return { slope, points };
}

export async function cityHistory(prisma: PrismaClient, cityId: string, viewerId: string, days = 120) {
  const city = await prisma.city.findUnique({ where: { id: cityId }, select: { ownerId: true } });
  if (!city) throw notFound('Градът');
  const rows = await prisma.cityStat.findMany({ where: { cityId }, orderBy: { tick: 'desc' }, take: Math.min(720, days) });
  const isOwner = city.ownerId === viewerId;
  const series = rows.reverse().map((r) => {
    const d = r.data as Record<string, unknown>;
    const base = {
      tick: r.tick,
      population: d.population,
      unemploymentRate: d.unemploymentRate,
      happiness: d.happiness,
      landValueAvg: d.landValueAvg,
      gdp: d.gdp,
    };
    return isOwner
      ? {
          ...base,
          net: d.net,
          treasury: d.treasury,
          income: d.income,
          expenses: d.expenses,
          wages: d.wages,
          power: d.power,
          water: d.water,
          pollutionAvg: d.pollutionAvg,
          congestion: (d.traffic as Record<string, number> | undefined)?.congestion,
        }
      : base;
  });
  const pop = series.map((s) => Number(s.population ?? 0));
  return { series, forecast: { population: forecast(pop.slice(-60), 30) } };
}

/**
 * Инвестиционен симулатор: очакван дневен резултат на ново съоръжение при текущите цени, заплати и място.
 * Използва същата производствена функция като симулацията (няма отделна "демо" логика).
 */
export async function simulateInvestment(prisma: PrismaClient, input: { cityId: string; type: FacilityType; x?: number; y?: number; staffing?: number }) {
  const city = await prisma.city.findUnique({ where: { id: input.cityId } });
  if (!city) throw notFound('Градът');
  const refs = await refPrices(prisma);
  const def = FACILITIES[input.type];
  const fx = techEffects(input.type, []);
  const gen = await worldGen(prisma);
  const placement =
    input.x !== undefined && input.y !== undefined && def.placement !== 'any' ? gen.satisfiesPlacement(def.placement, input.x, input.y).factor : 1;
  const staffing = input.staffing ?? Math.min(1, ((city.stats as Record<string, number>).unemploymentRate ?? 0) * 4 + 0.5);
  const inventory: Partial<Record<GoodId, number>> = {};
  for (const g of Object.keys(def.recipe?.inputs ?? {}) as GoodId[]) inventory[g] = 1e9;
  if (def.coalUse) inventory.coal = 1e9;
  const out = produce({
    type: input.type,
    staffing,
    power: 1,
    condition: 1,
    placementFactor: placement,
    upgrades: 0,
    fx,
    carry: 0,
    inventory,
    storageFree: 1e9,
  });
  const w = (city.pop as unknown as PopulationState).wages;
  const jobs = requiredJobs(input.type, fx);
  const wages = (jobs[0] * w[0] + jobs[1] * w[1] + jobs[2] * w[2]) * staffing;
  let revenue = 0;
  for (const [g, q] of Object.entries(out.produced) as [GoodId, number][]) revenue += q * refs[g];
  revenue += out.energy * BALANCE.utilities.energyBuyBase;
  let inputs = 0;
  for (const [g, q] of Object.entries(out.consumed) as [GoodId, number][]) inputs += q * refs[g];
  const policy = city.policy as { taxes: { pollution: number }; powerTariff: number; waterTariff: number };
  const fees = def.upkeep + out.pollution * policy.taxes.pollution + def.power * policy.powerTariff + def.water * policy.waterTariff;
  const daily = Math.round(revenue - inputs - wages - fees);
  return {
    type: input.type,
    placementFactor: placement,
    staffingAssumed: Math.round(staffing * 100) / 100,
    dailyRevenue: Math.round(revenue),
    dailyInputs: Math.round(inputs),
    dailyWages: Math.round(wages),
    dailyFees: Math.round(fees),
    dailyProfit: daily,
    cost: def.cost,
    paybackDays: daily > 0 ? Math.ceil(def.cost / daily) : null,
    produced: out.produced,
    consumed: out.consumed,
    energy: out.energy,
  };
}

export async function walletBalance(prisma: PrismaClient, userId: string) {
  const a = await prisma.account.findUnique({ where: { id: acc.user(userId) } });
  return Number(a?.balance ?? 0n);
}

export async function accountHistory(prisma: PrismaClient, accountId: string, take = 50) {
  const rows = await prisma.ledgerEntry.findMany({ where: { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] }, orderBy: { id: 'desc' }, take });
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    amount: r.toAccountId === accountId ? Number(r.amount) : -Number(r.amount),
    tick: r.tick,
    memo: r.memo,
    counterparty: r.toAccountId === accountId ? r.fromAccountId : r.toAccountId,
  }));
}
