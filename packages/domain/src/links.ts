/**
 * Магистрали между градовете. Кметът плаща от бюджета на града си; магистралата важи и в двете посоки:
 * превозът на стоки между двата града е по-евтин и по-бърз (множител BALANCE.links.shippingMult).
 */
import { BALANCE } from '@gce/shared';
import { isUniqueViolation, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, transfer } from './ledger';
import { idempotent } from './idempotency';
import { cityDistance, currentTick } from './world';
import { lockCity } from './cities';
import { logEvent } from './events';

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
  const cities = await prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, originX: true, originY: true } });
  const byId = new Map(cities.map((c) => [c.id, c]));
  return links
    .filter((l) => byId.has(l.aId) && byId.has(l.bId))
    .map((l) => ({ id: l.id, a: byId.get(l.aId)!, b: byId.get(l.bId)!, length: l.length, cost: Number(l.cost) }));
}

/** Множител на превоза между два града (по-евтино при магистрала). */
export async function linkShippingMult(tx: PrismaClient | Tx, fromCityId: string, toCityId: string): Promise<number> {
  if (fromCityId === toCityId) return 1;
  const [aId, bId] = pair(fromCityId, toCityId);
  const l = await tx.cityLink.findUnique({ where: { aId_bId: { aId, bId } } });
  return l ? BALANCE.links.shippingMult : 1;
}
