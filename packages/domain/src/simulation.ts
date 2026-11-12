import {
  BALANCE,
  FACILITIES,
  GOODS,
  GOOD_IDS,
  isMonthEnd,
  type CityPolicy,
  type FacilityType,
  type GoodId,
  type PopulationState,
  type TileMap,
} from '@gce/shared';
import { centralBankRate, priceIndex, produce, requiredJobs, techEffects } from '@gce/economy-engine';
import { facilityLoad, stepCity, stepCityDays, type CityContext, type CityStepResult } from '@gce/game-simulation';
import { Prisma, withTx, type PrismaClient } from '@gce/database';
import { SYS, acc, transfer, tryTransfer } from './ledger';
import { refPrices, territoryKeys, worldGen, worldRow } from './world';
import { addGoods, storageCapacity, storageUsed, tryTakeGoods } from './inventory';
import { companyTechs, processLicenses, processResearch } from './research';
import { deliverShipments, marketDailyGood } from './market';
import { processContracts } from './contracts';
import { processLoans, updateRatings } from './banking';
import { expireProposals } from './governance';
import { logEvent, notify, publish } from './events';
import { activeIssues, advanceIssues } from './issues';
import { purgeOldChat } from './social';

const OPERATING_IN = [
  'TRADE_PROCEEDS',
  'RETAIL_SALE',
  'EXPORT_SALE',
  'ENERGY_SALE',
  'CONTRACT_PAYMENT',
  'CONTRACT_PENALTY',
  'LICENSE_FEE',
  'ESCROW_REFUND',
  'CONTRACT_TERMINATION',
];
const OPERATING_OUT = [
  'WAGES',
  'UPKEEP',
  'UTILITIES',
  'POLLUTION_FEE',
  'RESOURCE_FEE',
  'RESEARCH',
  'LICENSE_FEE',
  'SHIPPING',
  'CONTRACT_PAYMENT',
  'CONTRACT_PENALTY',
  'ORDER_ESCROW',
  'CONTRACT_TERMINATION',
  'FUEL',
];

export interface TickReport {
  tick: number;
  durationMs: number;
  phases: Record<string, number>;
  counts: Record<string, number>;
}

/** Активен е градът, чийто собственик е правил заявки в последните N минути. */
async function activeOwners(prisma: PrismaClient): Promise<Set<string>> {
  const since = new Date(Date.now() - BALANCE.sim.activeWindowMinutes * 60_000);
  const users = await prisma.user.findMany({ where: { lastActiveAt: { gte: since } }, select: { id: true } });
  return new Set(users.map((u) => u.id));
}

/**
 * Обработка на един град: чистата симулация се изчислява извън заключване, после резултатът се записва
 * с оптимистична проверка на версията (редакция от играча междувременно -> преизчисляване).
 * Идемпотентност: lastTick + уникални ключове в регистъра.
 */
export async function processCity(
  prisma: PrismaClient,
  cityId: string,
  tick: number,
  base: Omit<CityContext, 'retailSatisfaction' | 'receivership'>,
  active: boolean,
): Promise<'done' | 'skipped'> {
  const gen = await worldGen(prisma);
  for (let attempt = 0; attempt < 4; attempt++) {
    const city = await prisma.city.findUnique({ where: { id: cityId }, include: { parcels: true } });
    if (!city) return 'skipped';
    const days = tick - city.lastTick;
    if (days <= 0) return 'skipped';
    if (!active && days < BALANCE.sim.inactiveBatch) return 'skipped';
    const facilities = await prisma.facility.findMany({ where: { cityId } });
    const techCache = new Map<string, Awaited<ReturnType<typeof companyTechs>>>();
    const loads = [];
    for (const f of facilities) {
      if (!techCache.has(f.companyId)) techCache.set(f.companyId, await companyTechs(prisma, f.companyId, tick));
      const fx = techEffects(f.type as FacilityType, techCache.get(f.companyId)!);
      loads.push(
        facilityLoad(
          { id: f.id, type: f.type as FacilityType, x: f.x, y: f.y, lastEnergy: f.lastEnergy },
          requiredJobs(f.type as FacilityType, fx),
          fx.pollutionMult,
        ),
      );
    }
    const ctx: CityContext = {
      ...base,
      retailSatisfaction: city.retailSatisfaction,
      receivership: city.receivership,
      issues: await activeIssues(prisma, cityId),
    };
    const input = {
      cityId,
      tick,
      tiles: city.tiles as unknown as TileMap,
      territory: territoryKeys(city.parcels),
      pop: city.pop as unknown as PopulationState,
      policy: city.policy as unknown as CityPolicy,
      facilities: loads,
      world: gen,
      ctx,
    };
    const r: CityStepResult = days === 1 ? stepCity(input) : stepCityDays({ ...input, tick: city.lastTick + 1 }, Math.min(days, 60));
    const ok = await withTx(prisma, async (tx) => {
      const upd = await tx.city.updateMany({
        where: { id: cityId, version: city.version, lastTick: city.lastTick },
        data: {
          tiles: r.tiles as unknown as Prisma.InputJsonValue,
          pop: r.pop as unknown as Prisma.InputJsonValue,
          derived: r.derived as unknown as Prisma.InputJsonValue,
          lastTick: tick,
          version: { increment: 1 },
        },
      });
      if (upd.count !== 1) return false;
      const cityAcc = acc.city(cityId);
      for (const [cat, amount] of Object.entries(r.income)) {
        await transfer(tx, {
          from: SYS.WORLD,
          to: cityAcc,
          amount,
          kind: `CITY_${cat.toUpperCase()}`,
          tick,
          key: `city:${cityId}:${tick}:in:${cat}`,
          refType: 'City',
          refId: cityId,
        });
      }
      for (const [cat, amount] of Object.entries(r.expenses)) {
        if (cat === 'energy_purchases') continue;
        await transfer(tx, {
          from: cityAcc,
          to: SYS.WORLD,
          amount,
          kind: `CITY_${cat.toUpperCase()}`,
          tick,
          key: `city:${cityId}:${tick}:out:${cat}`,
          refType: 'City',
          refId: cityId,
        });
      }
      for (const f of facilities) {
        const s = r.facilityStatus[f.id];
        if (!s) continue;
        if (s.energyRevenue > 0) {
          await transfer(tx, {
            from: cityAcc,
            to: acc.company(f.companyId),
            amount: s.energyRevenue,
            kind: 'ENERGY_SALE',
            tick,
            key: `city:${cityId}:${tick}:energy:${f.id}`,
            refType: 'Facility',
            refId: f.id,
          });
        }
        await tx.facility.update({ where: { id: f.id }, data: { staffing: s.staffing, power: s.power, water: s.water, utilityCharge: s.utilityCharge } });
      }
      const bal = await tx.account.findUniqueOrThrow({ where: { id: cityAcc } });
      const treasury = Number(bal.balance);
      const deficitDays = treasury < 0 ? city.deficitDays + days : 0;
      let receivership = city.receivership;
      if (deficitDays > 30 && !receivership) {
        receivership = true;
        await notify(
          tx,
          city.ownerId,
          'finance',
          `Бюджетът на „${city.name}“ е в дефицит повече от 30 дни – въведено е принудително оздравяване (услуги на 50%). Вземете кредит или повишете приходите.`,
        );
      } else if (treasury > 0 && receivership) {
        const defaulted = await tx.loan.count({ where: { borrowerType: 'CITY', borrowerId: cityId, status: 'DEFAULTED' } });
        if (!defaulted) receivership = false;
      }
      const stats = { ...r.stats, tick, treasury, retailDemand: r.retailDemand };
      await tx.city.update({ where: { id: cityId }, data: { stats: stats as unknown as Prisma.InputJsonValue, deficitDays, receivership } });
      await tx.cityStat.upsert({
        where: { cityId_tick: { cityId, tick } },
        create: { cityId, tick, data: stats as unknown as Prisma.InputJsonValue },
        update: {},
      });
      await advanceIssues(
        tx,
        { id: cityId, name: city.name, ownerId: city.ownerId, tiles: r.tiles, policy: city.policy as unknown as CityPolicy, stats: stats as never },
        tick,
        days,
      );
      for (const e of r.events) {
        await logEvent(tx, { tick, kind: e.type, message: `${city.name}: ${e.message}`, cityId, public: e.type === 'flood' });
        if (e.severity === 'critical') await notify(tx, city.ownerId, e.type, `${city.name}: ${e.message}`);
      }
      await publish(tx, { type: 'city', cityId, ownerId: city.ownerId });
      return true;
    });
    if (ok) return 'done';
  }
  return 'skipped';
}

/**
 * Дневна обработка на компания: производство във всяко съоръжение, заплати, поддръжка, комунални такси,
 * екологични и ресурсни такси, изследвания и лицензи. Всичко в една транзакция, идемпотентно чрез lastTick.
 */
export async function processCompany(prisma: PrismaClient, companyId: string, tick: number, refs: Record<GoodId, number>) {
  return withTx(
    prisma,
    async (tx) => {
      const rows = await tx.$queryRaw<{ lastTick: number; status: string }[]>`SELECT "lastTick", status FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
      if (!rows.length || rows[0].lastTick >= tick || rows[0].status !== 'ACTIVE') return 'skipped';
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const techs = await companyTechs(tx, companyId, tick);
      const facilities = await tx.facility.findMany({ where: { companyId } });
      const cityCache = new Map<string, { pop: PopulationState; policy: CityPolicy; ownerId: string; name: string }>();
      const ceo = (await tx.companyRole.findFirst({ where: { companyId, role: 'CEO' } }))?.userId ?? company.founderId;
      let unpaid = false;
      for (const f of facilities) {
        const type = f.type as FacilityType;
        const def = FACILITIES[type];
        if (!cityCache.has(f.cityId)) {
          const c = await tx.city.findUniqueOrThrow({ where: { id: f.cityId } });
          cityCache.set(f.cityId, { pop: c.pop as unknown as PopulationState, policy: c.policy as unknown as CityPolicy, ownerId: c.ownerId, name: c.name });
        }
        const city = cityCache.get(f.cityId)!;
        const fx = techEffects(type, techs);
        const jobs = requiredJobs(type, fx);
        const inv = await tx.inventory.findMany({ where: { companyId, cityId: f.cityId } });
        const stock: Partial<Record<GoodId, number>> = {};
        for (const i of inv) stock[i.good as GoodId] = i.quantity;
        const free = Math.max(0, (await storageCapacity(tx, companyId, f.cityId)) - (await storageUsed(tx, companyId, f.cityId)));
        const gen = await worldGen(tx);
        const placement = def.placement === 'any' ? 1 : gen.satisfiesPlacement(def.placement, f.x, f.y).factor;
        const out = produce({
          type,
          staffing: f.staffing,
          power: f.power,
          condition: f.condition,
          placementFactor: placement || 0,
          upgrades: f.upgrades,
          fx,
          carry: f.carry,
          inventory: stock,
          storageFree: free,
        });
        // Влагане на суровини (наличността е проверена от produce – условното изваждане гарантира неотрицателност).
        let inputCost = 0;
        let consumedOk = true;
        for (const [g, q] of Object.entries(out.consumed) as [GoodId, number][]) {
          const avg = inv.find((i) => i.good === g)?.avgCost ?? refs[g];
          if (!(await tryTakeGoods(tx, companyId, f.cityId, g, q))) consumedOk = false;
          inputCost += avg * q;
        }
        const w = city.pop.wages;
        // При престой (липса на суровини/склад) персоналът се съкращава до 30% (поддържащ екип).
        const capacity = def.powerOutput
          ? def.powerOutput
          : (def.recipe?.runsPerDay ?? 0) * placement * (1 + f.upgrades * BALANCE.company.machineryUpgradeBonus) * fx.outputMult;
        const produced = def.powerOutput ? out.energy : out.runs;
        const utilization = def.storageBonus
          ? 1
          : capacity > 0
            ? Math.max(0.3, Math.min(1, produced / Math.max(1e-9, capacity * Math.max(0.01, f.staffing))))
            : 1;
        const wageCost = Math.round((jobs[0] * w[0] + jobs[1] * w[1] + jobs[2] * w[2]) * f.staffing * utilization);
        if (consumedOk) {
          const outUnits = Object.values(out.produced).reduce((a, b) => a + (b ?? 0), 0);
          for (const [g, q] of Object.entries(out.produced) as [GoodId, number][]) {
            await addGoods(tx, companyId, f.cityId, g, q, outUnits > 0 ? (inputCost + wageCost + def.upkeep) / outUnits : refs[g]);
          }
        }
        const key = `fac:${f.id}:${tick}`;
        const pay = async (to: string, amount: number, kind: string) => {
          const r = await tryTransfer(
            tx,
            { from: acc.company(companyId), to, amount, kind, tick, key: `${key}:${kind}`, refType: 'Facility', refId: f.id },
            { partial: true },
          );
          if (r.paid < Math.round(amount)) unpaid = true;
        };
        await pay(SYS.WORLD, wageCost, 'WAGES');
        await pay(SYS.WORLD, def.upkeep, 'UPKEEP');
        await pay(acc.city(f.cityId), f.utilityCharge, 'UTILITIES');
        await pay(acc.city(f.cityId), Math.round(out.pollution * city.policy.taxes.pollution), 'POLLUTION_FEE');
        if (GOODS[Object.keys(out.produced)[0] as GoodId]?.raw) {
          let rawValue = 0;
          for (const [g, q] of Object.entries(out.produced) as [GoodId, number][]) rawValue += q * refs[g];
          await pay(acc.city(f.cityId), Math.round(rawValue * city.policy.taxes.resource), 'RESOURCE_FEE');
        }
        // Износване: по-бързо при неплатени разходи (стачки, липса на поддръжка).
        const condition = Math.max(0.3, Math.min(1, f.condition - 0.0008 - (unpaid ? 0.03 : 0)));
        await tx.facility.update({
          where: { id: f.id },
          data: { carry: out.carry, lastRuns: out.runs, lastEnergy: out.energy, limitedBy: out.limitedBy, condition },
        });
      }
      if (unpaid) await notify(tx, ceo, 'finance', `„${company.name}“ не може да покрие разходите си – състоянието на съоръженията се влошава`);
      // Изследвания и лицензи.
      const hq = await tx.city.findUnique({ where: { id: company.hqCityId } });
      const hasUni = hq ? Object.values(hq.tiles as unknown as TileMap).some((t) => t.t === 'service' && t.s === 'university') : false;
      const projects = await tx.researchProject.findMany({ where: { companyId, status: 'ACTIVE' } });
      for (const p of projects) {
        const r = await processResearch(tx, p, tick, hasUni);
        if (r.completed) await notify(tx, ceo, 'research', `Изследването „${p.techId}“ завърши – получен е патент`);
      }
      await processLicenses(tx, companyId, tick, ceo);
      await tx.company.update({ where: { id: companyId }, data: { lastTick: tick } });
      return 'done';
    },
    { timeoutMs: 60_000 },
  );
}

/** Публично финансирани изследвания (град). */
async function processPublicResearch(prisma: PrismaClient, tick: number) {
  const projects = await prisma.researchProject.findMany({ where: { status: 'ACTIVE', companyId: null } });
  for (const p of projects) {
    await withTx(prisma, async (tx) => {
      const fresh = await tx.researchProject.findUnique({ where: { id: p.id } });
      if (!fresh || fresh.status !== 'ACTIVE') return;
      // Идемпотентност: проектът напредва най-много веднъж на тик (ключът на разхода е уникален за тика).
      const already = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: `research:${p.id}:${tick}` } });
      if (already) return;
      await processResearch(tx, fresh, tick, true);
    });
  }
}

/** Финансов отчет на компанията за деня от регистъра + месечен корпоративен данък към града-седалище. */
async function companyStats(prisma: PrismaClient, companyId: string, tick: number, refs: Record<GoodId, number>) {
  const done = await prisma.companyStat.findUnique({ where: { companyId_tick: { companyId, tick } } });
  if (done) return;
  const accountId = acc.company(companyId);
  const [ins, outs, account, inv, company] = await Promise.all([
    prisma.ledgerEntry.groupBy({ by: ['kind'], where: { toAccountId: accountId, tick }, _sum: { amount: true } }),
    prisma.ledgerEntry.groupBy({ by: ['kind'], where: { fromAccountId: accountId, tick }, _sum: { amount: true } }),
    prisma.account.findUnique({ where: { id: accountId } }),
    prisma.inventory.findMany({ where: { companyId } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
  ]);
  const sum = (rows: typeof ins, kinds: string[]) => rows.filter((r) => kinds.includes(r.kind)).reduce((a, r) => a + Number(r._sum.amount ?? 0n), 0);
  const revenue = sum(ins, OPERATING_IN);
  const costs = sum(outs, OPERATING_OUT);
  const inventoryValue = inv.reduce((a, i) => a + (i.quantity + i.reserved) * (refs[i.good as GoodId] ?? 0), 0);
  const data = { revenue, costs, profit: revenue - costs, cash: Number(account?.balance ?? 0n), inventoryValue };
  await withTx(prisma, async (tx) => {
    await tx.companyStat.upsert({ where: { companyId_tick: { companyId, tick } }, create: { companyId, tick, data }, update: {} });
    if (isMonthEnd(tick) && company.status === 'ACTIVE') {
      const month = await tx.companyStat.findMany({ where: { companyId, tick: { gt: tick - 30, lte: tick } } });
      const profit = month.reduce((a, s) => a + ((s.data as Record<string, number>).profit ?? 0), 0);
      const hq = await tx.city.findUnique({ where: { id: company.hqCityId } });
      if (profit > 0 && hq) {
        const rate = (hq.policy as unknown as CityPolicy).taxes.corporate;
        await tryTransfer(
          tx,
          {
            from: accountId,
            to: acc.city(hq.id),
            amount: Math.floor(profit * rate),
            kind: 'CORPORATE_TAX',
            tick,
            key: `corptax:${companyId}:${tick}`,
            refType: 'Company',
            refId: companyId,
          },
          { partial: true },
        );
      }
    }
  });
}

/** Макроикономика: ценови индекс, средна привлекателност, месечно – базова лихва на централната банка. */
async function macro(prisma: PrismaClient, tick: number) {
  const w = await worldRow(prisma);
  const refs = await refPrices(prisma);
  const pi = priceIndex(refs);
  const cities = await prisma.city.findMany({ select: { stats: true } });
  const attr = cities.map((c) => (c.stats as Record<string, number>).attractiveness).filter((x) => typeof x === 'number');
  const avgAttr = attr.length ? attr.reduce((a, b) => a + b, 0) / attr.length : 0.5;
  const data: Prisma.WorldUpdateInput = { priceIndex: pi, avgAttractiveness: avgAttr };
  if (isMonthEnd(tick)) {
    // priceIndexYearAgo съхранява експоненциална средна (EMA) на индекса; отклонението от нея ≈ инфлация за ~6 месеца.
    // Това изглажда шума от единичен месец (годишното екстраполиране на 1 месец води до свръхреакция).
    const ema = Math.max(0.01, w.priceIndexYearAgo);
    const inflation = (pi / ema - 1) * 2;
    const prev = Number(w.creditPrev);
    const cur = Number(w.creditOutstanding);
    const creditGrowth = prev > 0 ? Math.max(-1, Math.min(2, ((cur - prev) / prev) * 12)) : cur > 0 ? 0.5 : 0;
    const rate = centralBankRate(Math.max(-0.5, Math.min(1, inflation)), creditGrowth);
    data.baseRate = rate;
    data.priceIndexYearAgo = ema * 0.85 + pi * 0.15;
    data.creditPrev = w.creditOutstanding;
    if (Math.abs(rate - w.baseRate) >= 0.0025) {
      await logEvent(prisma, {
        tick,
        kind: 'central_bank',
        message: `Централната банка ${rate > w.baseRate ? 'повиши' : 'понижи'} базовата лихва до ${(rate * 100).toFixed(2)}% (инфлация ${(inflation * 100).toFixed(1)}%, растеж на кредита ${(creditGrowth * 100).toFixed(0)}%)`,
      });
    }
  }
  await prisma.world.update({ where: { id: 1 }, data });
}

/** Изпълнява един игрови ден за целия свят. Безопасно е да се изпълни повторно след срив (идемпотентни фази). */
export async function processTick(prisma: PrismaClient): Promise<TickReport> {
  const started = Date.now();
  const w = await worldRow(prisma);
  const tick = w.tick;
  const phases: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const time = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    await fn();
    phases[name] = Date.now() - t0;
  };
  await prisma.tickRun.upsert({ where: { tick }, create: { tick }, update: {} });
  const refs = await refPrices(prisma);
  const pi = priceIndex(refs);

  await time('cities', async () => {
    const active = await activeOwners(prisma);
    const cities = await prisma.city.findMany({ select: { id: true, ownerId: true } });
    const base = { worldAttractiveness: w.avgAttractiveness, coalPrice: refs.coal, foodPriceRatio: refs.food / GOODS.food.basePrice, priceIndex: pi };
    let n = 0;
    for (const c of cities) if ((await processCity(prisma, c.id, tick, base, active.has(c.ownerId))) === 'done') n++;
    counts.cities = n;
  });
  await time('companies', async () => {
    const companies = await prisma.company.findMany({ where: { status: 'ACTIVE', lastTick: { lt: tick } }, select: { id: true } });
    let n = 0;
    for (const c of companies) if ((await processCompany(prisma, c.id, tick, refs)) === 'done') n++;
    counts.companies = n;
    await processPublicResearch(prisma, tick);
  });
  await time('logistics', async () => {
    counts.shipments = await deliverShipments(prisma, tick);
    const c = await processContracts(prisma, tick);
    counts.contractDeliveries = c.delivered;
    counts.contractMisses = c.missed;
  });
  await time('market', async () => {
    const cities = await prisma.city.findMany({ select: { id: true, stats: true } });
    for (const g of GOOD_IDS) {
      const perCity = new Map<string, number>();
      let total = 0;
      for (const c of cities) {
        const d = ((c.stats as Record<string, unknown>).retailDemand as Partial<Record<GoodId, number>> | undefined)?.[g] ?? 0;
        if (d > 0) {
          perCity.set(c.id, d);
          total += d;
        }
      }
      await marketDailyGood(prisma, g, tick, total, refs, perCity);
    }
  });
  await time('finance', async () => {
    const l = await processLoans(prisma, tick);
    counts.loanPayments = l.paid;
    counts.loanMisses = l.missed;
    counts.proposalsExpired = await expireProposals(prisma, tick);
  });
  await time('reports', async () => {
    const newRefs = await refPrices(prisma);
    const companies = await prisma.company.findMany({ where: { lastTick: tick }, select: { id: true } });
    for (const c of companies) await companyStats(prisma, c.id, tick, newRefs);
    if (isMonthEnd(tick)) await updateRatings(prisma);
    await macro(prisma, tick);
    if (tick % 30 === 0) counts.chatPurged = await purgeOldChat(prisma);
  });

  const durationMs = Date.now() - started;
  const interval = w.tickIntervalMs;
  const behind = Date.now() - w.lastTickAt.getTime();
  // Наваксване след престой: ако сме твърде назад, не "изстрелваме" стотици тикове наведнъж.
  const nextAt = behind > interval * BALANCE.sim.maxCatchUpTicks ? new Date() : new Date(w.lastTickAt.getTime() + interval);
  await prisma.$transaction([
    prisma.world.update({ where: { id: 1 }, data: { tick: tick + 1, lastTickAt: nextAt } }),
    prisma.tickRun.update({
      where: { tick },
      data: { completedAt: new Date(), durationMs, phases: { ...phases, ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [`n_${k}`, v])) } },
    }),
  ]);
  await publish(prisma, { type: 'tick', tick: tick + 1, at: nextAt.toISOString() });
  return { tick, durationMs, phases, counts };
}

/** Лиз за единствен активен worker. Връща true, ако този процес е лидер. */
export async function acquireLease(prisma: PrismaClient, holder: string, ttlMs = 30_000): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + ttlMs);
  const n = await prisma.$executeRaw`
    INSERT INTO "WorkerLease" ("id","holder","expiresAt") VALUES (1, ${holder}, ${until})
    ON CONFLICT ("id") DO UPDATE SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt"
    WHERE "WorkerLease"."holder" = ${holder} OR "WorkerLease"."expiresAt" < ${now}`;
  return n === 1;
}

export async function releaseLease(prisma: PrismaClient, holder: string) {
  await prisma.workerLease.deleteMany({ where: { id: 1, holder } });
}
