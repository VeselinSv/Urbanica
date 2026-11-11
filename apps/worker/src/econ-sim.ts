import { getPrisma } from '@gce/database';
import { ensureWorld, placeOrder, processTick, refPrices, worldOverview } from '@gce/domain';
import { loadEnv } from './env';
import { createBot } from './bots';
import { checkInvariants } from './invariants';

/**
 * Икономическа симулация с автоматизирани играчи (на отделна тестова база!).
 * Използване: TEST_DATABASE_URL=... node apps/worker/dist/econ-sim.js [дни]
 * Изпълнява N игрови дни без реално изчакване и проверява инвариантите на икономиката.
 */
async function main() {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/gce(\?|$)/, '/gce_test$1');
  if (!url || !url.includes('test')) throw new Error('Икономическата симулация изисква тестова база (TEST_DATABASE_URL с "test" в името)');
  process.env.DATABASE_URL = url;
  const days = Number(process.argv[2] ?? 120);
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `TRUNCATE "User","Session","PasswordReset","World","TickRun","Account","LedgerEntry","City","Parcel","CityStat","Company","Shareholding","CompanyRole","Facility","Inventory","MarketState","MarketOrder","Trade","PriceHistory","Shipment","Contract","Loan","Proposal","Vote","ResearchProject","Patent","License","Alliance","AllianceMember","AllianceInvite","AllianceSanction","ChatMessage","Friendship","Block","Report","Notification","WorldEvent","CompanyStat","IdempotencyRecord","AuditLog","WorkerLease" CASCADE`,
  );
  await ensureWorld(prisma, 'econ-sim-seed', 1);
  const t0 = Date.now();
  const bots = [
    await createBot(prisma, 'BotFarmer', { facilities: ['farm', 'farm', 'food_plant', 'warehouse'] }),
    await createBot(prisma, 'BotMiner', { facilities: ['iron_mine', 'coal_mine', 'coal_power', 'lumber_camp'] }),
    await createBot(prisma, 'BotSteel', { facilities: ['steel_mill', 'factory', 'warehouse'] }),
    await createBot(prisma, 'BotIdle', { company: false }),
  ];
  // Мащабен тест: допълнителни градове с компании (EXTRA_CITIES=N).
  const extra = Number(process.env.EXTRA_CITIES ?? 0);
  for (let i = 0; i < extra; i++) bots.push(await createBot(prisma, `Extra${i}`, { facilities: ['farm', 'warehouse'] }));
  console.log(
    `Създадени ${bots.length} бота за ${Date.now() - t0} ms; фабрики:`,
    bots.map((b) => `${b.username}:${b.facilities.map((f) => f.type).join(',')}`).join(' | '),
  );
  for (let d = 0; d < days; d++) {
    const r = await processTick(prisma);
    // Ботовете пускат продажни поръчки за наличната продукция и купувачи за суровини.
    if (d % 5 === 4) {
      const refs = await refPrices(prisma);
      for (const b of bots) {
        if (!b.companyId) continue;
        const inv = await prisma.inventory.findMany({ where: { companyId: b.companyId, quantity: { gt: 20 } } });
        for (const i of inv) {
          const consumes =
            (b.username === 'BotSteel' && ['iron_ore', 'coal', 'steel', 'wood'].includes(i.good)) || (b.username === 'BotFarmer' && i.good === 'grain');
          if (consumes) continue;
          await placeOrder(prisma, b.userId, {
            instrument: `GOOD:${i.good}`,
            side: 'SELL',
            quantity: Math.floor(i.quantity * 0.8),
            price: Math.round(refs[i.good as keyof typeof refs] * 0.98),
            companyId: b.companyId,
            cityId: b.cityId,
          }).catch(() => undefined);
        }
        if (b.username === 'BotSteel') {
          for (const [g, q] of [
            ['iron_ore', 120],
            ['coal', 60],
            ['wood', 80],
          ] as const) {
            await placeOrder(prisma, b.userId, {
              instrument: `GOOD:${g}`,
              side: 'BUY',
              quantity: q,
              price: Math.round(refs[g] * 1.3),
              companyId: b.companyId,
              cityId: b.cityId,
            }).catch((e) => console.log('order fail', g, (e as Error).message));
          }
        }
      }
    }
    if (d % 20 === 19 || d === days - 1) {
      const o = await worldOverview(prisma);
      console.log(
        `ден ${r.tick}: ${r.durationMs} ms | население ${o.population} | БВП ${(o.gdp / 100).toFixed(0)} | ценови индекс ${o.priceIndex.toFixed(3)} | базова лихва ${(o.baseRate * 100).toFixed(2)}%`,
      );
    }
  }
  const trades = await prisma.trade.groupBy({ by: ['kind'], _count: true, _sum: { quantity: true } });
  console.log('Сделки:', trades.map((t) => `${t.kind}: ${t._count} бр./${t._sum.quantity} ед.`).join(', '));
  const produced = await prisma.inventory.groupBy({ by: ['good'], _sum: { quantity: true, reserved: true } });
  console.log('Наличности:', produced.map((p) => `${p.good}=${(p._sum.quantity ?? 0) + (p._sum.reserved ?? 0)}`).join(' '));
  const cities = await prisma.city.findMany({ select: { name: true, stats: true } });
  for (const c of cities) {
    const s = c.stats as Record<string, number>;
    console.log(
      `  ${c.name}: население ${s.population}, безработица ${((s.unemploymentRate ?? 0) * 100).toFixed(1)}%, удовлетвореност ${s.happiness}, бюджет ${((s.treasury ?? 0) / 100).toFixed(0)} €, нетно/ден ${((s.net ?? 0) / 100).toFixed(0)} €`,
    );
  }
  const inv = await checkInvariants(prisma);
  for (const c of inv.checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name} — ${c.detail}`);
  await prisma.$disconnect();
  process.exit(inv.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
