/**
 * „Започни отначало“: играчът изоставя всичко и получава нов старт.
 *  - компаниите, на които е CEO, се закриват: отворените поръчки се отменят (ескроу се връща), съоръженията,
 *    наличностите и доставките изчезват, договорите се прекратяват, кредитите се отписват, парите отиват в системата;
 *  - градовете му се изтриват заедно с всичко, свързано с тях: парцели и сигнали (каскадно), статистика, магистрали,
 *    изследвания, събития; бюджетът се нулира;
 *  - известията и събитията на играча се изтриват – нищо от старата игра не остава;
 *  - личните му поръчки се отменят, кредитите се отписват, портфейлът се връща на стартовия капитал.
 * Всички парични движения минават през регистъра – сумата на балансите остава 0.
 */
import { BALANCE, type TileMap } from '@gce/shared';
import { Prisma, withTx, type PrismaClient, type Tx } from '@gce/database';
import { bad } from './errors';
import { SYS, acc, transfer } from './ledger';
import { currentTick } from './world';
import { releaseOrder } from './market';
import { logEvent } from './events';

/** Нулира сметка към системата (WORLD), в която и да е посока. */
async function zeroAccount(tx: Tx, accountId: string, tick: number, key: string) {
  const a = await tx.account.findUnique({ where: { id: accountId } });
  if (!a || a.balance === 0n) return;
  const amount = Number(a.balance > 0n ? a.balance : -a.balance);
  await transfer(tx, {
    from: a.balance > 0n ? accountId : SYS.WORLD,
    to: a.balance > 0n ? SYS.WORLD : accountId,
    amount,
    kind: 'PLAYER_RESET',
    tick,
    key,
  });
}

export async function resetPlayer(prisma: PrismaClient, userId: string) {
  return withTx(prisma, async (tx) => {
    const tick = await currentTick(tx);
    const cities = await tx.city.findMany({ where: { ownerId: userId }, select: { id: true, name: true } });
    const cityIds = cities.map((c) => c.id);
    const companies = (await tx.companyRole.findMany({ where: { userId, role: 'CEO' }, select: { companyId: true } })).map((r) => r.companyId);
    const active = await tx.company.findMany({ where: { id: { in: companies }, status: 'ACTIVE' }, select: { id: true } });
    const companyIds = active.map((c) => c.id);
    // чужди предприятия в градовете на играча – не ги унищожаваме без съгласие на собственика им
    const foreign = await tx.facility.count({ where: { cityId: { in: cityIds }, companyId: { notIn: companyIds.length ? companyIds : ['-'] } } });
    if (foreign > 0) throw bad('В градовете ви има предприятия на други играчи – отначало не може да се започне, докато те са там');

    // 1. отворени поръчки (лични и на компаниите)
    const orders = await tx.marketOrder.findMany({
      where: {
        status: 'OPEN',
        OR: [{ traderType: 'USER', traderId: userId }, ...(companyIds.length ? [{ traderType: 'COMPANY' as const, traderId: { in: companyIds } }] : [])],
      },
    });
    for (const o of orders) await releaseOrder(tx, o, tick);

    // 2. компаниите
    for (const id of companyIds) {
      const facilities = await tx.facility.findMany({ where: { companyId: id }, select: { cityId: true, x: true, y: true } });
      // премахване на плочките на предприятията от чужди градове
      const byCity = new Map<string, string[]>();
      for (const f of facilities) if (!cityIds.includes(f.cityId)) byCity.set(f.cityId, [...(byCity.get(f.cityId) ?? []), `${f.x},${f.y}`]);
      for (const [cid, keys] of byCity) {
        const c = await tx.city.findUnique({ where: { id: cid }, select: { tiles: true } });
        if (!c) continue;
        const tiles = { ...(c.tiles as unknown as TileMap) };
        for (const k of keys) delete tiles[k];
        await tx.city.update({ where: { id: cid }, data: { tiles: tiles as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
      }
      await tx.facility.deleteMany({ where: { companyId: id } });
      await tx.inventory.deleteMany({ where: { companyId: id } });
      await tx.shipment.deleteMany({ where: { companyId: id } });
      await tx.contract.updateMany({ where: { OR: [{ sellerCompanyId: id }, { buyerCompanyId: id }], status: 'ACTIVE' }, data: { status: 'TERMINATED' } });
      await tx.researchProject.updateMany({ where: { companyId: id, status: 'ACTIVE' }, data: { status: 'CANCELLED' } });
      await tx.patent.updateMany({ where: { ownerCompanyId: id }, data: { ownerCompanyId: null } });
      await tx.license.updateMany({ where: { companyId: id }, data: { status: 'REVOKED' } });
      await tx.loan.updateMany({ where: { borrowerType: 'COMPANY', borrowerId: id, status: 'ACTIVE' }, data: { status: 'WRITTEN_OFF', outstanding: 0n } });
      await zeroAccount(tx, acc.company(id), tick, `reset:company:${id}`);
      await tx.shareholding.deleteMany({ where: { companyId: id } });
      await tx.companyRole.deleteMany({ where: { companyId: id } });
      await tx.company.update({ where: { id }, data: { status: 'DISSOLVED' } });
    }

    // 3. градовете
    for (const c of cities) {
      await tx.loan.updateMany({ where: { borrowerType: 'CITY', borrowerId: c.id, status: 'ACTIVE' }, data: { status: 'WRITTEN_OFF', outstanding: 0n } });
      await zeroAccount(tx, acc.city(c.id), tick, `reset:city:${c.id}`);
    }
    if (cityIds.length) {
      // таблици без външен ключ към City – изчистват се изрично, за да не остане нищо от стария град
      await tx.researchProject.deleteMany({ where: { cityId: { in: cityIds } } });
      await tx.cityStat.deleteMany({ where: { cityId: { in: cityIds } } });
      await tx.cityLink.deleteMany({ where: { OR: [{ aId: { in: cityIds } }, { bId: { in: cityIds } }] } });
      await tx.worldEvent.deleteMany({ where: { cityId: { in: cityIds } } });
      // парцелите и сигналите (CityIssue) се трият каскадно с града
      await tx.city.deleteMany({ where: { id: { in: cityIds } } });
    }
    // известията (сигнали, кредити, търговия...) и събитията на играча от старата игра
    await tx.notification.deleteMany({ where: { userId } });
    await tx.worldEvent.deleteMany({ where: { userId } });

    // 4. личните кредити и портфейлът – отново стартовият капитал
    await tx.loan.updateMany({ where: { borrowerType: 'USER', borrowerId: userId, status: 'ACTIVE' }, data: { status: 'WRITTEN_OFF', outstanding: 0n } });
    const wallet = await tx.account.findUnique({ where: { id: acc.user(userId) } });
    const diff = BALANCE.start.wallet - Number(wallet?.balance ?? 0n);
    if (diff !== 0)
      await transfer(tx, {
        from: diff > 0 ? SYS.MINT : acc.user(userId),
        to: diff > 0 ? acc.user(userId) : SYS.WORLD,
        amount: Math.abs(diff),
        kind: diff > 0 ? 'START_CAPITAL' : 'PLAYER_RESET',
        tick,
        key: `reset:wallet:${userId}:${Date.now()}`,
      });
    await logEvent(tx, { tick, kind: 'player_reset', message: 'Играч започна отначало', userId });
    return { cities: cities.length, companies: companyIds.length, wallet: BALANCE.start.wallet };
  });
}
