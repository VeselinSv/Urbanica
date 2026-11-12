import { beforeAll, describe, expect, it } from 'vitest';
import { SYS, acc, advanceIssues, build, fixIssue, listIssues } from '@gce/domain';
import { ISSUE_TYPES, type TileMap } from '@gce/shared';
import { withTx } from '@gce/database';
import { balance, cityWithRoad, expectInvariants, player, prisma, resetDb } from './helpers';

beforeAll(async () => {
  await resetDb();
});

async function snapshot(cityId: string) {
  const c = await prisma.city.findUniqueOrThrow({ where: { id: cityId } });
  return {
    id: c.id,
    name: c.name,
    ownerId: c.ownerId,
    tiles: c.tiles as unknown as TileMap,
    policy: { serviceBudget: 0.5 },
    stats: { traffic: { congestion: 1.5 } },
  };
}

describe('Сигнали от гражданите', () => {
  it('възникват на пътища/сгради на града, имат подател и текст, броят им е ограничен', async () => {
    const p = await player('Iss');
    const { city, free } = await cityWithRoad(p.id);
    await build(prisma, p.id, city.id, { action: 'zone', zone: 'R', tiles: free.slice(0, 10) });
    const snap = await snapshot(city.id);
    for (let t = 1; t <= 400; t++) await withTx(prisma, (tx) => advanceIssues(tx, snap, t, 3));
    const { open } = await listIssues(prisma, p.id, city.id);
    expect(open.length).toBeGreaterThan(0);
    const roads = Object.entries(snap.tiles).filter(([, t]) => t.t === 'road').length;
    expect(open.length).toBeLessThanOrEqual(4 + Math.floor(roads / 40));
    for (const i of open) {
      expect(ISSUE_TYPES[i.kind]).toBeDefined();
      expect(snap.tiles[`${i.x},${i.y}`]).toBeDefined();
      expect(i.reporter.length).toBeGreaterThan(3);
      expect(i.message.length).toBeGreaterThan(10);
      expect(i.severity).toBeGreaterThanOrEqual(1);
      expect(i.severity).toBeLessThanOrEqual(3);
    }
    // сигналите са поверителни
    const q = await player('Spy');
    await expect(listIssues(prisma, q.id, city.id)).rejects.toMatchObject({ status: 403 });
  });

  it('ремонт: таксува бюджета (цена × степен), идемпотентен, само от кмета; приключва след дните на ремонта', async () => {
    const p = await player('Fix');
    const { city } = await cityWithRoad(p.id);
    const snap = await snapshot(city.id);
    let t = 1;
    while (!(await prisma.cityIssue.count({ where: { cityId: city.id, status: 'OPEN' } })) && t < 2000) {
      await withTx(prisma, (tx) => advanceIssues(tx, snap, t, 3));
      t++;
    }
    const issue = (await listIssues(prisma, p.id, city.id)).open.find((i) => i.status === 'OPEN')!;
    expect(issue).toBeDefined();
    const q = await player('NotMayor');
    await expect(fixIssue(prisma, q.id, city.id, issue.id)).rejects.toMatchObject({ status: 403 });
    const before = await balance(acc.city(city.id));
    const [a, b] = await Promise.all([fixIssue(prisma, p.id, city.id, issue.id, 'fix-1'), fixIssue(prisma, p.id, city.id, issue.id, 'fix-1')]);
    expect(a.status).toBe('FIXING');
    expect(b.id).toBe(a.id);
    expect(before - (await balance(acc.city(city.id)))).toBe(ISSUE_TYPES[issue.kind].fixCost * issue.severity);
    await expect(fixIssue(prisma, p.id, city.id, issue.id)).rejects.toThrow(/вече работи/);
    const ledger = await prisma.ledgerEntry.findMany({ where: { kind: 'ISSUE_FIX', fromAccountId: acc.city(city.id) } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].toAccountId).toBe(SYS.WORLD);
    // ремонтът приключва на fixDoneTick
    await withTx(prisma, (tx) => advanceIssues(tx, snap, a.fixDoneTick!, 1));
    const done = await prisma.cityIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(done.status).toBe('RESOLVED');
    expect(done.resolvedBy).toBe('CREW');
    await expectInvariants();
  });

  it('пренебрегнатите проблеми се влошават, катастрофите отшумяват сами', async () => {
    const p = await player('Esc');
    const { city, road } = await cityWithRoad(p.id);
    const k = road[3];
    await prisma.cityIssue.create({ data: { cityId: city.id, kind: 'pothole', x: k.x, y: k.y, reporter: 'Тест', message: 'дупка', createdTick: 0 } });
    await prisma.cityIssue.create({
      data: { cityId: city.id, kind: 'accident', x: road[6].x, y: road[6].y, reporter: 'Тест', message: 'катастрофа', createdTick: 0 },
    });
    const snap = { ...(await snapshot(city.id)), stats: {} };
    // до най-тежката степен: два пъти по „escalateDays“ (степен 1→2 и 2→3)
    const days = ISSUE_TYPES.pothole.escalateDays * 2 + 2;
    for (let t = 1; t <= days; t++) await withTx(prisma, (tx) => advanceIssues(tx, snap, t, 1));
    const pothole = await prisma.cityIssue.findFirstOrThrow({ where: { cityId: city.id, kind: 'pothole', reporter: 'Тест' } });
    const accident = await prisma.cityIssue.findFirstOrThrow({ where: { cityId: city.id, kind: 'accident', reporter: 'Тест' } });
    expect(pothole.severity).toBe(3);
    expect(accident.status).toBe('RESOLVED');
    expect(accident.resolvedBy).toBe('AUTO');
  });
});
