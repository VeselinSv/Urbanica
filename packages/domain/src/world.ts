import { BALANCE, GOODS, GOOD_IDS, tileKey, type GoodId, type WorldInfo } from '@gce/shared';
import { getWorld, type WorldGenerator } from '@gce/world-generation';
import type { PrismaClient, Tx } from '@gce/database';
import { SYS, ensureSystemAccounts, transfer } from './ledger';

let cachedSeed: string | null = null;

/** Създава световния ред, системните сметки, началните пазарни цени и банковия капитал (идемпотентно). */
export async function ensureWorld(prisma: PrismaClient, seed: string, tickIntervalMs: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.world.upsert({
      where: { id: 1 },
      create: { id: 1, seed, size: BALANCE.world.size, tickIntervalMs, baseRate: BALANCE.banking.neutralRate },
      update: { tickIntervalMs },
    });
    await ensureSystemAccounts(tx);
    for (const g of GOOD_IDS) {
      await tx.marketState.upsert({
        where: { instrument: `GOOD:${g}` },
        create: { instrument: `GOOD:${g}`, refPrice: BigInt(GOODS[g].basePrice) },
        update: {},
      });
    }
    await transfer(tx, {
      from: SYS.MINT,
      to: SYS.BANK,
      amount: BALANCE.banking.bankInitialCapital,
      kind: 'BANK_CAPITAL',
      key: 'genesis:bank-capital',
      tick: 0,
      memo: 'Начален капитал на Глобалната банка',
    });
  });
}

export async function worldRow(db: PrismaClient | Tx) {
  const w = await db.world.findUnique({ where: { id: 1 } });
  if (!w) throw new Error('World is not initialised');
  cachedSeed = w.seed;
  return w;
}

export async function worldGen(db: PrismaClient | Tx): Promise<WorldGenerator> {
  if (cachedSeed) return getWorld(cachedSeed);
  const w = await worldRow(db);
  return getWorld(w.seed);
}

export async function currentTick(db: PrismaClient | Tx): Promise<number> {
  return (await worldRow(db)).tick;
}

export async function worldInfo(db: PrismaClient): Promise<WorldInfo> {
  const w = await worldRow(db);
  return {
    id: w.id,
    seed: w.seed,
    size: w.size,
    chunkSize: BALANCE.world.chunkSize,
    parcelSize: BALANCE.world.parcelSize,
    tick: w.tick,
    tickIntervalMs: w.tickIntervalMs,
    lastTickAt: w.lastTickAt.toISOString(),
    serverTime: new Date().toISOString(),
    baseRate: w.baseRate,
    priceIndex: w.priceIndex,
  };
}

/** Плочките (ключове "x,y") на територията, съставена от парцели. */
export function territoryKeys(parcels: { px: number; py: number }[]): string[] {
  const s = BALANCE.world.parcelSize;
  const out: string[] = [];
  for (const p of parcels) for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) out.push(tileKey(p.px * s + i, p.py * s + j));
  return out;
}

export function parcelOf(x: number, y: number): { px: number; py: number } {
  const s = BALANCE.world.parcelSize;
  return { px: Math.floor(x / s), py: Math.floor(y / s) };
}

export function cityDistance(a: { originX: number; originY: number }, b: { originX: number; originY: number }): number {
  return Math.round(Math.hypot(a.originX - b.originX, a.originY - b.originY));
}

export async function refPrices(db: PrismaClient | Tx): Promise<Record<GoodId, number>> {
  const rows = await db.marketState.findMany({ where: { instrument: { startsWith: 'GOOD:' } } });
  const out = {} as Record<GoodId, number>;
  for (const g of GOOD_IDS) out[g] = GOODS[g].basePrice;
  for (const r of rows) out[r.instrument.slice(5) as GoodId] = Number(r.refPrice);
  return out;
}
