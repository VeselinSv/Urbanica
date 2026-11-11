import { Prisma, type Tx } from '@gce/database';

/**
 * Идемпотентно изпълнение на критично действие в рамките на транзакцията.
 * Ако същият потребител изпрати същия ключ повторно, връща записания отговор, без да изпълнява действието втори път.
 * Конкурентен дубликат изчаква първата транзакция (уникален индекс) и после получава записания резултат.
 */
export async function idempotent<T>(tx: Tx, userId: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const k = key.slice(0, 120);
  const inserted =
    await tx.$executeRaw`INSERT INTO "IdempotencyRecord" ("userId","key","response") VALUES (${userId}, ${k}, 'null'::jsonb) ON CONFLICT DO NOTHING`;
  if (inserted === 0) {
    const rec = await tx.idempotencyRecord.findUnique({ where: { userId_key: { userId, key: k } } });
    return (rec?.response ?? null) as T;
  }
  const result = await fn();
  await tx.idempotencyRecord.update({
    where: { userId_key: { userId, key: k } },
    data: { response: JSON.parse(JSON.stringify(result ?? null, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as Prisma.InputJsonValue },
  });
  return result;
}
