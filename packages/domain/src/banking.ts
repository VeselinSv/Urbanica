import { BALANCE, type GoodId } from '@gce/shared';
import { annuityPayment, creditScore, loanRate, maxBorrowing, periodInterest, type Rating } from '@gce/economy-engine';
import { withTx, type Loan, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, forbidden, notFound } from './errors';
import { SYS, acc, transfer, tryTransfer } from './ledger';
import { idempotent } from './idempotency';
import { currentTick, refPrices, worldRow } from './world';
import { companyValuation, requirePermission, sellFacility } from './companies';
import { logEvent, notify } from './events';
import { releaseOrder } from './market';

type BorrowerType = 'COMPANY' | 'CITY';
const ACTIVE = ['ACTIVE', 'RESTRUCTURED', 'DEFAULTED'];

export async function borrowerProfile(db: Tx | PrismaClient, type: BorrowerType, id: string) {
  const loans = await db.loan.findMany({ where: { borrowerType: type, borrowerId: id, status: { in: ACTIVE } } });
  const debt = loans.reduce((a, l) => a + Number(l.outstanding), 0);
  const dailyDebtService = loans.reduce((a, l) => a + Number(l.payment) / BALANCE.banking.paymentIntervalDays, 0);
  const missed = loans.reduce((a, l) => a + l.missed, 0);
  const defaulted = loans.some((l) => l.status === 'DEFAULTED');
  if (type === 'COMPANY') {
    const v = await companyValuation(db, id);
    const stats = await db.companyStat.findMany({ where: { companyId: id }, orderBy: { tick: 'desc' }, take: 30 });
    const cf = stats.length ? stats.reduce((a, s) => a + ((s.data as Record<string, number>).profit ?? 0), 0) / stats.length : 0;
    const company = await db.company.findUnique({ where: { id } });
    const score = creditScore({
      assets: v.assets,
      debt,
      cash: v.cash,
      dailyCashFlow: cf,
      dailyDebtService,
      missedPayments: missed + (company?.missedPayments ?? 0) * 0.5,
      defaulted: defaulted || company?.status === 'BANKRUPT',
    });
    return { ...score, assets: v.assets, debt, cash: v.cash, dailyCashFlow: Math.round(cf), loans };
  }
  const city = await db.city.findUnique({ where: { id } });
  if (!city) throw notFound('Градът');
  const accRow = await db.account.findUnique({ where: { id: acc.city(id) } });
  const cash = Number(accRow?.balance ?? 0n);
  const stats = city.stats as Record<string, number>;
  const assets = Math.max(0, cash) + (stats.population ?? 0) * BALANCE.banking.cityBorrowingAssetsPerResident + 5_000_000;
  const score = creditScore({
    assets,
    debt,
    cash,
    dailyCashFlow: stats.net ?? 0,
    dailyDebtService,
    missedPayments: missed,
    defaulted: defaulted && city.receivership,
  });
  return { ...score, assets, debt, cash, dailyCashFlow: stats.net ?? 0, loans };
}

export async function loanOffer(prisma: PrismaClient, type: BorrowerType, id: string) {
  const w = await worldRow(prisma);
  const p = await borrowerProfile(prisma, type, id);
  return {
    rating: p.rating,
    score: p.score,
    annualRate: loanRate(w.baseRate, p.rating),
    maxAmount: maxBorrowing(p.assets, p.debt, p.rating),
    baseRate: w.baseRate,
    assets: p.assets,
    debt: p.debt,
  };
}

async function requireBorrowerRights(tx: Tx, userId: string, type: BorrowerType, id: string) {
  if (type === 'COMPANY') await requirePermission(tx, id, userId, 'borrow');
  else {
    const city = await tx.city.findUnique({ where: { id } });
    if (!city) throw notFound('Градът');
    if (city.ownerId !== userId) throw forbidden();
  }
}

export async function takeLoan(
  prisma: PrismaClient,
  userId: string,
  input: { borrowerType: BorrowerType; borrowerId: string; amount: number; termDays: number },
  idemKey?: string,
) {
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `loan:${idemKey}` : undefined, async () => {
      await requireBorrowerRights(tx, userId, input.borrowerType, input.borrowerId);
      // Сериализиране на заявките на един кредитополучател (предотвратява превишаване на лимита с паралелни заявки).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'loan:' + input.borrowerId}))`;
      const w = await worldRow(tx);
      const p = await borrowerProfile(tx, input.borrowerType, input.borrowerId);
      if (p.rating === 'D' || p.loans.some((l) => l.status === 'DEFAULTED'))
        throw new DomainError('CREDIT_DENIED', 'Кредитът е отказан: има просрочен/неизплатен дълг', 403);
      const max = maxBorrowing(p.assets, p.debt, p.rating as Rating);
      if (input.amount > max) throw new DomainError('CREDIT_LIMIT', `Максималната сума при рейтинг ${p.rating} е ${(max / 100).toFixed(0)} €`, 403);
      const rate = loanRate(w.baseRate, p.rating as Rating);
      const interval = BALANCE.banking.paymentIntervalDays;
      const loan = await tx.loan.create({
        data: {
          lenderAccountId: SYS.BANK,
          borrowerType: input.borrowerType,
          borrowerId: input.borrowerId,
          principal: BigInt(input.amount),
          outstanding: BigInt(input.amount),
          annualRate: rate,
          termDays: input.termDays,
          payment: BigInt(annuityPayment(input.amount, rate, input.termDays, interval)),
          nextDueTick: w.tick + interval,
          createdTick: w.tick,
        },
      });
      await transfer(tx, {
        from: SYS.BANK,
        to: acc.of(input.borrowerType, input.borrowerId),
        amount: input.amount,
        kind: 'LOAN_DISBURSEMENT',
        tick: w.tick,
        key: `loan-out:${loan.id}`,
        refType: 'Loan',
        refId: loan.id,
      });
      await tx.world.update({ where: { id: 1 }, data: { creditOutstanding: { increment: BigInt(input.amount) } } });
      return serializeLoan(loan);
    }),
  );
}

export function serializeLoan(l: Loan) {
  return { ...l, principal: Number(l.principal), outstanding: Number(l.outstanding), payment: Number(l.payment) };
}

export async function repayLoan(prisma: PrismaClient, userId: string, loanId: string, amount: number, idemKey?: string) {
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `repay:${idemKey}` : undefined, async () => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Loan" WHERE id = ${loanId} FOR UPDATE`;
      if (!rows.length) throw notFound('Кредитът');
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      await requireBorrowerRights(tx, userId, loan.borrowerType as BorrowerType, loan.borrowerId);
      if (!ACTIVE.includes(loan.status)) throw bad('Кредитът не е активен');
      const pay = Math.min(amount, Number(loan.outstanding));
      const tick = await currentTick(tx);
      await transfer(tx, {
        from: acc.of(loan.borrowerType as BorrowerType, loan.borrowerId),
        to: loan.lenderAccountId,
        amount: pay,
        kind: 'LOAN_PREPAYMENT',
        tick,
        key: `repay:${loanId}:${loan.outstanding}:${pay}`,
        refType: 'Loan',
        refId: loanId,
      });
      if (loan.borrowerType === 'CITY') {
        const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(loan.borrowerId) } });
        if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', 'Недостатъчни средства', 402);
      }
      const outstanding = Number(loan.outstanding) - pay;
      const updated = await tx.loan.update({
        where: { id: loanId },
        data: { outstanding: BigInt(outstanding), status: outstanding === 0 ? 'PAID' : loan.status === 'DEFAULTED' ? 'DEFAULTED' : loan.status },
      });
      await tx.world.update({ where: { id: 1 }, data: { creditOutstanding: { decrement: BigInt(pay) } } });
      if (outstanding === 0 && loan.borrowerType === 'CITY') await tx.city.update({ where: { id: loan.borrowerId }, data: { receivership: false } });
      return serializeLoan(updated);
    }),
  );
}

/** Преструктуриране: удължаване на срока x2, +2% лихва, нулиране на просрочията. Допуска се веднъж. */
export async function restructureLoan(prisma: PrismaClient, userId: string, loanId: string) {
  return withTx(prisma, async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw notFound('Кредитът');
    await requireBorrowerRights(tx, userId, loan.borrowerType as BorrowerType, loan.borrowerId);
    if (loan.restructured) throw bad('Кредитът вече е преструктуриран веднъж');
    if (loan.missed === 0 && loan.status !== 'DEFAULTED') throw bad('Преструктуриране се допуска само при просрочие');
    const tick = await currentTick(tx);
    const rate = loan.annualRate + 0.02;
    const remainingDays = Math.max(BALANCE.banking.paymentIntervalDays, loan.termDays - (tick - loan.createdTick)) * 2;
    const payment = annuityPayment(Number(loan.outstanding), rate, remainingDays, BALANCE.banking.paymentIntervalDays);
    const updated = await tx.loan.update({
      where: { id: loanId },
      data: {
        annualRate: rate,
        termDays: remainingDays + (tick - loan.createdTick),
        payment: BigInt(payment),
        missed: 0,
        status: 'RESTRUCTURED',
        restructured: true,
        nextDueTick: tick + BALANCE.banking.paymentIntervalDays,
      },
    });
    await logEvent(tx, { tick, kind: 'restructuring', message: `Кредит е преструктуриран (нова лихва ${(rate * 100).toFixed(1)}%)`, userId });
    return serializeLoan(updated);
  });
}

async function ownerUser(tx: Tx, type: string, id: string): Promise<string | null> {
  if (type === 'CITY') return (await tx.city.findUnique({ where: { id } }))?.ownerId ?? null;
  const ceo = await tx.companyRole.findFirst({ where: { companyId: id, role: 'CEO' } });
  return ceo?.userId ?? (await tx.company.findUnique({ where: { id } }))?.founderId ?? null;
}

/** Обработка на падежите (worker). Идемпотентно чрез nextDueTick в същата транзакция. */
export async function processLoans(prisma: PrismaClient, tick: number) {
  const due = await prisma.loan.findMany({ where: { status: { in: ACTIVE }, nextDueTick: { lte: tick } }, take: 5000 });
  let paid = 0;
  let missed = 0;
  for (const l of due) {
    await withTx(prisma, async (tx) => {
      const loan = await tx.loan.findUnique({ where: { id: l.id } });
      if (!loan || loan.nextDueTick > tick || !ACTIVE.includes(loan.status)) return;
      const B = BALANCE.banking;
      const owner = await ownerUser(tx, loan.borrowerType, loan.borrowerId);
      const interest = periodInterest(Number(loan.outstanding), loan.annualRate, B.paymentIntervalDays);
      const due = Math.min(Number(loan.payment), Number(loan.outstanding) + interest);
      const borrowerAcc = acc.of(loan.borrowerType as BorrowerType, loan.borrowerId);
      // Градовете не могат да плащат от дефицит.
      const bal = await tx.account.findUnique({ where: { id: borrowerAcc } });
      const canPay = bal && Number(bal.balance) >= due;
      const r = canPay
        ? await tryTransfer(tx, {
            from: borrowerAcc,
            to: loan.lenderAccountId,
            amount: due,
            kind: 'LOAN_PAYMENT',
            tick,
            key: `loanpay:${loan.id}:${loan.nextDueTick}`,
            refType: 'Loan',
            refId: loan.id,
          })
        : { status: 'insufficient' as const, paid: 0 };
      if (r.status === 'ok' || r.status === 'duplicate') {
        const principalPart = Math.max(0, due - interest);
        const outstanding = Math.max(0, Number(loan.outstanding) - principalPart);
        await tx.loan.update({
          where: { id: loan.id },
          data: {
            outstanding: BigInt(outstanding),
            nextDueTick: loan.nextDueTick + B.paymentIntervalDays,
            status: outstanding === 0 ? 'PAID' : loan.status === 'DEFAULTED' ? 'RESTRUCTURED' : loan.status,
          },
        });
        await tx.world.update({ where: { id: 1 }, data: { creditOutstanding: { decrement: BigInt(principalPart) } } });
        paid++;
        return;
      }
      missed++;
      const penalty = Math.round(Number(loan.payment) * B.latePenaltyShare);
      const newMissed = loan.missed + 1;
      // Просрочената лихва се капитализира, плюс наказателна надбавка.
      const outstanding = Number(loan.outstanding) + interest + penalty;
      if (loan.status === 'DEFAULTED' && newMissed > B.maxMissedBeforeDefault + 1) {
        // Неизпълнение след неуспешен шанс за преструктуриране -> несъстоятелност / принудително оздравяване.
        if (loan.borrowerType === 'COMPANY') await bankruptcy(tx, loan.borrowerId, tick);
        else {
          await tx.city.update({ where: { id: loan.borrowerId }, data: { receivership: true } });
          await tx.loan.update({
            where: { id: loan.id },
            data: { outstanding: BigInt(outstanding), missed: newMissed, nextDueTick: loan.nextDueTick + B.paymentIntervalDays },
          });
          if (owner)
            await notify(tx, owner, 'credit', 'Градът е под принудително финансово оздравяване: бюджетът за услуги е ограничен до 50% до изплащане на дълга');
        }
        return;
      }
      const status = newMissed >= B.maxMissedBeforeDefault ? 'DEFAULTED' : loan.status;
      await tx.loan.update({
        where: { id: loan.id },
        data: { outstanding: BigInt(outstanding), missed: newMissed, status, nextDueTick: loan.nextDueTick + B.paymentIntervalDays },
      });
      if (loan.borrowerType === 'COMPANY') await tx.company.update({ where: { id: loan.borrowerId }, data: { missedPayments: { increment: 1 } } });
      if (owner) {
        await notify(
          tx,
          owner,
          'credit',
          status === 'DEFAULTED'
            ? 'Кредитът е в неизпълнение! Поискайте преструктуриране до следващия падеж, иначе следва несъстоятелност.'
            : `Пропусната вноска по кредит (${newMissed}/${B.maxMissedBeforeDefault}). Начислена е наказателна лихва.`,
        );
      }
    });
  }
  return { paid, missed };
}

/**
 * Несъстоятелност на компания: отменят се поръчки и договори, стоките се изкупуват на 80% от реф. цена,
 * съоръженията се продават (30% от стойността), кредиторите се изплащат пропорционално, остатъкът от дълга се отписва.
 */
export async function bankruptcy(tx: Tx, companyId: string, tick: number) {
  const company = await tx.company.findUnique({ where: { id: companyId } });
  if (!company || company.status !== 'ACTIVE') return;
  const orders = await tx.marketOrder.findMany({ where: { traderType: 'COMPANY', traderId: companyId, status: 'OPEN' } });
  for (const o of orders) await releaseOrder(tx, o, tick);
  await tx.contract.updateMany({
    where: { OR: [{ sellerCompanyId: companyId }, { buyerCompanyId: companyId }], status: { in: ['PROPOSED', 'ACTIVE'] } },
    data: { status: 'TERMINATED' },
  });
  const prices = await refPrices(tx);
  const inv = await tx.inventory.findMany({ where: { companyId } });
  let proceeds = 0;
  for (const i of inv) proceeds += (i.quantity + i.reserved) * Math.round((prices[i.good as GoodId] ?? 0) * BALANCE.market.exportFloor);
  await tx.inventory.deleteMany({ where: { companyId } });
  await transfer(tx, { from: SYS.WORLD, to: acc.company(companyId), amount: proceeds, kind: 'LIQUIDATION_GOODS', tick, key: `liquidation-goods:${companyId}` });
  const facilities = await tx.facility.findMany({ where: { companyId } });
  for (const f of facilities) await sellFacility(tx, f.id, tick);
  const loans = await tx.loan.findMany({ where: { borrowerType: 'COMPANY', borrowerId: companyId, status: { in: ACTIVE } } });
  const totalDebt = loans.reduce((a, l) => a + Number(l.outstanding), 0);
  const cashRow = await tx.account.findUniqueOrThrow({ where: { id: acc.company(companyId) } });
  let cash = Number(cashRow.balance);
  for (const l of loans) {
    const share = totalDebt > 0 ? Math.floor((cash * Number(l.outstanding)) / totalDebt) : 0;
    const pay = Math.min(share, Number(l.outstanding));
    if (pay > 0)
      await transfer(tx, {
        from: acc.company(companyId),
        to: l.lenderAccountId,
        amount: pay,
        kind: 'LIQUIDATION_RECOVERY',
        tick,
        key: `liquidation-loan:${l.id}`,
      });
    await tx.loan.update({ where: { id: l.id }, data: { status: 'WRITTEN_OFF', outstanding: 0n } });
    await tx.world.update({ where: { id: 1 }, data: { creditOutstanding: { decrement: l.outstanding } } });
  }
  cash = Number((await tx.account.findUniqueOrThrow({ where: { id: acc.company(companyId) } })).balance);
  // Остатъкът (ако има) се разпределя между акционерите.
  if (cash > 0) {
    const holders = await tx.shareholding.findMany({ where: { companyId, shares: { gt: 0 } } });
    for (const h of holders) {
      const amt = Math.floor((cash * h.shares) / company.totalShares);
      if (amt > 0)
        await transfer(tx, {
          from: acc.company(companyId),
          to: acc.of(h.holderType as 'USER' | 'COMPANY', h.holderId),
          amount: amt,
          kind: 'LIQUIDATION_DISTRIBUTION',
          tick,
          key: `liquidation-dist:${companyId}:${h.holderType}:${h.holderId}`,
        });
    }
  }
  await tx.company.update({ where: { id: companyId }, data: { status: 'BANKRUPT', rating: 'D', creditScore: 0 } });
  await logEvent(tx, {
    tick,
    kind: 'bankruptcy',
    message: `Компания „${company.name}“ обяви несъстоятелност. Кредиторите възстановиха ${totalDebt > 0 ? Math.round((Math.min(totalDebt, Number(cashRow.balance)) / totalDebt) * 100) : 100}% от вземанията.`,
  });
  const ceo = await ownerUser(tx, 'COMPANY', companyId);
  if (ceo) await notify(tx, ceo, 'credit', `Компания „${company.name}“ е в несъстоятелност и е ликвидирана`);
}

/** Месечно обновяване на кредитните рейтинги (worker). */
export async function updateRatings(prisma: PrismaClient) {
  const companies = await prisma.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  for (const c of companies) {
    const p = await borrowerProfile(prisma, 'COMPANY', c.id);
    await prisma.company.update({ where: { id: c.id }, data: { rating: p.rating, creditScore: p.score } });
  }
}

export async function listLoans(prisma: PrismaClient, userId: string) {
  const cities = await prisma.city.findMany({ where: { ownerId: userId }, select: { id: true, name: true } });
  const roles = await prisma.companyRole.findMany({ where: { userId } });
  const companies = await prisma.company.findMany({ where: { id: { in: roles.map((r) => r.companyId) } }, select: { id: true, name: true } });
  const loans = await prisma.loan.findMany({
    where: {
      OR: [
        { borrowerType: 'CITY', borrowerId: { in: cities.map((c) => c.id) } },
        { borrowerType: 'COMPANY', borrowerId: { in: companies.map((c) => c.id) } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  const names = new Map([...cities, ...companies].map((x) => [x.id, x.name]));
  return loans.map((l) => ({ ...serializeLoan(l), borrowerName: names.get(l.borrowerId) ?? '?' }));
}
