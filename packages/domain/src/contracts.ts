import { shippingQuote, techEffects } from '@gce/economy-engine';
import type { GoodId } from '@gce/shared';
import { withTx, type Contract, type PrismaClient, type Tx } from '@gce/database';
import { bad, forbidden, notFound } from './errors';
import { acc, tryTransfer, transfer } from './ledger';
import { cityDistance, currentTick } from './world';
import { linkShippingMult } from './links';
import { requirePermission, rolesOf } from './companies';
import { addGoods, tryTakeGoods } from './inventory';
import { notify } from './events';
import { companyTechs } from './research';

/**
 * Директни договори за доставка между компании.
 * Състояния: PROPOSED -> ACTIVE (приет) -> COMPLETED | BREACHED; PROPOSED -> REJECTED | CANCELLED; ACTIVE -> TERMINATED.
 */
export interface ContractInput {
  sellerCompanyId: string;
  buyerCompanyId: string;
  good: GoodId;
  quantityPerDelivery: number;
  pricePerUnit: number;
  intervalDays: number;
  deliveries: number;
  penaltyPerMiss: number;
  fromCityId: string;
  toCityId: string;
}

const MAX_MISSES = 3;

export function serializeContract(c: Contract) {
  return { ...c, pricePerUnit: Number(c.pricePerUnit), penaltyPerMiss: Number(c.penaltyPerMiss) };
}

async function ceoOf(db: PrismaClient | Tx, companyId: string) {
  const r = await db.companyRole.findFirst({ where: { companyId, role: 'CEO' } });
  return r?.userId ?? null;
}

export async function proposeContract(prisma: PrismaClient, userId: string, input: ContractInput) {
  if (input.sellerCompanyId === input.buyerCompanyId) throw bad('Продавачът и купувачът трябва да са различни компании');
  return withTx(prisma, async (tx) => {
    const sellerRoles = await rolesOf(tx, input.sellerCompanyId, userId);
    const side = sellerRoles.length ? 'SELLER' : 'BUYER';
    await requirePermission(tx, side === 'SELLER' ? input.sellerCompanyId : input.buyerCompanyId, userId, 'contract');
    const [from, to, other] = await Promise.all([
      tx.city.findUnique({ where: { id: input.fromCityId } }),
      tx.city.findUnique({ where: { id: input.toCityId } }),
      tx.company.findUnique({ where: { id: side === 'SELLER' ? input.buyerCompanyId : input.sellerCompanyId } }),
    ]);
    if (!from || !to) throw notFound('Градът');
    if (!other || other.status !== 'ACTIVE') throw notFound('Насрещната компания');
    const tick = await currentTick(tx);
    const c = await tx.contract.create({
      data: {
        sellerCompanyId: input.sellerCompanyId,
        buyerCompanyId: input.buyerCompanyId,
        good: input.good,
        quantityPerDelivery: input.quantityPerDelivery,
        intervalDays: input.intervalDays,
        fromCityId: input.fromCityId,
        toCityId: input.toCityId,
        pricePerUnit: BigInt(input.pricePerUnit),
        penaltyPerMiss: BigInt(input.penaltyPerMiss),
        deliveriesTotal: input.deliveries,
        proposedById: userId,
        proposedBySide: side,
        nextDueTick: tick + 1,
      },
    });
    const target = await ceoOf(tx, other.id);
    if (target) await notify(tx, target, 'contract', `Нова оферта за договор: ${input.quantityPerDelivery} × ${input.good} на всеки ${input.intervalDays} дни`);
    return serializeContract(c);
  });
}

export async function respondContract(prisma: PrismaClient, userId: string, contractId: string, action: 'accept' | 'reject' | 'cancel' | 'terminate') {
  return withTx(prisma, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Contract" WHERE id = ${contractId} FOR UPDATE`;
    if (!rows.length) throw notFound('Договорът');
    const c = await tx.contract.findUniqueOrThrow({ where: { id: contractId } });
    const tick = await currentTick(tx);
    const counterparty = c.proposedBySide === 'SELLER' ? c.buyerCompanyId : c.sellerCompanyId;
    const proposer = c.proposedBySide === 'SELLER' ? c.sellerCompanyId : c.buyerCompanyId;
    if (action === 'accept' || action === 'reject') {
      if (c.status !== 'PROPOSED') throw bad('Договорът не очаква отговор');
      await requirePermission(tx, counterparty, userId, 'contract');
      const updated = await tx.contract.update({
        where: { id: contractId },
        data: action === 'accept' ? { status: 'ACTIVE', nextDueTick: tick + 1 } : { status: 'REJECTED' },
      });
      const n = await ceoOf(tx, proposer);
      if (n) await notify(tx, n, 'contract', `Договорът за ${c.good} беше ${action === 'accept' ? 'приет' : 'отхвърлен'}`);
      return serializeContract(updated);
    }
    if (action === 'cancel') {
      if (c.status !== 'PROPOSED') throw bad('Само неприети оферти могат да се оттеглят');
      await requirePermission(tx, proposer, userId, 'contract');
      return serializeContract(await tx.contract.update({ where: { id: contractId }, data: { status: 'CANCELLED' } }));
    }
    // Едностранно прекратяване на активен договор: прекратяващата страна плаща неустойка за всички оставащи доставки (до 3).
    if (c.status !== 'ACTIVE') throw bad('Договорът не е активен');
    const sellerRoles = await rolesOf(tx, c.sellerCompanyId, userId);
    const mine = sellerRoles.length ? c.sellerCompanyId : c.buyerCompanyId;
    await requirePermission(tx, mine, userId, 'contract');
    const other = mine === c.sellerCompanyId ? c.buyerCompanyId : c.sellerCompanyId;
    const remaining = Math.min(3, c.deliveriesTotal - c.deliveriesDone);
    const fee = Number(c.penaltyPerMiss) * remaining;
    if (fee > 0)
      await transfer(tx, { from: acc.company(mine), to: acc.company(other), amount: fee, kind: 'CONTRACT_TERMINATION', tick, key: `contract-term:${c.id}` });
    return serializeContract(await tx.contract.update({ where: { id: contractId }, data: { status: 'TERMINATED' } }));
  });
}

/** Изпълнение на падежиралите доставки (worker). При неизпълнение – неустойка; след 3 пропуска – нарушен договор. */
export async function processContracts(prisma: PrismaClient, tick: number) {
  const due = await prisma.contract.findMany({ where: { status: 'ACTIVE', nextDueTick: { lte: tick } }, take: 2000 });
  let delivered = 0;
  let missed = 0;
  for (const d of due) {
    await withTx(prisma, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Contract" WHERE id = ${d.id} AND status = 'ACTIVE' AND "nextDueTick" <= ${tick} FOR UPDATE`;
      if (!rows.length) return;
      const c = await tx.contract.findUniqueOrThrow({ where: { id: d.id } });
      const total = c.quantityPerDelivery * Number(c.pricePerUnit);
      const good = c.good as GoodId;
      const [seller, buyer] = await Promise.all([
        tx.company.findUnique({ where: { id: c.sellerCompanyId } }),
        tx.company.findUnique({ where: { id: c.buyerCompanyId } }),
      ]);
      const next = { nextDueTick: c.nextDueTick + c.intervalDays };
      if (!seller || !buyer || seller.status !== 'ACTIVE' || buyer.status !== 'ACTIVE') {
        await tx.contract.update({ where: { id: c.id }, data: { status: 'TERMINATED' } });
        return;
      }
      const buyerBal = await tx.account.findUniqueOrThrow({ where: { id: acc.company(c.buyerCompanyId) } });
      const buyerCanPay = Number(buyerBal.balance) >= total;
      const sellerHas = buyerCanPay && (await tryTakeGoods(tx, c.sellerCompanyId, c.fromCityId, good, c.quantityPerDelivery));
      const key = `contract:${c.id}:${c.nextDueTick}`;
      if (buyerCanPay && sellerHas) {
        await transfer(tx, {
          from: acc.company(c.buyerCompanyId),
          to: acc.company(c.sellerCompanyId),
          amount: total,
          kind: 'CONTRACT_PAYMENT',
          tick,
          key,
          refType: 'Contract',
          refId: c.id,
        });
        const [from, to] = await Promise.all([
          tx.city.findUniqueOrThrow({ where: { id: c.fromCityId } }),
          tx.city.findUniqueOrThrow({ where: { id: c.toCityId } }),
        ]);
        const fx = techEffects(null, await companyTechs(tx, c.sellerCompanyId, tick));
        const q = shippingQuote(cityDistance(from, to), c.quantityPerDelivery, fx.shippingMult * (await linkShippingMult(tx, c.fromCityId, c.toCityId)));
        if (q.cost > 0)
          await tryTransfer(
            tx,
            { from: acc.company(c.sellerCompanyId), to: 'system:world', amount: q.cost, kind: 'SHIPPING', tick, key: `${key}:ship` },
            { partial: true },
          );
        if (q.days === 0) await addGoods(tx, c.buyerCompanyId, c.toCityId, good, c.quantityPerDelivery, Number(c.pricePerUnit));
        else
          await tx.shipment.create({
            data: {
              companyId: c.buyerCompanyId,
              good,
              quantity: c.quantityPerDelivery,
              fromCityId: c.fromCityId,
              toCityId: c.toCityId,
              departTick: tick,
              arriveTick: tick + q.days,
              cost: BigInt(q.cost),
              refType: 'Contract',
              refId: c.id,
            },
          });
        const done = c.deliveriesDone + 1;
        await tx.contract.update({ where: { id: c.id }, data: { ...next, deliveriesDone: done, status: done >= c.deliveriesTotal ? 'COMPLETED' : 'ACTIVE' } });
        delivered++;
        return;
      }
      // Неизпълнение: виновната страна плаща неустойка (доколкото може).
      missed++;
      const guilty = buyerCanPay ? c.sellerCompanyId : c.buyerCompanyId;
      const victim = guilty === c.sellerCompanyId ? c.buyerCompanyId : c.sellerCompanyId;
      await tryTransfer(
        tx,
        {
          from: acc.company(guilty),
          to: acc.company(victim),
          amount: c.penaltyPerMiss,
          kind: 'CONTRACT_PENALTY',
          tick,
          key: `${key}:penalty`,
          refType: 'Contract',
          refId: c.id,
        },
        { partial: true },
      );
      const misses = c.misses + 1;
      await tx.contract.update({ where: { id: c.id }, data: { ...next, misses, status: misses >= MAX_MISSES ? 'BREACHED' : 'ACTIVE' } });
      for (const id of [c.sellerCompanyId, c.buyerCompanyId]) {
        const u = await ceoOf(tx, id);
        if (u)
          await notify(
            tx,
            u,
            'contract',
            `Неизпълнена доставка по договор за ${good} (${guilty === c.sellerCompanyId ? 'липса на стока' : 'липса на средства'})${misses >= MAX_MISSES ? ' – договорът е нарушен' : ''}`,
          );
      }
    });
  }
  return { delivered, missed };
}

export async function listContracts(prisma: PrismaClient, userId: string) {
  const roles = await prisma.companyRole.findMany({ where: { userId } });
  const ids = roles.map((r) => r.companyId);
  const list = await prisma.contract.findMany({
    where: { OR: [{ sellerCompanyId: { in: ids } }, { buyerCompanyId: { in: ids } }] },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const companies = await prisma.company.findMany({
    where: { id: { in: [...new Set(list.flatMap((c) => [c.sellerCompanyId, c.buyerCompanyId]))] } },
    select: { id: true, name: true },
  });
  const n = new Map(companies.map((c) => [c.id, c.name]));
  return list.map((c) => ({
    ...serializeContract(c),
    sellerName: n.get(c.sellerCompanyId),
    buyerName: n.get(c.buyerCompanyId),
    mySide: ids.includes(c.sellerCompanyId) ? 'SELLER' : 'BUYER',
  }));
}

export { forbidden };
