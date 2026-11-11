import type { PrismaClient } from '@gce/database';
import { SYS } from '@gce/domain';
import { BALANCE, GOODS, type GoodId } from '@gce/shared';

export interface InvariantReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * Проверки за целостта на икономиката (използват се от тестовете и икономическата симулация):
 * - сумата на всички баланси е 0 (двустранно счетоводство, парите се създават само от MINT);
 * - всеки баланс съвпада с регистъра;
 * - ескроу сметката покрива точно отворените поръчки за покупка;
 * - пари се създават само чрез разрешени операции (начален капитал);
 * - няма отрицателни наличности/акции; цените са в разрешените граници.
 */
export async function checkInvariants(prisma: PrismaClient): Promise<InvariantReport> {
  const checks: InvariantReport['checks'] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const sum = await prisma.$queryRaw<{ s: bigint | null }[]>`SELECT SUM(balance)::bigint AS s FROM "Account"`;
  add('Сума на балансите = 0', Number(sum[0].s ?? 0n) === 0, `сума = ${sum[0].s}`);

  const mismatch = await prisma.$queryRaw<{ id: string; balance: bigint; ledger: bigint }[]>`
    SELECT a.id, a.balance, COALESCE(i.s, 0) - COALESCE(o.s, 0) AS ledger FROM "Account" a
    LEFT JOIN (SELECT "toAccountId" id, SUM(amount) s FROM "LedgerEntry" GROUP BY 1) i ON i.id = a.id
    LEFT JOIN (SELECT "fromAccountId" id, SUM(amount) s FROM "LedgerEntry" GROUP BY 1) o ON o.id = a.id
    WHERE a.balance <> COALESCE(i.s, 0) - COALESCE(o.s, 0)`;
  add(
    'Балансите съвпадат с регистъра',
    mismatch.length === 0,
    mismatch.length ? JSON.stringify(mismatch.slice(0, 3).map((m) => ({ ...m, balance: String(m.balance), ledger: String(m.ledger) }))) : 'ok',
  );

  const escrow = await prisma.account.findUnique({ where: { id: SYS.ESCROW } });
  const open = await prisma.$queryRaw<{ s: bigint | null }[]>`SELECT SUM(escrow)::bigint AS s FROM "MarketOrder" WHERE status = 'OPEN' AND side = 'BUY'`;
  add('Ескроу = отворени поръчки', Number(escrow?.balance ?? 0n) === Number(open[0].s ?? 0n), `escrow=${escrow?.balance} orders=${open[0].s}`);

  const minted = await prisma.ledgerEntry.groupBy({ by: ['kind'], where: { fromAccountId: SYS.MINT }, _sum: { amount: true } });
  const allowed = ['START_CAPITAL', 'BANK_CAPITAL'];
  const bad = minted.filter((m) => !allowed.includes(m.kind));
  add('Пари се създават само от разрешени операции', bad.length === 0, minted.map((m) => `${m.kind}:${m._sum.amount}`).join(', '));

  const negInv = await prisma.inventory.count({ where: { OR: [{ quantity: { lt: 0 } }, { reserved: { lt: 0 } }] } });
  add('Няма отрицателни наличности', negInv === 0, `${negInv}`);
  const shareMismatch = await prisma.$queryRaw<{ id: string; total: number; held: bigint }[]>`
    SELECT c.id, c."totalShares" AS total, COALESCE(SUM(s.shares), 0)::bigint AS held FROM "Company" c LEFT JOIN "Shareholding" s ON s."companyId" = c.id
    WHERE c.status = 'ACTIVE' GROUP BY c.id HAVING c."totalShares" <> COALESCE(SUM(s.shares), 0)`;
  add('Акциите в обращение = общ брой акции', shareMismatch.length === 0, shareMismatch.length ? `${shareMismatch.length} компании` : 'ok');

  const states = await prisma.marketState.findMany({ where: { instrument: { startsWith: 'GOOD:' } } });
  const out = states.filter((s) => {
    const g = GOODS[s.instrument.slice(5) as GoodId];
    const p = Number(s.refPrice);
    return p < g.basePrice * BALANCE.market.minPriceShare - 1 || p > g.basePrice * BALANCE.market.maxPriceShare + 1;
  });
  add('Цените са в границите', out.length === 0, states.map((s) => `${s.instrument.slice(5)}=${(Number(s.refPrice) / 100).toFixed(2)}`).join(' '));

  return { ok: checks.every((c) => c.ok), checks };
}
