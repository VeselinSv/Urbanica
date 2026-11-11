import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };
export type * from '@prisma/client';

let client: PrismaClient | null = null;

/** Единствена инстанция на Prisma клиента за процеса. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'] });
  }
  return client;
}

export type Tx = Prisma.TransactionClient;

/** Изпълнява функция в транзакция с повторен опит при конфликт на сериализация/deadlock. */
export async function withTx<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number; timeoutMs?: number; isolation?: Prisma.TransactionIsolationLevel } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        timeout: opts.timeoutMs ?? 20_000,
        maxWait: 10_000,
        isolationLevel: opts.isolation ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = String((e as Error).message ?? '');
      const retryable = code === 'P2034' || msg.includes('deadlock detected') || msg.includes('could not serialize');
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
    }
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}
