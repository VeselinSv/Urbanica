import { beforeAll, describe, expect, it } from 'vitest';
import {
  SYS,
  acc,
  build,
  buildLink,
  createGuest,
  buildFacility,
  buyParcel,
  foundCity,
  linkShippingMult,
  sessionUser,
  setPolicy,
  undoBuild,
  worldGen,
  placeOrder,
  resetPlayer,
} from '@gce/domain';
import { BALANCE, ZONES, tileKey } from '@gce/shared';
import { balance, cityWithRoad, companyIn, expectInvariants, player, prisma, resetDb } from './helpers';

beforeAll(async () => {
  await resetDb();
});

describe('Играч и сесия', () => {
  it('създава играч с начален капитал и валидна сесия', async () => {
    const p = await player('Auth');
    expect(await balance(acc.user(p.id))).toBe(BALANCE.start.wallet);
    const u = await sessionUser(prisma, p.token);
    expect(u?.id).toBe(p.id);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(stored.passwordHash).not.toContain('password123');
  });

  it('автоматичен играч: без регистрация, уникално име, стартов капитал и дълга сесия', async () => {
    const a = await createGuest(prisma);
    const b = await createGuest(prisma);
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user.username).toMatch(/^Кмет-[0-9A-F]{6}$/);
    expect(await balance(acc.user(a.user.id))).toBe(BALANCE.start.wallet);
    expect((await sessionUser(prisma, a.token))?.id).toBe(a.user.id);
    const s = await prisma.session.findFirstOrThrow({ where: { userId: a.user.id } });
    expect(s.expiresAt.getTime() - Date.now()).toBeGreaterThan(365 * 86400_000);
  });

  it('градът се основава на избраното място (или най-близкото подходящо) само в България', async () => {
    const gen = await worldGen(prisma);
    const p = await player('Pick');
    // търсим равна суша в България
    let spot: { x: number; y: number } | null = null;
    for (let y = 120; y < 400 && !spot; y += 7)
      for (let x = 120; x < 400 && !spot; x += 7) {
        let ok = true;
        for (let j = -12; j < 12 && ok; j += 3) for (let i = -12; i < 12 && ok; i += 3) if (!gen.buildable(x + i, y + j)) ok = false;
        if (ok) spot = { x, y };
      }
    expect(spot).not.toBeNull();
    const city = await foundCity(prisma, p.id, 'Избрано място', spot!);
    expect(Math.abs(city.originX - spot!.x)).toBeLessThanOrEqual(8 * 7);
    expect(Math.abs(city.originY - spot!.y)).toBeLessThanOrEqual(8 * 7);
    // в морето/чужбина – отказ
    const q = await player('Sea');
    await expect(foundCity(prisma, q.id, 'Море', { x: 500, y: 500 })).rejects.toThrow(/България|вода/);
  });
});

describe('Град, строителство и собственост', () => {
  it('основава град с начален бюджет и 3x3 парцела; строителството таксува сървърът', async () => {
    const p = await player('City');
    const { city, road } = await cityWithRoad(p.id);
    const parcels = await prisma.parcel.count({ where: { cityId: city.id } });
    expect(parcels).toBe(BALANCE.world.startParcels ** 2);
    const spent = BALANCE.start.cityTreasury - (await balance(acc.city(city.id)));
    expect(spent).toBeGreaterThanOrEqual(road.length * BALANCE.construction.roadCost);
    const entries = await prisma.ledgerEntry.findMany({ where: { fromAccountId: acc.city(city.id), kind: 'CONSTRUCTION' } });
    expect(entries.reduce((a, e) => a + Number(e.amount), 0)).toBe(spent);
  });

  it('идемпотентен ключ: повторената заявка не таксува втори път', async () => {
    const p = await player('Idem');
    const { city, free } = await cityWithRoad(p.id);
    const before = await balance(acc.city(city.id));
    const body = { action: 'zone' as const, zone: 'R' as const, tiles: free.slice(0, 5) };
    const [a, b] = await Promise.all([build(prisma, p.id, city.id, body, 'same-key'), build(prisma, p.id, city.id, body, 'same-key')]);
    expect(a.cost).toBe(b.cost);
    expect(before - (await balance(acc.city(city.id)))).toBe(5 * ZONES.R.zoningCost);
  });

  it('забранява строеж извън територията и в чужд град', async () => {
    const p = await player('Own');
    const q = await player('Other');
    const { city, ox, oy } = await cityWithRoad(p.id);
    await expect(build(prisma, p.id, city.id, { action: 'road', tiles: [{ x: ox - 5, y: oy - 5 }] })).rejects.toThrow(/територията/);
    await expect(build(prisma, q.id, city.id, { action: 'road', tiles: [{ x: ox + 1, y: oy + 1 }] })).rejects.toMatchObject({ status: 403 });
    await expect(setPolicy(prisma, q.id, city.id, { taxes: { income: 0.3 } })).rejects.toMatchObject({ status: 403 });
  });

  it('пътни категории и кръстовища: цена по категория, правило за кръстовище', async () => {
    const p = await player('Roads');
    const { city, road } = await cityWithRoad(p.id);
    const gen = await worldGen(prisma);
    const before = await balance(acc.city(city.id));
    const up = road.slice(0, 4);
    const r1 = await build(prisma, p.id, city.id, { action: 'road', roadClass: 'avenue', tiles: up });
    expect(r1.applied).toBe(4);
    const RC = BALANCE.construction.roadClasses;
    const expected = up.reduce((a, t) => a + Math.round(BALANCE.construction.roadCost * (RC.avenue.cost - RC.street.cost) * gen.roadCostMult(t.x, t.y)), 0);
    expect(before - (await balance(acc.city(city.id)))).toBe(expected);
    const c1 = await prisma.city.findUniqueOrThrow({ where: { id: city.id } });
    expect((c1.tiles as Record<string, { c?: string }>)[tileKey(up[0].x, up[0].y)].c).toBe('avenue');
    // кръстовище с по-малко от 3 пътя → отказ
    await expect(build(prisma, p.id, city.id, { action: 'junction', control: 'roundabout', tiles: [road[6]] })).rejects.toThrow(/поне 3/);
    // напречна улица → Т-кръстовище → светофари
    const mid = road[8];
    const cross = [{ x: mid.x, y: mid.y + 1 }].filter((t) => gen.buildable(t.x, t.y));
    if (cross.length) {
      await build(prisma, p.id, city.id, { action: 'road', tiles: cross });
      const b2 = await balance(acc.city(city.id));
      const r2 = await build(prisma, p.id, city.id, { action: 'junction', control: 'signals', tiles: [mid] });
      expect(r2.applied).toBe(1);
      expect(b2 - (await balance(acc.city(city.id)))).toBe(BALANCE.construction.junctions.signals.cost);
      const c2 = await prisma.city.findUniqueOrThrow({ where: { id: city.id } });
      expect((c2.tiles as Record<string, { j?: string }>)[tileKey(mid.x, mid.y)].j).toBe('signals');
    }
    await expectInvariants();
  });

  it('тротоари и пешеходни алеи: цена, премахване, запазване при смяна на категорията, без тротоари по магистрала', async () => {
    const p = await player('Walk');
    const { city, road, free } = await cityWithRoad(p.id);
    const gen = await worldGen(prisma);
    const tilesOf = async () =>
      (await prisma.city.findUniqueOrThrow({ where: { id: city.id } })).tiles as Record<string, { t: string; c?: string; sw?: boolean }>;
    // улицата вече има тротоари – няма какво да се плаща
    const r0 = await build(prisma, p.id, city.id, { action: 'sidewalk', tiles: road.slice(0, 2) });
    expect(r0.applied).toBe(0);
    // селски път без тротоари → добавяме
    const rural = road.slice(2, 5);
    await build(prisma, p.id, city.id, { action: 'road', roadClass: 'rural', tiles: rural });
    expect((await tilesOf())[tileKey(rural[0].x, rural[0].y)].sw).toBeUndefined();
    const b0 = await balance(acc.city(city.id));
    const r1 = await build(prisma, p.id, city.id, { action: 'sidewalk', tiles: rural });
    expect(r1.applied).toBe(3);
    expect(b0 - (await balance(acc.city(city.id)))).toBe(3 * BALANCE.construction.sidewalkCost);
    expect((await tilesOf())[tileKey(rural[0].x, rural[0].y)]).toMatchObject({ t: 'road', c: 'rural', sw: true });
    // смяната на категорията пази тротоара
    await build(prisma, p.id, city.id, { action: 'road', roadClass: 'industrial', tiles: [rural[0]] });
    expect((await tilesOf())[tileKey(rural[0].x, rural[0].y)]).toMatchObject({ c: 'industrial', sw: true });
    // премахване от улица (по подразбиране има) → sw: false, безплатно
    const b1 = await balance(acc.city(city.id));
    const r2 = await build(prisma, p.id, city.id, { action: 'sidewalk', remove: true, tiles: [road[0]] });
    expect(r2.applied).toBe(1);
    expect(await balance(acc.city(city.id))).toBe(b1);
    expect((await tilesOf())[tileKey(road[0].x, road[0].y)].sw).toBe(false);
    // алея на празна земя
    const spot = free.find((t) => !road.some((r) => r.x === t.x && r.y === t.y))!;
    const b2 = await balance(acc.city(city.id));
    const r3 = await build(prisma, p.id, city.id, { action: 'sidewalk', tiles: [spot] });
    expect(r3.applied).toBe(1);
    expect(b2 - (await balance(acc.city(city.id)))).toBe(Math.round(BALANCE.construction.pathCost * gen.roadCostMult(spot.x, spot.y)));
    expect((await tilesOf())[tileKey(spot.x, spot.y)]).toEqual({ t: 'path' });
    // магистрала – отказ
    await build(prisma, p.id, city.id, { action: 'road', roadClass: 'highway', tiles: [road[6]] });
    await expect(build(prisma, p.id, city.id, { action: 'sidewalk', tiles: [road[6]] })).rejects.toThrow(/Магистралите/);
    await expectInvariants();
  });

  it('автобусни спирки: само по улица, не на кръстовище; „Отмени“ връща плочките и парите', async () => {
    const p = await player('Bus');
    const { city, road } = await cityWithRoad(p.id);
    const tilesOf = async () => (await prisma.city.findUniqueOrThrow({ where: { id: city.id } })).tiles as Record<string, { t: string; st?: boolean }>;
    const b0 = await balance(acc.city(city.id));
    const r1 = await build(prisma, p.id, city.id, { action: 'busstop', tiles: [road[4]] });
    expect(r1.applied).toBe(1);
    expect(b0 - (await balance(acc.city(city.id)))).toBe(BALANCE.construction.busStopCost);
    expect((await tilesOf())[tileKey(road[4].x, road[4].y)].st).toBe(true);
    // „Отмени“ – спирката изчезва, парите се връщат
    const u = await undoBuild(prisma, p.id, city.id);
    expect(u.refund).toBe(BALANCE.construction.busStopCost);
    expect(await balance(acc.city(city.id))).toBe(b0);
    expect((await tilesOf())[tileKey(road[4].x, road[4].y)].st).toBeUndefined();
    await expect(undoBuild(prisma, p.id, city.id)).rejects.toThrow(/Няма какво/);
    // върху празна земя – отказ
    await expect(build(prisma, p.id, city.id, { action: 'busstop', tiles: [{ x: road[4].x, y: road[4].y - 3 }] })).rejects.toThrow(/върху път/);
    await expectInvariants();
  });

  it('магистрала между два града: цена по дължина, двупосочна, превозът е по-евтин', async () => {
    const p = await player('LinkA');
    const q = await player('LinkB');
    const a = await foundCity(prisma, p.id, 'Линк А', { x: 230, y: 330 });
    const b = await foundCity(prisma, q.id, 'Линк Б', { x: 300, y: 300 });
    const before = await balance(acc.city(a.id));
    expect(await linkShippingMult(prisma, a.id, b.id)).toBe(1);
    const res = await buildLink(prisma, p.id, a.id, b.id);
    expect(res.length).toBeGreaterThan(0);
    expect(before - (await balance(acc.city(a.id)))).toBe(res.cost);
    expect(res.cost).toBe(Math.round(res.length * BALANCE.links.costPerTile));
    expect(await linkShippingMult(prisma, b.id, a.id)).toBe(BALANCE.links.shippingMult);
    // повторно (и от другия град) – отказ; чужд град – само кметът
    await expect(buildLink(prisma, q.id, b.id, a.id)).rejects.toThrow(/вече са свързани/);
    await expect(buildLink(prisma, q.id, a.id, b.id)).rejects.toMatchObject({ status: 403 });
    await expectInvariants();
  });

  it('„Започни отначало“: градове и компании изчезват, ескроу се връща, портфейлът е стартовият, парите не се създават от нищо', async () => {
    const p = await player('Reset');
    const { city } = await cityWithRoad(p.id);
    const co = await companyIn(p.id, city.id);
    // отворена поръчка за покупка – парите са в ескроу
    await placeOrder(prisma, p.id, { instrument: 'GOOD:coal', side: 'BUY', quantity: 5, price: 600 * 4.5, companyId: co.id, cityId: city.id });
    const res = await resetPlayer(prisma, p.id);
    expect(res.cities).toBe(1);
    expect(res.companies).toBe(1);
    expect(await prisma.city.count({ where: { ownerId: p.id } })).toBe(0);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: co.id } })).status).toBe('DISSOLVED');
    expect(await prisma.marketOrder.count({ where: { traderId: co.id, status: 'OPEN' } })).toBe(0);
    expect(await balance(acc.user(p.id))).toBe(BALANCE.start.wallet);
    expect(await balance(acc.company(co.id))).toBe(0);
    // нов град след рестарта
    const again = await foundCity(prisma, p.id, 'Отначало');
    expect(await balance(acc.city(again.id))).toBe(BALANCE.start.cityTreasury);
    await expectInvariants();
  });

  it('паралелна покупка на един и същ парцел – само един успява', async () => {
    const p = await player('Land');
    const { city } = await cityWithRoad(p.id);
    const parcels = await prisma.parcel.findMany({ where: { cityId: city.id } });
    const owned = new Set(parcels.map((x) => `${x.px},${x.py}`));
    const gen = await worldGen(prisma);
    // съседен парцел, който може да се купи (суша в България) – картата е реална, градът може да е до граница/бряг
    let target: { px: number; py: number } | null = null;
    for (const pc of parcels)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const c = { px: pc.px + dx, py: pc.py + dy };
        const prof = gen.parcelProfile(c.px, c.py);
        if (!target && !owned.has(`${c.px},${c.py}`) && prof.inCountry >= 0.5 && prof.land >= 0.2) target = c;
      }
    expect(target).not.toBeNull();
    const { px, py } = target!;
    const results = await Promise.allSettled([buyParcel(prisma, p.id, city.id, px, py), buyParcel(prisma, p.id, city.id, px, py)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await prisma.parcel.count({ where: { px, py } })).toBe(1);
    const maxPx = Math.max(...parcels.map((x) => x.px));
    await expect(buyParcel(prisma, p.id, city.id, maxPx + 5, parcels[0].py)).rejects.toThrow(/граничи|България|вода/);
  });

  it('вторият град се плаща от портфейла, без създаване на пари', async () => {
    const p = await player('Two');
    await foundCity(prisma, p.id, 'Първи');
    await prisma.$executeRawUnsafe(`UPDATE "Account" SET balance = balance WHERE id = '${acc.user(p.id)}'`);
    // Портфейлът (50 000 €) не стига за втори град (100 000 €).
    await expect(foundCity(prisma, p.id, 'Втори')).rejects.toThrow(/Недостатъчни/);
  });

  it('предприятие изисква подходящо място и права', async () => {
    const p = await player('Fac');
    const q = await player('Fac');
    const { city, free } = await cityWithRoad(p.id);
    const co = await companyIn(p.id, city.id);
    const f = await buildFacility(prisma, p.id, co.id, { cityId: city.id, type: 'warehouse', x: free[0].x, y: free[0].y });
    expect(f.id).toBeTruthy();
    await expect(buildFacility(prisma, p.id, co.id, { cityId: city.id, type: 'warehouse', x: free[0].x, y: free[0].y })).rejects.toThrow();
    await expect(buildFacility(prisma, q.id, co.id, { cityId: city.id, type: 'warehouse', x: free[1].x, y: free[1].y })).rejects.toMatchObject({ status: 403 });
    await expectInvariants();
  });

  it('системните сметки са отрицателни само за MINT/WORLD', async () => {
    expect(await balance(SYS.MINT)).toBeLessThan(0);
    expect(await balance(SYS.ESCROW)).toBeGreaterThanOrEqual(0);
  });
});
