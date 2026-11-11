import { PROPOSAL_THRESHOLD, PROPOSAL_TTL_DAYS, type ProposalKind } from '@gce/shared';
import { Prisma, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, forbidden, notFound } from './errors';
import { acc, transfer } from './ledger';
import { currentTick } from './world';
import { rolesOf, sellFacility } from './companies';
import { logEvent, notify } from './events';
import { releaseOrder } from './market';

type Payload = Record<string, unknown>;
const int = (v: unknown, name: string, min = 1) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw bad(`Невалидна стойност за ${name}`);
  return n;
};
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v || v.length > 64) throw bad(`Невалидна стойност за ${name}`);
  return v;
};

/** Гласова тежест в компания: лични акции + акциите на компании, на които гласуващият е CEO. */
async function companyWeight(db: Tx | PrismaClient, companyId: string, userId: string): Promise<number> {
  const personal = await db.shareholding.findUnique({ where: { companyId_holderType_holderId: { companyId, holderType: 'USER', holderId: userId } } });
  const ceoOf = await db.companyRole.findMany({ where: { userId, role: 'CEO' } });
  let w = personal?.shares ?? 0;
  if (ceoOf.length) {
    const corp = await db.shareholding.findMany({ where: { companyId, holderType: 'COMPANY', holderId: { in: ceoOf.map((r) => r.companyId) } } });
    w += corp.reduce((a, h) => a + h.shares, 0);
  }
  return w;
}

async function totalWeight(db: Tx | PrismaClient, scopeType: string, scopeId: string): Promise<number> {
  if (scopeType === 'COMPANY') return (await db.company.findUniqueOrThrow({ where: { id: scopeId } })).totalShares;
  return db.allianceMember.count({ where: { allianceId: scopeId } });
}

async function voterWeight(db: Tx | PrismaClient, scopeType: string, scopeId: string, userId: string): Promise<number> {
  if (scopeType === 'COMPANY') return companyWeight(db, scopeId, userId);
  const m = await db.allianceMember.findUnique({ where: { userId } });
  return m && m.allianceId === scopeId ? 1 : 0;
}

function validatePayload(scopeType: string, kind: ProposalKind, p: Payload, proposerId: string): Payload {
  const companyKinds: ProposalKind[] = ['ISSUE_SHARES', 'PAY_DIVIDEND', 'APPOINT_ROLE', 'REMOVE_ROLE', 'MERGE_INTO', 'SELL_FACILITY'];
  if ((scopeType === 'COMPANY') !== companyKinds.includes(kind)) throw bad('Видът предложение не съответства на обхвата');
  switch (kind) {
    case 'ISSUE_SHARES':
      // Записването на нови акции се плаща от предлагащия – никой не може да бъде задължен да плати.
      return { shares: int(p.shares, 'shares'), pricePerShare: int(p.pricePerShare, 'pricePerShare'), subscriberId: proposerId };
    case 'PAY_DIVIDEND':
      return { amountPerShare: int(p.amountPerShare, 'amountPerShare') };
    case 'APPOINT_ROLE':
    case 'REMOVE_ROLE': {
      const role = str(p.role, 'role');
      if (!['CEO', 'MANAGER', 'BOARD'].includes(role)) throw bad('Невалидна роля');
      return { userId: str(p.userId, 'userId'), role };
    }
    case 'MERGE_INTO':
      return { targetCompanyId: str(p.targetCompanyId, 'targetCompanyId'), ratio: Math.max(0.01, Math.min(100, Number(p.ratio) || 1)) };
    case 'SELL_FACILITY':
      return { facilityId: str(p.facilityId, 'facilityId') };
    case 'ALLIANCE_KICK':
      return { userId: str(p.userId, 'userId') };
    case 'ALLIANCE_SANCTION':
      return { targetUserId: str(p.targetUserId, 'targetUserId'), on: p.on !== false };
  }
}

export async function createProposal(
  prisma: PrismaClient,
  userId: string,
  input: { scopeType: 'COMPANY' | 'ALLIANCE'; scopeId: string; kind: ProposalKind; payload: Payload },
) {
  const id = await withTx(prisma, async (tx) => {
    const weight = await voterWeight(tx, input.scopeType, input.scopeId, userId);
    if (input.scopeType === 'COMPANY') {
      const c = await tx.company.findUnique({ where: { id: input.scopeId } });
      if (!c || c.status !== 'ACTIVE') throw notFound('Компанията');
      const roles = await rolesOf(tx, input.scopeId, userId);
      if (weight === 0 && !roles.includes('BOARD') && !roles.includes('CEO')) throw forbidden('Предложения внасят акционери и членове на борда');
    } else if (weight === 0) throw forbidden('Само членове на съюза могат да внасят предложения');
    const payload = validatePayload(input.scopeType, input.kind, input.payload, userId);
    const tick = await currentTick(tx);
    const p = await tx.proposal.create({
      data: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        kind: input.kind,
        payload: payload as Prisma.InputJsonValue,
        proposerId: userId,
        expiresTick: tick + PROPOSAL_TTL_DAYS,
      },
    });
    if (weight > 0) await tx.vote.create({ data: { proposalId: p.id, voterId: userId, approve: true, weight } });
    return p.id;
  });
  return tallyAndExecute(prisma, id);
}

export async function castVote(prisma: PrismaClient, userId: string, proposalId: string, approve: boolean) {
  await withTx(prisma, async (tx) => {
    const p = await tx.proposal.findUnique({ where: { id: proposalId } });
    if (!p) throw notFound('Предложението');
    if (p.status !== 'OPEN') throw bad('Гласуването е приключило');
    const weight = await voterWeight(tx, p.scopeType, p.scopeId, userId);
    if (weight <= 0) throw forbidden('Нямате право на глас');
    await tx.vote.upsert({
      where: { proposalId_voterId: { proposalId, voterId: userId } },
      create: { proposalId, voterId: userId, approve, weight },
      update: { approve, weight },
    });
  });
  return tallyAndExecute(prisma, proposalId);
}

async function tallyAndExecute(prisma: PrismaClient, proposalId: string) {
  const decided = await withTx(prisma, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Proposal" WHERE id = ${proposalId} FOR UPDATE`;
    const p = await tx.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { votes: true } });
    if (p.status !== 'OPEN') return null;
    const total = await totalWeight(tx, p.scopeType, p.scopeId);
    // Тежестите се преизчисляват към момента на преброяване (акциите може да са сменили собственика).
    let yes = 0;
    let no = 0;
    for (const v of p.votes) {
      const w = await voterWeight(tx, p.scopeType, p.scopeId, v.voterId);
      if (v.approve) yes += w;
      else no += w;
    }
    if (yes > total * PROPOSAL_THRESHOLD) {
      await tx.proposal.update({ where: { id: p.id }, data: { status: 'PASSED' } });
      return 'PASSED';
    }
    if (no >= total * (1 - PROPOSAL_THRESHOLD)) {
      await tx.proposal.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
      return 'REJECTED';
    }
    return null;
  });
  if (decided === 'PASSED') {
    try {
      const result = await withTx(prisma, (tx) => executeProposal(tx, proposalId));
      await prisma.proposal.update({ where: { id: proposalId }, data: { status: 'EXECUTED', result } });
    } catch (e) {
      const msg = e instanceof DomainError ? e.message : 'Грешка при изпълнение';
      await prisma.proposal.update({ where: { id: proposalId }, data: { status: 'FAILED', result: msg } });
    }
  }
  return prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { votes: true } });
}

async function executeProposal(tx: Tx, proposalId: string): Promise<string> {
  const p = await tx.proposal.findUniqueOrThrow({ where: { id: proposalId } });
  const d = p.payload as Payload;
  const tick = await currentTick(tx);
  const companyId = p.scopeId;
  switch (p.kind as ProposalKind) {
    case 'ISSUE_SHARES': {
      const shares = Number(d.shares);
      const amount = shares * Number(d.pricePerShare);
      const sub = String(d.subscriberId);
      await transfer(tx, {
        from: acc.user(sub),
        to: acc.company(companyId),
        amount,
        kind: 'SHARE_ISSUE',
        tick,
        key: `issue:${p.id}`,
        refType: 'Proposal',
        refId: p.id,
      });
      await tx.$executeRaw`INSERT INTO "Shareholding" ("companyId","holderType","holderId","shares","reserved") VALUES (${companyId}, 'USER'::"OwnerType", ${sub}, ${shares}, 0)
        ON CONFLICT ("companyId","holderType","holderId") DO UPDATE SET "shares" = "Shareholding"."shares" + ${shares}`;
      await tx.company.update({ where: { id: companyId }, data: { totalShares: { increment: shares } } });
      return `Издадени ${shares} нови акции срещу ${(amount / 100).toFixed(2)} €`;
    }
    case 'PAY_DIVIDEND': {
      const c = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const per = Number(d.amountPerShare);
      const holders = await tx.shareholding.findMany({ where: { companyId, shares: { gt: 0 } } });
      let total = 0;
      for (const h of holders) {
        const amt = h.shares * per;
        await transfer(tx, {
          from: acc.company(companyId),
          to: acc.of(h.holderType as 'USER' | 'COMPANY', h.holderId),
          amount: amt,
          kind: 'DIVIDEND',
          tick,
          key: `dividend:${p.id}:${h.holderType}:${h.holderId}`,
          refType: 'Proposal',
          refId: p.id,
        });
        total += amt;
        if (h.holderType === 'USER') await notify(tx, h.holderId, 'dividend', `Получен дивидент от „${c.name}“: ${(amt / 100).toFixed(2)} €`);
      }
      return `Изплатени дивиденти: ${(total / 100).toFixed(2)} €`;
    }
    case 'APPOINT_ROLE': {
      const user = await tx.user.findUnique({ where: { id: String(d.userId) } });
      if (!user) throw notFound('Потребителят');
      if (d.role === 'CEO') await tx.companyRole.deleteMany({ where: { companyId, role: 'CEO' } });
      await tx.companyRole.upsert({
        where: { companyId_userId_role: { companyId, userId: user.id, role: String(d.role) } },
        create: { companyId, userId: user.id, role: String(d.role) },
        update: {},
      });
      await notify(tx, user.id, 'governance', `Назначен(а) сте за ${d.role}`);
      return `${user.username} е назначен(а) за ${d.role}`;
    }
    case 'REMOVE_ROLE':
      await tx.companyRole.deleteMany({ where: { companyId, userId: String(d.userId), role: String(d.role) } });
      return `Ролята ${d.role} е отнета`;
    case 'SELL_FACILITY': {
      const f = await tx.facility.findUnique({ where: { id: String(d.facilityId) } });
      if (!f || f.companyId !== companyId) throw notFound('Съоръжението');
      const proceeds = await sellFacility(tx, f.id, tick);
      return `Съоръжението е продадено за ${(proceeds / 100).toFixed(2)} €`;
    }
    case 'MERGE_INTO':
      return mergeInto(tx, companyId, String(d.targetCompanyId), Number(d.ratio), p.proposerId, tick);
    case 'ALLIANCE_KICK':
      await tx.allianceMember.deleteMany({ where: { allianceId: p.scopeId, userId: String(d.userId), role: { not: 'LEADER' } } });
      return 'Членът е изключен';
    case 'ALLIANCE_SANCTION':
      if (d.on)
        await tx.allianceSanction.upsert({
          where: { allianceId_targetUserId: { allianceId: p.scopeId, targetUserId: String(d.targetUserId) } },
          create: { allianceId: p.scopeId, targetUserId: String(d.targetUserId) },
          update: {},
        });
      else await tx.allianceSanction.deleteMany({ where: { allianceId: p.scopeId, targetUserId: String(d.targetUserId) } });
      return d.on ? 'Наложени са санкции' : 'Санкциите са отменени';
  }
}

/**
 * Сливане: компанията (scope) се влива в целевата. Изисква съгласие на ръководството на целевата (CEO = вносителят).
 * Активите (пари, стоки, съоръжения, кредити, патенти) преминават към целевата; акционерите получават акции по съотношение.
 */
async function mergeInto(tx: Tx, sourceId: string, targetId: string, ratio: number, proposerId: string, tick: number): Promise<string> {
  if (sourceId === targetId) throw bad('Невалидна цел');
  const target = await tx.company.findUnique({ where: { id: targetId } });
  if (!target || target.status !== 'ACTIVE') throw notFound('Целевата компания');
  const targetRoles = await rolesOf(tx, targetId, proposerId);
  if (!targetRoles.includes('CEO')) throw forbidden('Вносителят трябва да е CEO на приемащата компания');
  const source = await tx.company.findUniqueOrThrow({ where: { id: sourceId } });
  const openOrders = await tx.marketOrder.findMany({ where: { traderType: 'COMPANY', traderId: sourceId, status: 'OPEN' } });
  for (const o of openOrders) await releaseOrder(tx, o, tick);
  const cash = await tx.account.findUniqueOrThrow({ where: { id: acc.company(sourceId) } });
  await transfer(tx, {
    from: acc.company(sourceId),
    to: acc.company(targetId),
    amount: cash.balance,
    kind: 'MERGER_TRANSFER',
    tick,
    key: `merge:${sourceId}:cash`,
  });
  const inv = await tx.inventory.findMany({ where: { companyId: sourceId } });
  for (const i of inv) {
    await tx.$executeRaw`INSERT INTO "Inventory" ("companyId","cityId","good","quantity","reserved","avgCost") VALUES (${targetId}, ${i.cityId}, ${i.good}, ${i.quantity + i.reserved}, 0, ${i.avgCost})
      ON CONFLICT ("companyId","cityId","good") DO UPDATE SET "quantity" = "Inventory"."quantity" + EXCLUDED."quantity"`;
  }
  await tx.inventory.deleteMany({ where: { companyId: sourceId } });
  const facilities = await tx.facility.findMany({ where: { companyId: sourceId } });
  for (const f of facilities) {
    await tx.facility.update({ where: { id: f.id }, data: { companyId: targetId } });
    const city = await tx.city.findUniqueOrThrow({ where: { id: f.cityId } });
    const tiles = city.tiles as Record<string, { t: string; companyId?: string }>;
    const k = `${f.x},${f.y}`;
    if (tiles[k]?.t === 'facility') tiles[k] = { ...tiles[k], companyId: targetId };
    await tx.city.update({ where: { id: city.id }, data: { tiles: tiles as Prisma.InputJsonValue, version: { increment: 1 } } });
  }
  await tx.loan.updateMany({ where: { borrowerType: 'COMPANY', borrowerId: sourceId }, data: { borrowerId: targetId } });
  await tx.patent.updateMany({ where: { ownerCompanyId: sourceId }, data: { ownerCompanyId: targetId } });
  await tx.shipment.updateMany({ where: { companyId: sourceId, status: 'IN_TRANSIT' }, data: { companyId: targetId } });
  await tx.contract.updateMany({ where: { sellerCompanyId: sourceId, status: { in: ['PROPOSED', 'ACTIVE'] } }, data: { sellerCompanyId: targetId } });
  await tx.contract.updateMany({ where: { buyerCompanyId: sourceId, status: { in: ['PROPOSED', 'ACTIVE'] } }, data: { buyerCompanyId: targetId } });
  // Акционерите на вливащата се компания (без целевата) получават нови акции на целевата.
  const holders = await tx.shareholding.findMany({ where: { companyId: sourceId, shares: { gt: 0 } } });
  let issued = 0;
  for (const h of holders) {
    if (h.holderType === 'COMPANY' && h.holderId === targetId) continue;
    const newShares = Math.floor(h.shares * ratio);
    if (newShares <= 0) continue;
    issued += newShares;
    await tx.$executeRaw`INSERT INTO "Shareholding" ("companyId","holderType","holderId","shares","reserved") VALUES (${targetId}, ${h.holderType}::"OwnerType", ${h.holderId}, ${newShares}, 0)
      ON CONFLICT ("companyId","holderType","holderId") DO UPDATE SET "shares" = "Shareholding"."shares" + ${newShares}`;
  }
  await tx.shareholding.deleteMany({ where: { companyId: sourceId } });
  await tx.company.update({ where: { id: targetId }, data: { totalShares: { increment: issued } } });
  await tx.company.update({ where: { id: sourceId }, data: { status: 'MERGED', parentCompanyId: targetId } });
  await logEvent(tx, { tick, kind: 'merger', message: `„${source.name}“ се вля в „${target.name}“` });
  return `Сливането е завършено, издадени ${issued} акции на „${target.name}“`;
}

export async function expireProposals(prisma: PrismaClient, tick: number) {
  const r = await prisma.proposal.updateMany({ where: { status: 'OPEN', expiresTick: { lt: tick } }, data: { status: 'EXPIRED' } });
  return r.count;
}

export async function listProposals(prisma: PrismaClient, scopeType: string, scopeId: string) {
  return prisma.proposal.findMany({ where: { scopeType, scopeId }, include: { votes: true }, orderBy: { createdAt: 'desc' }, take: 50 });
}
