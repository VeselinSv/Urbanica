/**
 * Поддръжка на историята при бърз ден (1 игрови ден = 1 секунда → 86 400 дни на денонощие):
 *  - стари записи от регистъра се сливат в обобщени (по платец, получател и вид) – балансите и сумите
 *    остават точни (инвариантите минават), а редовете намаляват хилядократно;
 *  - статистиката, цените и тиковете се пазят само за последните няколко хиляди дни (за графиките).
 */
import type { PrismaClient } from '@gce/database';

const KEEP_LEDGER = 3_000;
const KEEP_STATS = 1_000;
const KEEP_PRICES = 2_000;
const KEEP_TICKS = 300;

export async function compactHistory(prisma: PrismaClient, tick: number): Promise<number> {
  const cut = tick - KEEP_LEDGER;
  let n = 0;
  if (cut > 0) {
    n += await prisma.$executeRaw`
      WITH old AS (
        DELETE FROM "LedgerEntry" WHERE tick < ${cut}
        RETURNING "fromAccountId", "toAccountId", amount, kind
      )
      INSERT INTO "LedgerEntry" ("idempotencyKey","fromAccountId","toAccountId","amount","kind","memo","tick")
      SELECT 'agg:' || ${cut} || ':' || md5("fromAccountId" || '>' || "toAccountId" || '>' || kind), "fromAccountId", "toAccountId", SUM(amount), kind, 'обобщено (по-стари дни)', ${cut}
      FROM old GROUP BY "fromAccountId", "toAccountId", kind`;
  }
  n += await prisma.cityStat.deleteMany({ where: { tick: { lt: tick - KEEP_STATS } } }).then((r) => r.count);
  n += await prisma.companyStat.deleteMany({ where: { tick: { lt: tick - KEEP_STATS } } }).then((r) => r.count);
  n += await prisma.priceHistory.deleteMany({ where: { tick: { lt: tick - KEEP_PRICES } } }).then((r) => r.count);
  n += await prisma.tickRun.deleteMany({ where: { tick: { lt: tick - KEEP_TICKS } } }).then((r) => r.count);
  return n;
}
