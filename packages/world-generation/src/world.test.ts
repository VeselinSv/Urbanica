import { describe, expect, it } from 'vitest';
import { BALANCE, BuildSchema, PlaceOrderSchema, PolicySchema, RegisterSchema, gameDate, isMonthEnd } from '@gce/shared';
import { REAL_PLACES, Terrain, WATER_LAKE, WATER_OCEAN, WATER_RIVER, WorldGenerator, getWorld, isWater } from './index';

describe('Процедурен свят', () => {
  it('картата е реалната България: всеки seed дава същия релеф и същите области (възпроизводимост)', () => {
    const a = new WorldGenerator('seed-a');
    const b = new WorldGenerator('seed-a');
    const c = new WorldGenerator('seed-b');
    for (let i = 0; i < 2000; i++) {
      const x = (i * 37) % 512;
      const y = (i * 91) % 512;
      expect(a.tileAt(x, y)).toEqual(b.tileAt(x, y));
      expect(a.tileAt(x, y).region).toBe(c.tileAt(x, y).region);
      expect(Math.abs(a.tileAt(x, y).elevation - c.tileAt(x, y).elevation)).toBeLessThan(0.01);
    }
  }, 30_000);

  it('съдържа вода, суша, планини, гори, реки и находища', () => {
    const w = new WorldGenerator('gce-alpha-1');
    const seen = new Set<Terrain>();
    let iron = 0;
    let coal = 0;
    for (let y = 0; y < 512; y += 3)
      for (let x = 0; x < 512; x += 3) {
        const t = w.tileAt(x, y);
        seen.add(t.terrain);
        if (t.deposit === 'iron') iron++;
        if (t.deposit === 'coal') coal++;
      }
    for (const t of [Terrain.DeepWater, Terrain.Plains, Terrain.Forest, Terrain.Hills, Terrain.Mountains, Terrain.River]) expect(seen.has(t)).toBe(true);
    expect(iron).toBeGreaterThan(10);
    expect(coal).toBeGreaterThan(10);
  });

  it('строи се само в България: съседните страни, морето и водата не са строителна площ', () => {
    const w = getWorld('gce-alpha-1');
    for (let i = 0; i < BALANCE.world.size; i += 16) {
      expect(w.buildable(i, 0)).toBe(false);
      expect(w.buildable(0, i)).toBe(false);
    }
    expect(w.buildable(-1, 5)).toBe(false);
    const sofia = REAL_PLACES.find((p) => p.name === 'София')!;
    expect(w.inCountry(sofia.x, sofia.y)).toBe(true);
    expect(w.tileAt(sofia.x, sofia.y).region).toBeGreaterThanOrEqual(0);
    expect(w.regions[w.tileAt(sofia.x, sofia.y).region].name).toMatch(/София/);
  });

  it('чанковете съвпадат с плочките', () => {
    const w = new WorldGenerator('chunks');
    const ch = w.chunk(3, 4);
    expect(ch.terrain[5 * 32 + 7]).toBe(w.tileAt(3 * 32 + 7, 4 * 32 + 5).terrain);
  });

  it('правилата за разполагане проверяват ресурсите', () => {
    const w = new WorldGenerator('gce-alpha-1');
    let found = false;
    for (let y = 0; y < 512 && !found; y++)
      for (let x = 0; x < 512 && !found; x++)
        if (w.tileAt(x, y).deposit === 'iron' && w.inCountry(x, y)) {
          expect(w.satisfiesPlacement('iron', x, y).ok).toBe(true);
          expect(w.satisfiesPlacement('coal', x, y).ok).toBe(false);
          found = true;
        }
    expect(found).toBe(true);
  });
});

describe('Държава (генератор v2)', () => {
  const w = getWorld('gce-alpha-1');
  const N = w.size;

  it('реалните 28 области на България; светът започва празен – цялата суша в България е строителна площ', () => {
    expect(w.regions.length).toBe(28);
    expect(w.country.name).toBe('България');
    const names = w.regions.map((r) => r.name).join(',');
    for (const n of ['Пловдив', 'Варна', 'Бургас', 'Русе', 'Смолян', 'Видин', 'София']) expect(names).toContain(n);
    expect((w as unknown as { settlements?: unknown }).settlements).toBeUndefined();
    let land = 0;
    let buildable = 0;
    const perRegion = new Map<number, number>();
    for (let y = 0; y < N; y += 2)
      for (let x = 0; x < N; x += 2) {
        const t = w.tileAt(x, y);
        if (isWater(t.terrain) || !w.inCountry(x, y)) continue;
        land++;
        if (w.buildable(x, y)) buildable++;
        expect(t.region).toBeGreaterThanOrEqual(0);
        perRegion.set(t.region, (perRegion.get(t.region) ?? 0) + 1);
      }
    expect(buildable).toBe(land);
    // всяка област има реална територия
    for (const r of w.regions) expect(perRegion.get(r.id) ?? 0).toBeGreaterThan(5);
  });

  it('реките текат надолу и завършват в море, езеро или друга река', () => {
    expect(w.rivers.length).toBeGreaterThan(10);
    // реалните планини: най-високата точка в България е над 2000 m (> MOUNTAINS)
    let maxH = 0;
    for (let k = 0; k < N * N; k++) if (w.country.region[k] !== 255) maxH = Math.max(maxH, w.country.height[k]);
    expect(maxH).toBeGreaterThan(0.85);
    for (const r of w.rivers) {
      // в съседните страни някои реки излизат извън картата („edge“)
      expect(['ocean', 'lake', 'river', 'edge']).toContain(r.mouth);
      const a = r.points[0];
      const b = r.points[r.points.length - 1];
      const cl = (v: number) => Math.max(0, Math.min(N - 1, Math.floor(v)));
      const h = (p: { x: number; y: number }) => w.country.height[cl(p.y) * N + cl(p.x)];
      expect(h(a)).toBeGreaterThanOrEqual(h(b) - 0.02);
      // ширината расте към устието
      expect(b.w).toBeGreaterThanOrEqual(a.w - 1e-6);
    }
    const kinds = new Set(Array.from(w.country.water));
    for (const k of [WATER_OCEAN, WATER_LAKE, WATER_RIVER]) expect(kinds.has(k)).toBe(true);
  });
});

describe('Време и валидиране', () => {
  it('мостове: над река (4x) и езеро/залив (6x) може, в открито море – не', () => {
    const w = getWorld('gce-alpha-1');
    const find = (t: Terrain) => {
      for (let y = 0; y < w.size; y++) for (let x = 0; x < w.size; x++) if (w.inCountry(x, y) && w.tileAt(x, y).terrain === t) return { x, y };
      return null;
    };
    const river = find(Terrain.River)!;
    expect(w.roadCostMult(river.x, river.y)).toBe(4);
    // езера в България може и да няма в този свят – ако има, мостът е 6x
    const lake = find(Terrain.Water);
    if (lake) expect(w.roadCostMult(lake.x, lake.y)).toBe(6);
    const deep = find(Terrain.DeepWater);
    if (deep) expect(w.roadCostMult(deep.x, deep.y)).toBe(Infinity);
  });

  it('игровият календар', () => {
    expect(gameDate(0)).toMatchObject({ year: 1, month: 1, day: 1 });
    expect(gameDate(359)).toMatchObject({ year: 1, month: 12, day: 30 });
    expect(gameDate(360)).toMatchObject({ year: 2, month: 1, day: 1 });
    expect(isMonthEnd(29)).toBe(true);
    expect(isMonthEnd(30)).toBe(false);
  });

  it('отхвърля невалидни входни данни на границата', () => {
    expect(RegisterSchema.safeParse({ username: 'a', email: 'x', password: '1' }).success).toBe(false);
    expect(RegisterSchema.safeParse({ username: 'Valid_1', email: 'a@b.cd', password: '12345678' }).success).toBe(true);
    expect(BuildSchema.safeParse({ action: 'road', tiles: [{ x: -1, y: 0 }] }).success).toBe(false);
    expect(
      BuildSchema.safeParse({
        action: 'service',
        service: 'school',
        tiles: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(PolicySchema.safeParse({ taxes: { income: 0.9 } }).success).toBe(false);
    expect(PolicySchema.safeParse({ taxes: { income: 0.2 } }).success).toBe(true);
    expect(PlaceOrderSchema.safeParse({ instrument: 'GOOD:gold', side: 'BUY', quantity: 1, price: 1, companyId: 'c', cityId: 'x' }).success).toBe(false);
    expect(PlaceOrderSchema.safeParse({ instrument: 'GOOD:coal', side: 'BUY', quantity: 1, price: 1 }).success).toBe(false);
    expect(PlaceOrderSchema.safeParse({ instrument: 'GOOD:coal', side: 'BUY', quantity: 0, price: 1, companyId: 'c', cityId: 'x' }).success).toBe(false);
    expect(PlaceOrderSchema.safeParse({ instrument: 'SHARE:abc', side: 'SELL', quantity: 5, price: 100 }).success).toBe(true);
  });
});
