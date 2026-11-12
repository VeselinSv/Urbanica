import { describe, expect, it } from 'vitest';
import { BALANCE, FACILITIES, GOODS, type GoodId } from '@gce/shared';
import {
  adjustWages,
  annuityPayment,
  centralBankRate,
  creditScore,
  loanRate,
  matchIncoming,
  matchLabor,
  maxBorrowing,
  nextReferencePrice,
  periodInterest,
  priceIndex,
  produce,
  requiredJobs,
  shippingQuote,
  tax,
  techEffects,
  type BookOrder,
} from './index';

const baseRefs = () => Object.fromEntries(Object.values(GOODS).map((g) => [g.id, g.basePrice])) as Record<GoodId, number>;

describe('Трудов пазар', () => {
  it('запазва броя хора и не позволява по-ниска квалификация на по-висока позиция', () => {
    const r = matchLabor([100, 50, 10], [30, 80, 40]);
    expect(r.employedByEdu[0] + r.unemployedByEdu[0]).toBe(100);
    expect(r.employedByEdu[1] + r.unemployedByEdu[1]).toBe(50);
    expect(r.employedByEdu[2] + r.unemployedByEdu[2]).toBe(10);
    // L2 позициите (40) могат да се заемат само от L2 (10)
    expect(r.filledJobs[2]).toBe(10);
    expect(r.vacancies[2]).toBe(30);
    // Висококвалифицираните могат да слизат надолу
    const down = matchLabor([0, 0, 20], [20, 0, 0]);
    expect(down.filledJobs[0]).toBe(20);
  });

  it('заплатите растат при недостиг и падат при безработица в границите', () => {
    const wages = [...BALANCE.wages.base] as [number, number, number];
    const shortage = matchLabor([0, 0, 0], [100, 100, 100]);
    const up = adjustWages(wages, [100, 100, 100], shortage);
    expect(up[0]).toBeGreaterThan(wages[0]);
    const surplus = matchLabor([500, 0, 0], [10, 0, 0]);
    const down = adjustWages(wages, [10, 0, 0], surplus);
    expect(down[0]).toBeLessThan(wages[0]);
    let w = wages;
    for (let i = 0; i < 500; i++) w = adjustWages(w, [10, 0, 0], surplus);
    expect(w[0]).toBe(BALANCE.wages.min[0]);
  });
});

describe('Финанси и кредити', () => {
  it('анюитетът изплаща главницата за срока', () => {
    const principal = 1_000_000;
    const pay = annuityPayment(principal, 0.12, 360, 30);
    let bal = principal;
    for (let i = 0; i < 12; i++) bal = bal + periodInterest(bal, 0.12, 30) - pay;
    expect(Math.abs(bal)).toBeLessThan(pay); // остатък от закръгляния
    expect(annuityPayment(1200, 0, 360, 30)).toBe(100);
  });

  it('кредитният рейтинг пада с ливъриджа и пропуснатите плащания', () => {
    const good = creditScore({ assets: 1e7, debt: 1e6, cash: 5e6, dailyCashFlow: 10_000, dailyDebtService: 1000, missedPayments: 0, defaulted: false });
    const bad = creditScore({ assets: 1e7, debt: 9e6, cash: 1e5, dailyCashFlow: -1000, dailyDebtService: 5000, missedPayments: 3, defaulted: false });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(creditScore({ assets: 1, debt: 1, cash: 0, dailyCashFlow: 0, dailyDebtService: 0, missedPayments: 0, defaulted: true }).rating).toBe('D');
    expect(loanRate(0.05, bad.rating)).toBeGreaterThan(loanRate(0.05, good.rating));
    expect(maxBorrowing(1e7, 0, 'AAA')).toBeGreaterThan(maxBorrowing(1e7, 0, 'B'));
    expect(maxBorrowing(1e7, 1e8, 'A')).toBe(0);
  });

  it('централната банка повишава лихвата при инфлация и кредитен бум', () => {
    expect(centralBankRate(0.1, 0)).toBeGreaterThan(centralBankRate(0.02, 0));
    expect(centralBankRate(0.02, 0.5)).toBeGreaterThan(centralBankRate(0.02, 0));
    expect(centralBankRate(-5, 0)).toBe(BALANCE.banking.minRate);
  });

  it('данъкът е неотрицателен цял брой', () => {
    expect(tax(1001, 0.1)).toBe(100);
    expect(tax(-50, 0.2)).toBe(0);
    expect(Number.isInteger(tax(12345, 0.0731))).toBe(true);
  });
});

describe('Пазар', () => {
  const book: BookOrder[] = [
    { id: 'a', side: 'SELL', price: 100, remaining: 5, createdSeq: 2, ownerKey: 'C:1' },
    { id: 'b', side: 'SELL', price: 90, remaining: 3, createdSeq: 3, ownerKey: 'C:2' },
    { id: 'c', side: 'SELL', price: 90, remaining: 4, createdSeq: 1, ownerKey: 'C:3' },
    { id: 'd', side: 'SELL', price: 120, remaining: 10, createdSeq: 0, ownerKey: 'C:4' },
  ];
  it('съпоставя по цена и време, по цената на чакащата поръчка', () => {
    const r = matchIncoming({ side: 'BUY', price: 100, quantity: 10, ownerKey: 'C:9' }, book);
    expect(r.fills.map((f) => f.makerId)).toEqual(['c', 'b', 'a']);
    expect(r.fills.map((f) => f.quantity)).toEqual([4, 3, 3]);
    expect(r.fills[0].price).toBe(90);
    expect(r.remaining).toBe(0);
  });
  it('не изпълнява самотърговия и спазва лимита', () => {
    const r = matchIncoming({ side: 'BUY', price: 95, quantity: 10, ownerKey: 'C:3' }, book);
    expect(r.fills.map((f) => f.makerId)).toEqual(['b']);
    expect(r.remaining).toBe(7);
  });
  it('уважава външни ограничения (санкции)', () => {
    const r = matchIncoming({ side: 'BUY', price: 200, quantity: 100, ownerKey: 'X' }, book, (m) => m.id !== 'b');
    expect(r.fills.some((f) => f.makerId === 'b')).toBe(false);
  });
  it('недостигът вдига цената, излишъкът я сваля, в границите', () => {
    const refs = baseRefs();
    const up = nextReferencePrice({ good: 'coal', ref: 500, excessDemand: 300, volume: 300, refs });
    const down = nextReferencePrice({ good: 'coal', ref: 500, excessDemand: -300, volume: 300, refs });
    expect(up).toBeGreaterThan(500);
    expect(down).toBeLessThan(500);
    let p = 500;
    for (let i = 0; i < 2000; i++) p = nextReferencePrice({ good: 'coal', ref: p, excessDemand: 1e9, volume: 1, refs });
    expect(p).toBeLessThanOrEqual(GOODS.coal.basePrice * BALANCE.market.maxPriceShare);
  });
  it('базовите цени са равновесие (без сигнал няма дрейф)', () => {
    const refs = baseRefs();
    for (const g of Object.keys(GOODS) as GoodId[]) {
      expect(nextReferencePrice({ good: g, ref: refs[g], excessDemand: 0, volume: 100, refs })).toBe(GOODS[g].basePrice);
    }
    expect(priceIndex(refs)).toBeCloseTo(1, 6);
  });
  it('поскъпването на суровина се пренася в себестойността на продукта', () => {
    const refs = baseRefs();
    refs.iron_ore *= 3;
    const steel = nextReferencePrice({ good: 'steel', ref: refs.steel, excessDemand: 0, volume: 100, refs });
    expect(steel).toBeGreaterThan(GOODS.steel.basePrice);
  });
  it('транспортът зависи от разстоянието', () => {
    expect(shippingQuote(0, 100)).toEqual({ cost: 0, days: 0 });
    const far = shippingQuote(200, 10);
    expect(far.cost).toBe(200 * 10 * BALANCE.company.shippingCostPerUnitPerTile);
    expect(far.days).toBeGreaterThan(shippingQuote(30, 10).days);
    expect(shippingQuote(100, 10, 0.7).cost).toBe(Math.round(100 * 10 * BALANCE.company.shippingCostPerUnitPerTile * 0.7));
  });
});

describe('Производство', () => {
  const fx = techEffects('steel_mill', []);
  it('не създава продукция без суровини (запазване на материята)', () => {
    const r = produce({
      type: 'steel_mill',
      staffing: 1,
      power: 1,
      condition: 1,
      placementFactor: 1,
      upgrades: 0,
      fx,
      carry: 0,
      inventory: {},
      storageFree: 1e6,
    });
    expect(r.runs).toBe(0);
    expect(r.limitedBy).toBe('inputs');
  });
  it('консумира точно по рецептата и е ограничено от персонала', () => {
    const r = produce({
      type: 'steel_mill',
      staffing: 0.5,
      power: 1,
      condition: 1,
      placementFactor: 1,
      upgrades: 0,
      fx,
      carry: 0,
      inventory: { iron_ore: 1000, coal: 1000 },
      storageFree: 1e6,
    });
    // половин персонал → половината от дневните цикли на стоманолеярната
    const runs = FACILITIES.steel_mill.recipe!.runsPerDay / 2;
    expect(r.runs).toBe(runs);
    expect(r.consumed).toEqual({ iron_ore: runs * 2, coal: runs });
    expect(r.produced).toEqual({ steel: runs });
    expect(r.limitedBy).toBe('staff');
  });
  it('ограничено от наличните суровини и склада', () => {
    const r = produce({
      type: 'steel_mill',
      staffing: 1,
      power: 1,
      condition: 1,
      placementFactor: 1,
      upgrades: 0,
      fx,
      carry: 0,
      inventory: { iron_ore: 7, coal: 100 },
      storageFree: 1e6,
    });
    expect(r.runs).toBe(3);
    expect(r.consumed.iron_ore ?? 0).toBeLessThanOrEqual(7);
    const farm = produce({
      type: 'farm',
      staffing: 1,
      power: 1,
      condition: 1,
      placementFactor: 1,
      upgrades: 0,
      fx: techEffects('farm', []),
      carry: 0,
      inventory: {},
      storageFree: 10,
    });
    expect(farm.produced.grain).toBe(10);
    expect(farm.limitedBy).toBe('storage');
  });
  it('технологиите влияят само на своя сектор', () => {
    const t = techEffects('farm', ['precision_farming', 'mining_automation']);
    expect(t.outputMult).toBeCloseTo(1.25);
    expect(t.staffMult).toBe(1);
    const m = techEffects('iron_mine', ['mining_automation']);
    expect(requiredJobs('iron_mine', m)[0]).toBeLessThan(requiredJobs('iron_mine', techEffects('iron_mine', []))[0]);
    expect(techEffects(null, ['logistics_software']).shippingMult).toBeCloseTo(0.7);
  });
  it('енергийните мощности горят въглища пропорционално', () => {
    const r = produce({
      type: 'coal_power',
      staffing: 1,
      power: 1,
      condition: 1,
      placementFactor: 1,
      upgrades: 0,
      fx: techEffects('coal_power', []),
      carry: 0,
      inventory: { coal: 4 },
      storageFree: 0,
    });
    expect(r.coalUsed).toBe(4);
    expect(r.energy).toBe(80);
  });
});
