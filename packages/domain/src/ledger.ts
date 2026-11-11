import type { Tx } from '@gce/database';
import { DomainError, insufficient } from './errors';

export type OwnerKind = 'USER' | 'CITY' | 'COMPANY' | 'SYSTEM';

/** Детерминистични идентификатори на сметки – без нужда от търсене. */
export const acc = {
  user: (id: string) => `user:${id}`,
  city: (id: string) => `city:${id}`,
  company: (id: string) => `company:${id}`,
  of: (type: OwnerKind, id: string) => `${type.toLowerCase()}:${id}`,
};

/** Системни сметки: MINT (емисия на пари), WORLD (външна икономика/домакинства), ESCROW, BANK, FEES (изтегляне на пари). */
export const SYS = {
  MINT: 'system:mint',
  WORLD: 'system:world',
  ESCROW: 'system:escrow',
  BANK: 'system:bank',
  FEES: 'system:fees',
} as const;

export async function ensureAccount(tx: Tx, ownerType: OwnerKind, ownerId: string, allowNegative = false): Promise<string> {
  const id = acc.of(ownerType, ownerId);
  await tx.$executeRaw`INSERT INTO "Account" ("id","ownerType","ownerId","balance","allowNegative") VALUES (${id}, ${ownerType}::"OwnerType", ${ownerId}, 0, ${allowNegative}) ON CONFLICT ("id") DO NOTHING`;
  return id;
}

export async function ensureSystemAccounts(tx: Tx): Promise<void> {
  for (const name of ['mint', 'world', 'escrow', 'bank', 'fees']) {
    await ensureAccount(tx, 'SYSTEM', name, name === 'mint' || name === 'world');
  }
}

export async function balanceOf(tx: Tx, accountId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ balance: bigint }[]>`SELECT balance FROM "Account" WHERE id = ${accountId}`;
  if (!rows.length) throw new DomainError('NO_ACCOUNT', `Сметка ${accountId} не съществува`, 500);
  return Number(rows[0].balance);
}

export interface TransferInput {
  from: string;
  to: string;
  amount: number | bigint;
  kind: string;
  key: string;
  tick: number;
  refType?: string;
  refId?: string;
  memo?: string;
}

/**
 * Атомарен паричен превод с двустранен запис в регистъра.
 * - Идемпотентен: повторно изпълнение със същия ключ не прави нищо (връща false).
 * - Условно намаляване на баланса – при недостиг хвърля INSUFFICIENT_FUNDS и цялата транзакция се отменя.
 */
export async function transfer(tx: Tx, t: TransferInput): Promise<boolean> {
  const amount = BigInt(Math.round(Number(t.amount)));
  if (amount <= 0n) return false;
  if (t.from === t.to) return false;
  const inserted = await tx.$queryRaw<{ id: bigint }[]>`
    INSERT INTO "LedgerEntry" ("idempotencyKey","fromAccountId","toAccountId","amount","kind","refType","refId","memo","tick")
    VALUES (${t.key}, ${t.from}, ${t.to}, ${amount}, ${t.kind}, ${t.refType ?? null}, ${t.refId ?? null}, ${t.memo ?? null}, ${t.tick})
    ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id`;
  if (inserted.length === 0) return false;
  const debited = await tx.$executeRaw`UPDATE "Account" SET balance = balance - ${amount} WHERE id = ${t.from} AND ("allowNegative" OR balance >= ${amount})`;
  if (debited !== 1) throw insufficient();
  const credited = await tx.$executeRaw`UPDATE "Account" SET balance = balance + ${amount} WHERE id = ${t.to}`;
  if (credited !== 1) throw new DomainError('NO_ACCOUNT', `Сметка ${t.to} не съществува`, 500);
  return true;
}

/**
 * Опит за превод без прекъсване на транзакцията при недостиг: заключва сметката (FOR UPDATE),
 * проверява наличността и превежда само ако има средства. Връща 'ok' | 'insufficient' | 'duplicate'.
 * `partial` позволява превод на наличната сума (напр. изплащане при фалит).
 */
export async function tryTransfer(
  tx: Tx,
  t: TransferInput,
  opts: { partial?: boolean } = {},
): Promise<{ status: 'ok' | 'insufficient' | 'duplicate'; paid: number }> {
  const amount = Math.round(Number(t.amount));
  if (amount <= 0 || t.from === t.to) return { status: 'ok', paid: 0 };
  const rows = await tx.$queryRaw<
    { balance: bigint; allowNegative: boolean }[]
  >`SELECT balance, "allowNegative" FROM "Account" WHERE id = ${t.from} FOR UPDATE`;
  if (!rows.length) return { status: 'insufficient', paid: 0 };
  const bal = Number(rows[0].balance);
  let pay = amount;
  if (!rows[0].allowNegative && bal < amount) {
    if (!opts.partial || bal <= 0) return { status: 'insufficient', paid: 0 };
    pay = bal;
  }
  const ok = await transfer(tx, { ...t, amount: pay });
  return { status: ok ? 'ok' : 'duplicate', paid: ok ? pay : 0 };
}
