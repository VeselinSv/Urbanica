/**
 * Магистрали между градовете. Кметът плаща от бюджета на града си; магистралата важи и в двете посоки:
 * превозът на стоки между двата града е по-евтин и по-бърз (множител BALANCE.links.shippingMult).
 */
import { BALANCE, type TileMap } from '@gce/shared';
import { isUniqueViolation, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, transfer } from './ledger';
import { idempotent } from './idempotency';
import { cityDistance, currentTick } from './world';
import { lockCity } from './cities';
import { logEvent } from './events';
import { loadCityHeavy } from './cityCache';

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** Цена на магистрала с дадена дължина (центове). */
export function linkCost(length: number) {
  return Math.round(length * BALANCE.links.costPerTile);
}

export async function buildLink(prisma: PrismaClient, userId: string, cityId: string, toCityId: string, idemKey?: string) {
  if (cityId === toCityId) throw bad('Изберете друг град');
  try {
    return await withTx(prisma, (tx) =>
      idempotent(tx, userId, idemKey ? `link:${idemKey}` : undefined, async () => {
        const city = await lockCity(tx, cityId);
        if (city.ownerId !== userId) throw forbidden('Само кметът може да строи магистрали');
        const other = await tx.city.findUnique({ where: { id: toCityId } });
        if (!other) throw notFound('Градът не съществува');
        const [aId, bId] = pair(cityId, toCityId);
        if (await tx.cityLink.findUnique({ where: { aId_bId: { aId, bId } } })) throw conflict('Двата града вече са свързани');
        const length = Math.max(1, Math.round(cityDistance(city, other)));
        if (length > BALANCE.links.maxLength) throw bad(`Градът е твърде далеч (максимум ${BALANCE.links.maxLength} плочки)`);
        const cost = linkCost(length);
        const tick = await currentTick(tx);
        await tx.cityLink.create({ data: { aId, bId, builtById: userId, length, cost: BigInt(cost), createdTick: tick } });
        await transfer(tx, {
          from: acc.city(cityId),
          to: SYS.WORLD,
          amount: cost,
          kind: 'CONSTRUCTION',
          tick,
          key: `link:${aId}:${bId}`,
          refType: 'City',
          refId: cityId,
          memo: `магистрала до ${other.name}`,
        });
        const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(cityId) } });
        if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', `Недостатъчно средства в бюджета (нужни ${(cost / 100).toFixed(0)} €)`, 402);
        await logEvent(tx, { tick, kind: 'city_link', message: `Магистрала свързва „${city.name}“ и „${other.name}“`, cityId, userId });
        return { aId, bId, length, cost };
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Двата града вече са свързани');
    throw e;
  }
}

/** Всички магистрали (за картата): краищата са центровете на градовете. */
export async function listLinks(prisma: PrismaClient | Tx) {
  const links = await prisma.cityLink.findMany({ orderBy: { createdAt: 'asc' } });
  if (!links.length) return [];
  const ids = [...new Set(links.flatMap((l) => [l.aId, l.bId]))];
  const cities = await prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, originX: true, originY: true, version: true } });
  const byId = new Map(cities.map((c) => [c.id, c]));
  const heavy = new Map<string, Awaited<ReturnType<typeof loadCityHeavy>>>();
  for (const c of cities) heavy.set(c.id, await loadCityHeavy(prisma as PrismaClient, c.id, c.version));
  const end = (c: { id: string; originX: number; originY: number }, toward: { originX: number; originY: number }) =>
    linkEnd(heavy.get(c.id)?.tiles as TileMap | undefined, heavy.get(c.id)?.parcels ?? [], c, toward);
  return links
    .filter((l) => byId.has(l.aId) && byId.has(l.bId))
    .map((l) => {
      const a = byId.get(l.aId)!;
      const b = byId.get(l.bId)!;
      return {
        id: l.id,
        a: { id: a.id, name: a.name, originX: a.originX, originY: a.originY, ...end(a, b) },
        b: { id: b.id, name: b.name, originX: b.originX, originY: b.originY, ...end(b, a) },
        length: l.length,
        cost: Number(l.cost),
      };
    });
}

/**
 * Къде магистралата влиза в града: „вход“ (gate) – точка точно извън територията в посока към другия град
 * (там е пътният възел), и „изход“ (exit) – най-добрият път на града (магистрала/булевард/улица), най-близо
 * до другия град, с който възелът се свързва с рампа. Без пътища – центърът на ръба на територията.
 */
export function linkEnd(
  tiles: TileMap | undefined,
  parcels: { px: number; py: number }[],
  c: { originX: number; originY: number },
  toward: { originX: number; originY: number },
): { gate: { x: number; y: number }; exit: { x: number; y: number }; branch: { x: number; y: number } | null } {
  const S = BALANCE.world.parcelSize;
  const own = new Set(parcels.map((p) => `${p.px},${p.py}`));
  const inside = (x: number, y: number) => own.has(`${Math.floor(x / S)},${Math.floor(y / S)}`);
  const rank: Record<string, number> = { highway: 0, avenue: 1, industrial: 2, street: 3, rural: 4 };
  let exit = { x: c.originX, y: c.originY };
  let best = Infinity;
  for (const [k, t] of Object.entries(tiles ?? {})) {
    if (t.t !== 'road') continue;
    const [x, y] = k.split(',').map(Number);
    const d = Math.hypot(toward.originX - x, toward.originY - y) + (rank[t.c ?? 'street'] ?? 3) * 3;
    if (d < best) {
      best = d;
      exit = { x, y };
    }
  }
  // разклонение: втори път в града (поне на 4 плочки от главния вход), към който магистралата се разделя
  let branch: { x: number; y: number } | null = null;
  let bestB = Infinity;
  for (const [k, t] of Object.entries(tiles ?? {})) {
    if (t.t !== 'road') continue;
    const [x, y] = k.split(',').map(Number);
    if (Math.hypot(x - exit.x, y - exit.y) < 4) continue;
    // встрани от главната посока (иначе не е разклонение, а същият път)
    const mx = toward.originX - exit.x;
    const my = toward.originY - exit.y;
    const ml = Math.hypot(mx, my) || 1;
    if (Math.abs(((x - exit.x) * my - (y - exit.y) * mx) / ml) < 2) continue;
    const d = Math.hypot(toward.originX - x, toward.originY - y) + (rank[t.c ?? 'street'] ?? 3) * 3;
    if (d < bestB) {
      bestB = d;
      branch = { x, y };
    }
  }
  // от изхода към другия град – до първата точка извън територията
  const dx = toward.originX - exit.x;
  const dy = toward.originY - exit.y;
  const L = Math.max(1, Math.hypot(dx, dy));
  let gate = { ...exit };
  if (parcels.length)
    for (let s = 0; s < 200; s++) {
      const x = Math.round(exit.x + (dx / L) * s);
      const y = Math.round(exit.y + (dy / L) * s);
      gate = { x, y };
      if (!inside(x, y)) break;
    }
  // възелът – малко извън границата
  gate = { x: Math.round(gate.x + (dx / L) * 2), y: Math.round(gate.y + (dy / L) * 2) };
  return { gate, exit, branch };
}

/** Множител на превоза между два града (по-евтино при магистрала). */
export async function linkShippingMult(tx: PrismaClient | Tx, fromCityId: string, toCityId: string): Promise<number> {
  if (fromCityId === toCityId) return 1;
  const [aId, bId] = pair(fromCityId, toCityId);
  const l = await tx.cityLink.findUnique({ where: { aId_bId: { aId, bId } } });
  return l ? BALANCE.links.shippingMult : 1;
}
