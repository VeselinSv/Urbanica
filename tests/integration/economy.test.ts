import { beforeAll, describe, expect, it } from 'vitest';
import {
  acc,
  castVote,
  cancelOrder,
  createProposal,
  getCompany,
  placeOrder,
  processContracts,
  processLoans,
  processTick,
  proposeContract,
  respondContract,
  restructureLoan,
  takeLoan,
  deliverShipments,
  worldRow,
  SYS,
  transfer,
} from '@gce/domain';
import { BALANCE, PRICE } from '@gce/shared';
import { withTx } from '@gce/database';
import { balance, cityWithRoad, companyIn, expectInvariants, giveGoods, player, prisma, resetDb } from './helpers';

let seller: Awaited<ReturnType<typeof player>>;
let buyer: Awaited<ReturnType<typeof player>>;
let sellerCity: string;
let buyerCity: string;
let sellerCo: string;
let buyerCo: string;

beforeAll(async () => {
  await resetDb();
  seller = await player('Sel');
  buyer = await player('Buy');
  sellerCity = (await cityWithRoad(seller.id)).city.id;
  buyerCity = (await cityWithRoad(buyer.id)).city.id;
  sellerCo = (await companyIn(seller.id, sellerCity)).id;
  buyerCo = (await companyIn(buyer.id, buyerCity)).id;
});

describe('Търговия между двама играчи', () => {
  it('реална сделка: стоката се резервира, парите минават през ескроу, доставката пристига', async () => {
    await giveGoods(sellerCo, sellerCity, 'steel', 100);
    const sellerCash0 = await balance(acc.company(sellerCo));
    const buyerCash0 = await balance(acc.company(buyerCo));
    await placeOrder(prisma, seller.id, { instrument: 'GOOD:steel', side: 'SELL', quantity: 40, price: 3000 * PRICE, companyId: sellerCo, cityId: sellerCity });
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { companyId_cityId_good: { companyId: sellerCo, cityId: sellerCity, good: 'steel' } } });
    expect(inv.quantity).toBe(60);
    expect(inv.reserved).toBe(40);
    const r = await placeOrder(prisma, buyer.id, {
      instrument: 'GOOD:steel',
      side: 'BUY',
      quantity: 30,
      price: 3200 * PRICE,
      companyId: buyerCo,
      cityId: buyerCity,
    });
    expect(r.fills).toEqual([{ price: 3000 * PRICE, quantity: 30 }]);
    // Купувачът плаща цената на продавача (3000), излишъкът от ескроу се връща.
    expect(buyerCash0 - (await balance(acc.company(buyerCo)))).toBe(30 * 3000 * PRICE);
    const gross = 30 * 3000 * PRICE;
    const fee = Math.floor(gross * BALANCE.market.tradeFee);
    const gained = (await balance(acc.company(sellerCo))) - sellerCash0;
    expect(gained).toBeLessThanOrEqual(gross - fee);
    expect(gained).toBeGreaterThan(gross * 0.8);
    const ship = await prisma.shipment.findFirstOrThrow({ where: { companyId: buyerCo } });
    expect(ship.quantity).toBe(30);
    const w = await worldRow(prisma);
    await deliverShipments(prisma, w.tick + 100);
    const got = await prisma.inventory.findUniqueOrThrow({ where: { companyId_cityId_good: { companyId: buyerCo, cityId: buyerCity, good: 'steel' } } });
    expect(got.quantity).toBe(30);
    await deliverShipments(prisma, w.tick + 100);
    const again = await prisma.inventory.findUniqueOrThrow({ where: { companyId_cityId_good: { companyId: buyerCo, cityId: buyerCity, good: 'steel' } } });
    expect(again.quantity).toBe(30); // доставката не се дублира
    await expectInvariants();
  });

  it('едновременни покупки на една и съща ограничена наличност не надпродават', async () => {
    await giveGoods(sellerCo, sellerCity, 'coal', 10);
    await placeOrder(prisma, seller.id, { instrument: 'GOOD:coal', side: 'SELL', quantity: 10, price: 500, companyId: sellerCo, cityId: sellerCity });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        placeOrder(prisma, buyer.id, { instrument: 'GOOD:coal', side: 'BUY', quantity: 10, price: 500, companyId: buyerCo, cityId: buyerCity }),
      ),
    );
    const filled = results.reduce((a, r) => a + r.fills.reduce((x, f) => x + f.quantity, 0), 0);
    expect(filled).toBe(10);
    const trades = await prisma.trade.aggregate({ where: { instrument: 'GOOD:coal', kind: 'BOOK' }, _sum: { quantity: true } });
    expect(trades._sum.quantity).toBe(10);
    await expectInvariants();
  });

  it('отказ при недостиг на средства или стока; отмяната връща ескроу', async () => {
    await expect(
      placeOrder(prisma, buyer.id, { instrument: 'GOOD:machinery', side: 'BUY', quantity: 1_000_000, price: 1_000_000, companyId: buyerCo, cityId: buyerCity }),
    ).rejects.toThrow(/Недостатъчни/);
    await expect(
      placeOrder(prisma, seller.id, { instrument: 'GOOD:food', side: 'SELL', quantity: 5, price: 100, companyId: sellerCo, cityId: sellerCity }),
    ).rejects.toThrow(/наличност/);
    await expect(
      placeOrder(prisma, buyer.id, { instrument: 'GOOD:steel', side: 'SELL', quantity: 1, price: 100, companyId: sellerCo, cityId: sellerCity }),
    ).rejects.toMatchObject({ status: 403 });
    const cash0 = await balance(acc.company(buyerCo));
    const r = await placeOrder(prisma, buyer.id, { instrument: 'GOOD:grain', side: 'BUY', quantity: 10, price: 100, companyId: buyerCo, cityId: buyerCity });
    expect(await balance(acc.company(buyerCo))).toBe(cash0 - 1000);
    await cancelOrder(prisma, buyer.id, r.order.id);
    expect(await balance(acc.company(buyerCo))).toBe(cash0);
    await expect(cancelOrder(prisma, buyer.id, r.order.id)).rejects.toThrow();
    await expectInvariants();
  });

  it('търговия с акции и придобиване на контрол', async () => {
    // Продавачът (основател) продава 60% от акциите на компанията на купувача.
    await placeOrder(prisma, seller.id, { instrument: `SHARE:${sellerCo}`, side: 'SELL', quantity: 6000, price: 10, companyId: undefined });
    await placeOrder(prisma, buyer.id, { instrument: `SHARE:${sellerCo}`, side: 'BUY', quantity: 6000, price: 10, companyId: buyerCo });
    const c = await prisma.company.findUniqueOrThrow({ where: { id: sellerCo } });
    expect(c.parentCompanyId).toBe(buyerCo);
    const view = await getCompany(prisma, sellerCo, buyer.id);
    expect(view.shareholders.find((h) => h.holderId === buyerCo)?.shares).toBe(6000);
    await expectInvariants();
  });
});

describe('Договори', () => {
  it('изпълнение на доставка и неустойка при неизпълнение', async () => {
    await giveGoods(sellerCo, sellerCity, 'wood', 20);
    const c = await proposeContract(prisma, seller.id, {
      sellerCompanyId: sellerCo,
      buyerCompanyId: buyerCo,
      good: 'wood',
      quantityPerDelivery: 15,
      pricePerUnit: 600,
      intervalDays: 2,
      deliveries: 3,
      penaltyPerMiss: 5000,
      fromCityId: sellerCity,
      toCityId: buyerCity,
    });
    await expect(respondContract(prisma, seller.id, c.id, 'accept')).rejects.toMatchObject({ status: 403 });
    await respondContract(prisma, buyer.id, c.id, 'accept');
    const w = await worldRow(prisma);
    const r1 = await processContracts(prisma, w.tick + 1);
    expect(r1.delivered).toBe(1);
    const buyerBefore = await balance(acc.company(buyerCo));
    const r2 = await processContracts(prisma, w.tick + 3); // остават 5 – недостиг
    expect(r2.missed).toBe(1);
    expect(await balance(acc.company(buyerCo))).toBeGreaterThan(buyerBefore); // получена неустойка
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.misses).toBe(1);
    expect(after.deliveriesDone).toBe(1);
    await expectInvariants();
  });
});

describe('Кредити и финансов риск', () => {
  it('кредит, вноски, просрочие, неизпълнение, преструктуриране', async () => {
    const p = await player('Debt');
    const city = (await cityWithRoad(p.id)).city.id;
    const co = (await companyIn(p.id, city, 1_000_000)).id;
    const loan = await takeLoan(prisma, p.id, { borrowerType: 'COMPANY', borrowerId: co, amount: 300_000, termDays: 360 });
    expect(await balance(acc.company(co))).toBe(1_300_000);
    await expect(takeLoan(prisma, p.id, { borrowerType: 'COMPANY', borrowerId: co, amount: 1e12, termDays: 360 })).rejects.toThrow(/Максималната/);
    const due = loan.nextDueTick;
    await processLoans(prisma, due);
    const paid = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(Number(paid.outstanding)).toBeLessThan(300_000);
    expect(paid.nextDueTick).toBe(due + 30);
    await processLoans(prisma, due); // идемпотентно – няма второ плащане
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).nextDueTick).toBe(due + 30);
    // Източваме компанията, за да пропусне вноски.
    const drain = await balance(acc.company(co));
    await withTx(prisma, (tx) => transfer(tx, { from: acc.company(co), to: SYS.WORLD, amount: drain, kind: 'TEST_DRAIN', tick: 0, key: `test-drain:${co}` }));
    for (let i = 1; i <= 3; i++) await processLoans(prisma, due + 30 * i);
    const defaulted = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(defaulted.status).toBe('DEFAULTED');
    expect(Number(defaulted.outstanding)).toBeGreaterThan(Number(paid.outstanding));
    const r = await restructureLoan(prisma, p.id, loan.id);
    expect(r.status).toBe('RESTRUCTURED');
    expect(r.annualRate).toBeCloseTo(paid.annualRate + 0.02);
    await expect(restructureLoan(prisma, p.id, loan.id)).rejects.toThrow(/веднъж/);
  });
});

describe('Корпоративно управление', () => {
  it('дивидент чрез гласуване; права по роли', async () => {
    const p = await player('Gov');
    const q = await player('Gov');
    const city = (await cityWithRoad(p.id)).city.id;
    const co = (await companyIn(p.id, city, 1_000_000)).id;
    // Основателят продава 40% на втори акционер.
    await placeOrder(prisma, p.id, { instrument: `SHARE:${co}`, side: 'SELL', quantity: 4000, price: 5 });
    await placeOrder(prisma, q.id, { instrument: `SHARE:${co}`, side: 'BUY', quantity: 4000, price: 5 });
    const qWallet = await balance(acc.user(q.id));
    // Миноритарният акционер не може сам да прокара предложение.
    const prop = await createProposal(prisma, q.id, { scopeType: 'COMPANY', scopeId: co, kind: 'PAY_DIVIDEND', payload: { amountPerShare: 10 } });
    expect(prop.status).toBe('OPEN');
    const done = await castVote(prisma, p.id, prop.id, true);
    expect(done.status).toBe('EXECUTED');
    expect((await balance(acc.user(q.id))) - qWallet).toBe(4000 * 10);
    // Акционер без роля не може да търгува от името на компанията.
    await expect(placeOrder(prisma, q.id, { instrument: 'GOOD:coal', side: 'BUY', quantity: 1, price: 1, companyId: co, cityId: city })).rejects.toMatchObject({
      status: 403,
    });
    // Назначаване за мениджър дава право на търговия, но не и на кредит.
    const appoint = await createProposal(prisma, p.id, { scopeType: 'COMPANY', scopeId: co, kind: 'APPOINT_ROLE', payload: { userId: q.id, role: 'MANAGER' } });
    expect(appoint.status).toBe('EXECUTED');
    await placeOrder(prisma, q.id, { instrument: 'GOOD:coal', side: 'BUY', quantity: 1, price: 1, companyId: co, cityId: city });
    await expect(takeLoan(prisma, q.id, { borrowerType: 'COMPANY', borrowerId: co, amount: 1000, termDays: 90 })).rejects.toMatchObject({ status: 403 });
    await expectInvariants();
  });
});

describe('Симулационен тик (worker)', () => {
  it('обработва тик, а повторното изпълнение не дублира плащания (възстановяване след срив)', async () => {
    const w0 = await worldRow(prisma);
    await processTick(prisma);
    const entries1 = await prisma.ledgerEntry.count();
    const cityTick = await prisma.city.findFirstOrThrow({ select: { lastTick: true } });
    expect(cityTick.lastTick).toBe(w0.tick);
    // Симулиран срив: часовникът не е отбелязал завършването – фазите се изпълняват отново.
    await prisma.world.update({ where: { id: 1 }, data: { tick: w0.tick } });
    await processTick(prisma);
    expect(await prisma.ledgerEntry.count()).toBe(entries1);
    expect((await worldRow(prisma)).tick).toBe(w0.tick + 1);
    await expectInvariants();
  });
});
