import { CITIZEN_FIRST, CITIZEN_LAST, ISSUE_KINDS, ISSUE_TYPES, hashString, rand01, tileKey, type TileMap } from '@gce/shared';
import { withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, forbidden, notFound } from './errors';
import { SYS, acc, transfer } from './ledger';
import { idempotent } from './idempotency';
import { currentTick } from './world';
import { notify, publish } from './events';

/**
 * Сигнали от гражданите: в града спонтанно възникват проблеми (дупки, спукани тръби, боклук, катастрофи…).
 * Вероятността зависи от състоянието на града (бюджет за поддръжка, задръствания, полиция, сметища,
 * канализация). Докато са отворени, влошават мрежите и удовлетвореността и спират надграждането наоколо;
 * ако се пренебрегват, се влошават. Кметът изпраща ремонтен екип срещу заплащане от бюджета.
 */

const FEMALE = new Set(['Мария', 'Елена', 'Десислава', 'Радост', 'Виктория', 'Яна', 'Милена', 'Цвета', 'Невена', 'Лора']);

export function citizenName(seed: number): string {
  const first = CITIZEN_FIRST[Math.floor(rand01(seed, 1) * CITIZEN_FIRST.length)];
  const last = CITIZEN_LAST[Math.floor(rand01(seed, 2) * CITIZEN_LAST.length)];
  return `${first} ${FEMALE.has(first) ? `${last}а` : last}`;
}

export interface IssueView {
  id: string;
  kind: string;
  x: number;
  y: number;
  severity: number;
  status: string;
  reporter: string;
  message: string;
  createdTick: number;
  fixDoneTick: number | null;
  resolvedTick: number | null;
  resolvedBy: string | null;
  fixCost: number;
}

function view(i: {
  id: string;
  kind: string;
  x: number;
  y: number;
  severity: number;
  status: string;
  reporter: string;
  message: string;
  createdTick: number;
  fixDoneTick: number | null;
  resolvedTick: number | null;
  resolvedBy: string | null;
}): IssueView {
  return { ...i, fixCost: (ISSUE_TYPES[i.kind]?.fixCost ?? 0) * i.severity };
}

/** Отворени и в ремонт сигнали – за симулацията (ефектите важат, докато ремонтът не приключи). */
export async function activeIssues(db: PrismaClient | Tx, cityId: string): Promise<{ kind: string; key: string; severity: number }[]> {
  const rows = await db.cityIssue.findMany({ where: { cityId, status: { in: ['OPEN', 'FIXING'] } }, select: { kind: true, x: true, y: true, severity: true } });
  return rows.map((r) => ({ kind: r.kind, key: tileKey(r.x, r.y), severity: r.severity }));
}

interface CitySnapshot {
  id: string;
  name: string;
  ownerId: string;
  tiles: TileMap;
  policy: { serviceBudget: number };
  stats: {
    traffic?: { congestion: number };
    services?: { safety: number };
    waste?: { capacity: number; load: number };
    sewage?: { capacity: number; load: number };
    power?: { supply: number };
    water?: { supply: number };
  };
}

/**
 * Дневна обработка на сигналите (в транзакцията на тика на града – идемпотентно заедно с него):
 * приключване на ремонти, самоотшумяване, влошаване и нови сигнали.
 */
export async function advanceIssues(tx: Tx, city: CitySnapshot, tick: number, days: number): Promise<void> {
  const open = await tx.cityIssue.findMany({ where: { cityId: city.id, status: { in: ['OPEN', 'FIXING'] } } });
  for (const i of open) {
    const def = ISSUE_TYPES[i.kind];
    if (i.status === 'FIXING' && i.fixDoneTick !== null && i.fixDoneTick <= tick) {
      await tx.cityIssue.update({ where: { id: i.id }, data: { status: 'RESOLVED', resolvedTick: tick, resolvedBy: 'CREW' } });
      await notify(tx, city.ownerId, 'issue', `${city.name}: отстранено – ${def?.name ?? i.kind}. ${i.reporter} благодари!`);
      continue;
    }
    if (i.status !== 'OPEN' || !def) continue;
    const age = tick - i.createdTick;
    if (def.autoResolveDays && age >= def.autoResolveDays) {
      await tx.cityIssue.update({ where: { id: i.id }, data: { status: 'RESOLVED', resolvedTick: tick, resolvedBy: 'AUTO' } });
      continue;
    }
    if (def.escalateDays && i.severity < 3 && age >= def.escalateDays * i.severity) {
      await tx.cityIssue.update({ where: { id: i.id }, data: { severity: i.severity + 1 } });
      if (i.severity + 1 === 3)
        await notify(tx, city.ownerId, 'issue', `${city.name}: проблемът „${def.name}“ (${i.x}, ${i.y}) се влошава! Гражданите са недоволни.`);
    }
  }

  // ---- нови сигнали ----
  const tiles = city.tiles;
  const roads: string[] = [];
  const buildings: string[] = [];
  const residential: string[] = [];
  let hasWater = false;
  let hasPower = false;
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t === 'road') roads.push(k);
    else if (t.t === 'zone' && t.lvl > 0 && !t.ab) {
      buildings.push(k);
      if (t.z === 'R') residential.push(k);
    } else if (t.t === 'service') {
      if (t.s === 'water_pump') hasWater = true;
      if (t.s === 'power_coal' || t.s === 'power_wind') hasPower = true;
    }
  }
  if (!roads.length && !buildings.length) return;
  const openNow = (await tx.cityIssue.count({ where: { cityId: city.id, status: { in: ['OPEN', 'FIXING'] } } })) as number;
  const cap = 4 + Math.floor((roads.length + buildings.length) / 40);
  if (openNow >= cap) return;
  const taken = new Set(open.map((i) => tileKey(i.x, i.y)));
  const s = city.stats ?? {};
  const budget = city.policy?.serviceBudget ?? 1;
  const congestion = s.traffic?.congestion ?? 0;
  const safety = s.services?.safety ?? 0;
  const wasteOver = s.waste ? s.waste.load > s.waste.capacity : false;
  const sewageOver = s.sewage ? s.sewage.load > s.sewage.capacity : false;
  const factor = (kind: string): number => {
    switch (kind) {
      case 'pothole':
        return Math.max(0.3, 1.6 - budget) * (1 + Math.min(1.5, congestion));
      case 'water_leak':
        return hasWater ? Math.max(0.4, 1.4 - budget) : 0;
      case 'power_outage':
        return hasPower ? Math.max(0.4, 1.4 - budget) : 0;
      case 'garbage':
        return wasteOver ? 3 : 0.5;
      case 'graffiti':
        return 1.5 - safety;
      case 'accident':
        return (0.3 + Math.min(2, congestion)) * (1.3 - safety * 0.8);
      case 'sewage':
        return sewageOver ? 2.5 : 0.15;
      default:
        return 1;
    }
  };
  const seed = hashString(city.id);
  const span = Math.min(days, 3);
  let created = 0;
  for (let ki = 0; ki < ISSUE_KINDS.length && openNow + created < cap; ki++) {
    const kind = ISSUE_KINDS[ki];
    const def = ISSUE_TYPES[kind];
    const pool = def.site === 'road' ? roads : def.site === 'residential' ? residential : buildings;
    if (!pool.length) continue;
    const lambda = def.rate * pool.length * factor(kind) * span;
    const n = Math.floor(lambda) + (rand01(seed, tick, ki, 1) < lambda - Math.floor(lambda) ? 1 : 0);
    for (let j = 0; j < n && openNow + created < cap; j++) {
      const key = pool[Math.floor(rand01(seed, tick, ki, j, 2) * pool.length)];
      if (taken.has(key)) continue;
      taken.add(key);
      const [x, y] = key.split(',').map(Number);
      const reporter = citizenName(hashString(`${city.id}:${tick}:${ki}:${j}`));
      const message = def.messages[Math.floor(rand01(seed, tick, ki, j, 3) * def.messages.length)];
      await tx.cityIssue.create({ data: { cityId: city.id, kind, x, y, reporter, message, createdTick: tick } });
      created++;
    }
  }
  if (created > 0) {
    await notify(
      tx,
      city.ownerId,
      'issue',
      `${city.name}: ${created === 1 ? 'нов сигнал от граждани' : `${created} нови сигнала от граждани`} – вижте „Сигнали“.`,
    );
    await publish(tx, { type: 'city', cityId: city.id, ownerId: city.ownerId });
  }
}

/** Сигналите на града (само за кмета): отворените и последните отстранени. */
export async function listIssues(prisma: PrismaClient, userId: string, cityId: string): Promise<{ open: IssueView[]; recent: IssueView[] }> {
  const city = await prisma.city.findUnique({ where: { id: cityId }, select: { ownerId: true } });
  if (!city) throw notFound('Градът');
  if (city.ownerId !== userId) throw forbidden('Сигналите се виждат само от кмета');
  const [open, recent] = await Promise.all([
    prisma.cityIssue.findMany({ where: { cityId, status: { in: ['OPEN', 'FIXING'] } }, orderBy: [{ severity: 'desc' }, { createdTick: 'asc' }] }),
    prisma.cityIssue.findMany({ where: { cityId, status: 'RESOLVED' }, orderBy: { resolvedTick: 'desc' }, take: 15 }),
  ]);
  return { open: open.map(view), recent: recent.map(view) };
}

/** Изпраща ремонтен екип: таксува бюджета на града (цена × степен) и отстранява проблема след няколко дни. */
export async function fixIssue(prisma: PrismaClient, userId: string, cityId: string, issueId: string, idemKey?: string): Promise<IssueView> {
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `issue-fix:${idemKey}` : undefined, async () => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "CityIssue" WHERE id = ${issueId} AND "cityId" = ${cityId} FOR UPDATE`;
      if (!rows.length) throw notFound('Сигналът');
      const city = await tx.city.findUniqueOrThrow({ where: { id: cityId }, select: { ownerId: true } });
      if (city.ownerId !== userId) throw forbidden('Само кметът може да изпраща екипи');
      const issue = await tx.cityIssue.findUniqueOrThrow({ where: { id: issueId } });
      if (issue.status !== 'OPEN') throw bad(issue.status === 'FIXING' ? 'Екипът вече работи по сигнала' : 'Сигналът е отстранен');
      const def = ISSUE_TYPES[issue.kind];
      if (!def) throw bad('Непознат тип сигнал');
      const tick = await currentTick(tx);
      const cost = def.fixCost * issue.severity;
      await transfer(tx, {
        from: acc.city(cityId),
        to: SYS.WORLD,
        amount: cost,
        kind: 'ISSUE_FIX',
        tick,
        key: `issue-fix:${issueId}`,
        refType: 'CityIssue',
        refId: issueId,
        memo: def.name,
      }).catch((e) => {
        if (e instanceof DomainError && e.code === 'INSUFFICIENT_FUNDS')
          throw new DomainError('INSUFFICIENT_FUNDS', 'Няма достатъчно пари в бюджета за ремонта', 402);
        throw e;
      });
      const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(cityId) } });
      if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', 'Няма достатъчно пари в бюджета за ремонта', 402);
      const updated = await tx.cityIssue.update({
        where: { id: issueId },
        data: { status: 'FIXING', fixDoneTick: tick + def.fixDays, cost: BigInt(cost) },
      });
      await publish(tx, { type: 'city', cityId, ownerId: userId });
      return view(updated);
    }),
  );
}
