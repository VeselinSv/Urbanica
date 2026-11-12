import { describe, expect, it } from 'vitest';
import { BALANCE, hasSidewalk, isWalkable, tileKey, type CityPolicy, type PopulationState, type TileMap } from '@gce/shared';
import { WorldGenerator } from '@gce/world-generation';
import { stepCity, stepCityDays, type CityInput } from './city';

const world = new WorldGenerator('unit-test-seed');

function findLand(): { ox: number; oy: number } {
  for (let y = 80; y < 420; y += 8)
    for (let x = 80; x < 420; x += 8) {
      let ok = true;
      for (let j = 0; j < 24 && ok; j++) for (let i = 0; i < 24 && ok; i++) if (!world.buildable(x + i, y + j)) ok = false;
      if (ok) return { ox: x, oy: y };
    }
  throw new Error('no land');
}

function makeCity(): CityInput {
  const { ox, oy } = findLand();
  const tiles: TileMap = {};
  const territory: string[] = [];
  for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) territory.push(tileKey(ox + i, oy + j));
  for (let i = 0; i < 24; i++) {
    tiles[tileKey(ox + i, oy + 6)] = { t: 'road' };
    tiles[tileKey(ox + i, oy + 11)] = { t: 'road' };
  }
  for (let i = 0; i < 20; i++) {
    tiles[tileKey(ox + i, oy + 5)] = { t: 'zone', z: 'R', lvl: 0, occ: 0, prog: 0, hp: 1 };
    tiles[tileKey(ox + i, oy + 7)] = { t: 'zone', z: 'R', lvl: 0, occ: 0, prog: 0, hp: 1 };
    tiles[tileKey(ox + i, oy + 10)] = { t: 'zone', z: 'I', lvl: 0, occ: 0, prog: 0, hp: 1 };
    tiles[tileKey(ox + i, oy + 12)] = { t: 'zone', z: 'C', lvl: 0, occ: 0, prog: 0, hp: 1 };
  }
  tiles[tileKey(ox + 21, oy + 5)] = { t: 'service', s: 'power_coal', cond: 1 };
  tiles[tileKey(ox + 22, oy + 7)] = { t: 'service', s: 'water_pump', cond: 1 };
  tiles[tileKey(ox + 21, oy + 12)] = { t: 'service', s: 'school', cond: 1 };
  const pop: PopulationState = {
    edu: [0, 0, 0],
    schoolProgress: 0,
    universityProgress: 0,
    wages: [...BALANCE.wages.base] as [number, number, number],
    happiness: 0.6,
  };
  const policy: CityPolicy = {
    taxes: { ...BALANCE.taxes.defaults },
    serviceBudget: 1,
    subsidies: {},
    powerTariff: 200,
    waterTariff: 50,
    importTariff: 0,
    sanctions: [],
    powerPriority: ['services', 'facilities', 'zones'],
  };
  return {
    cityId: 'test-city',
    tick: 0,
    tiles,
    territory,
    pop,
    policy,
    facilities: [],
    world,
    ctx: { worldAttractiveness: 0.5, coalPrice: 500, foodPriceRatio: 1, priceIndex: 1, retailSatisfaction: 1, receivership: false },
  };
}

function run(input: CityInput, days: number) {
  let cur = input;
  let last = stepCity(cur);
  for (let d = 0; d < days; d++) {
    last = stepCity({ ...cur, tick: input.tick + d });
    cur = { ...cur, tiles: last.tiles, pop: last.pop };
  }
  return { cur, last };
}

describe('Градска симулация', () => {
  it('е детерминистична за едни и същи входни данни', () => {
    const a = run(makeCity(), 40).last;
    const b = run(makeCity(), 40).last;
    expect(a.stats).toEqual(b.stats);
    expect(a.tiles).toEqual(b.tiles);
  });

  it('сградите възникват при търсене и инфраструктура; населението расте', () => {
    const { last } = run(makeCity(), 60);
    expect(last.stats.buildings.R).toBeGreaterThan(10);
    expect(last.stats.population).toBeGreaterThan(100);
    expect(last.stats.employed[0] + last.stats.employed[1] + last.stats.employed[2]).toBeGreaterThan(0);
    expect(last.income.income_tax).toBeGreaterThan(0);
  });

  it('без ток и вода сградите не се развиват', () => {
    const input = makeCity();
    for (const [k, t] of Object.entries(input.tiles)) if (t.t === 'service') delete input.tiles[k];
    const { last } = run(input, 40);
    expect(last.stats.buildings.R).toBe(0);
    expect(last.stats.population).toBe(0);
  });

  it('по-високият данък върху доходите намалява търсенето на жилища', () => {
    const lo = makeCity();
    const hi = makeCity();
    hi.policy.taxes.income = 0.35;
    const a = run(lo, 30).last.stats.demand.R;
    const b = run(hi, 30).last.stats.demand.R;
    expect(b).toBeLessThan(a);
  });

  it('обобщената симулация (N дни наведнъж) дава същото състояние като N отделни дни', () => {
    const input = makeCity();
    const days = 12;
    const fine = run({ ...input, tick: 5 }, days);
    const batch = stepCityDays({ ...input, tick: 5 }, days);
    expect(batch.tiles).toEqual(fine.last.tiles);
    expect(batch.pop).toEqual(fine.last.pop);
    // Сумарните потоци съвпадат със сбора на дневните.
    let cur = { ...input, tick: 5 };
    let incomeSum = 0;
    for (let d = 0; d < days; d++) {
      const r = stepCity({ ...cur, tick: 5 + d });
      incomeSum += Object.values(r.income).reduce((a, b) => a + b, 0);
      cur = { ...cur, tiles: r.tiles, pop: r.pop };
    }
    expect(Object.values(batch.income).reduce((a, b) => a + b, 0)).toBe(incomeSum);
  });

  it('всички парични потоци са цели неотрицателни числа', () => {
    const { last } = run(makeCity(), 30);
    for (const v of [...Object.values(last.income), ...Object.values(last.expenses)]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('категорията на пътя и кръстовищата увеличават капацитета (по-малко задръстване, по-висока поддръжка)', () => {
    const base = makeCity();
    const streets = run(base, 50).last;
    const upgraded = makeCity();
    for (const [k, t] of Object.entries(upgraded.tiles)) if (t.t === 'road') upgraded.tiles[k] = { t: 'road', c: 'avenue' };
    const avenues = run(upgraded, 50).last;
    expect(avenues.stats.traffic.congestion).toBeLessThan(streets.stats.traffic.congestion);
    expect(avenues.expenses.road_upkeep).toBeGreaterThan(streets.expenses.road_upkeep);
    const withJunction = makeCity();
    const firstRoad = Object.keys(withJunction.tiles).find((k) => withJunction.tiles[k].t === 'road')!;
    withJunction.tiles[firstRoad] = { t: 'road', j: 'roundabout' };
    const j = stepCity(withJunction);
    const plain = stepCity(makeCity());
    expect(j.stats.traffic.congestion).toBeLessThanOrEqual(plain.stats.traffic.congestion);
    expect(j.expenses.road_upkeep).toBe(plain.expenses.road_upkeep + BALANCE.construction.junctions.roundabout.upkeep);
  });

  it('сградите се надграждат сами само при изпълнени условия (училище, тротоар; болница, полиция за ниво 3)', () => {
    // С училище и улици с тротоари жилищата стигат ниво 2, но не и ниво 3 (липсват болница, полиция…).
    const lv = (tiles: TileMap, z: string, n: number) => Object.values(tiles).filter((t) => t.t === 'zone' && t.z === z && t.lvl >= n).length;
    const city = makeCity();
    // балансиран град: още работни места и второ училище, което покрива западните жилища
    const keys = Object.keys(city.tiles).map((k) => k.split(',').map(Number));
    const ox = Math.min(...keys.map((p) => p[0]));
    const oy = Math.min(...keys.map((p) => p[1])) - 5;
    for (let i = 0; i < 20; i++) city.tiles[tileKey(ox + i, oy + 13)] = { t: 'zone', z: 'I', lvl: 0, occ: 0, prog: 0, hp: 1 };
    // персоналът на услугите расте с града – работните места идват основно от зоните (още търговия и индустрия)
    for (let i = 0; i < 24; i++) city.tiles[tileKey(ox + i, oy + 14)] = { t: 'road' };
    for (let j = 12; j < 14; j++) city.tiles[tileKey(ox + 23, oy + j)] = { t: 'road' };
    for (let i = 0; i < 20; i++) city.tiles[tileKey(ox + i, oy + 15)] = { t: 'zone', z: i % 2 ? 'C' : 'I', lvl: 0, occ: 0, prog: 0, hp: 1 };
    city.tiles[tileKey(ox + 3, oy + 8)] = { t: 'service', s: 'school', cond: 1 };
    const base = run(city, 300);
    expect(base.last.stats.buildings.R).toBeGreaterThan(5);
    expect(lv(base.last.tiles, 'R', 2)).toBeGreaterThan(0);
    expect(lv(base.last.tiles, 'R', 3)).toBe(0);
    const someR2 = Object.entries(base.last.tiles).find(([, t]) => t.t === 'zone' && t.z === 'R' && t.lvl === 2)![0];
    expect(base.last.derived.levels?.[someR2].next).toEqual(expect.arrayContaining(['clinic', 'police_station']));

    // Затваряме училището → надградените жилища губят състояние и слизат ниво (не се изоставят веднага).
    const closed = { ...base.cur, tiles: { ...base.cur.tiles } };
    for (const [k, t] of Object.entries(closed.tiles)) if (t.t === 'service' && t.s === 'school') delete closed.tiles[k];
    const before = lv(closed.tiles, 'R', 2);
    const after = run(closed, 90);
    expect(lv(after.last.tiles, 'R', 2)).toBeLessThan(before);
  });

  it('тротоари: улиците ги имат по подразбиране, селските пътища – не; алеята е пешеходна', () => {
    expect(hasSidewalk({ t: 'road' })).toBe(true);
    expect(hasSidewalk({ t: 'road', c: 'avenue' })).toBe(true);
    expect(hasSidewalk({ t: 'road', c: 'rural' })).toBe(false);
    expect(hasSidewalk({ t: 'road', c: 'rural', sw: true })).toBe(true);
    expect(hasSidewalk({ t: 'road', sw: false })).toBe(false);
    expect(isWalkable({ t: 'path' })).toBe(true);
    expect(isWalkable({ t: 'zone', z: 'R', lvl: 1, occ: 1, prog: 0, hp: 1 })).toBe(false);
  });

  it('без тротоар жилищата не минават на ниво 2; пешеходна алея до тях изпълнява условието', () => {
    const city = makeCity();
    for (const [k, t] of Object.entries(city.tiles)) if (t.t === 'road') city.tiles[k] = { t: 'road', c: 'rural' };
    const noWalk = run(city, 60);
    const rTiles = Object.entries(noWalk.last.tiles).filter(([, t]) => t.t === 'zone' && t.z === 'R' && t.lvl === 1);
    expect(rTiles.length).toBeGreaterThan(0);
    const k = rTiles[0][0];
    expect(noWalk.last.derived.levels?.[k].next).toContain('sidewalk');
    expect(noWalk.last.stats.upgradeBlockers?.sidewalk ?? 0).toBeGreaterThan(0);
    // алея точно до сградата
    const [x, y] = k.split(',').map(Number);
    const withPath = { ...noWalk.cur, tiles: { ...noWalk.cur.tiles } };
    const spot = [tileKey(x, y - 1), tileKey(x, y + 1), tileKey(x - 1, y), tileKey(x + 1, y)].find((n) => !withPath.tiles[n]);
    if (spot) {
      withPath.tiles[spot] = { t: 'path' };
      const after = run(withPath, 1);
      expect(after.last.derived.levels?.[k]?.next ?? []).not.toContain('sidewalk');
    }
    // с обикновени улици (с тротоари) условието е изпълнено
    const streets = run(makeCity(), 60);
    const r2 = Object.entries(streets.last.tiles).find(([, t]) => t.t === 'zone' && t.z === 'R' && t.lvl === 1)![0];
    expect(streets.last.derived.levels?.[r2].next).not.toContain('sidewalk');
  });

  it('сигналите влияят на града: авария с водата намалява водата, блокиран път – капацитета, боклук – удовлетвореността', () => {
    const base = run(makeCity(), 40).cur;
    const plain = stepCity(base);
    const road = Object.keys(base.tiles).filter((k) => base.tiles[k].t === 'road');
    const zone = Object.keys(base.tiles).find((k) => base.tiles[k].t === 'zone')!;
    const issues = [
      { kind: 'water_leak', key: road[2], severity: 3 },
      { kind: 'accident', key: road[5], severity: 1 },
      ...road.slice(8).map((key) => ({ kind: 'fallen_tree', key, severity: 1 })),
      { kind: 'garbage', key: zone, severity: 3 },
    ];
    const hit = stepCity({ ...base, ctx: { ...base.ctx, issues } });
    expect(hit.stats.water.supply).toBeLessThan(plain.stats.water.supply);
    expect(hit.stats.traffic.congestion).toBeGreaterThan(plain.stats.traffic.congestion);
    expect(hit.pop.happiness).toBeLessThan(plain.pop.happiness);
    expect(hit.derived.landValue[zone]).toBeLessThan(plain.derived.landValue[zone]);
    expect(hit.derived.levels?.[zone]?.next ?? ['no_issues']).toContain('no_issues');
  });
});
