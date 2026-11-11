import { BALANCE, FACILITIES, type GoodId } from '@gce/shared';
import type { Tx } from '@gce/database';
import { DomainError } from './errors';

/** Добавя стоки към склад с претеглена средна себестойност. */
export async function addGoods(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number, unitCost: number): Promise<void> {
  if (qty <= 0) return;
  const cost = Math.max(0, Math.round(unitCost));
  await tx.$executeRaw`
    INSERT INTO "Inventory" ("companyId","cityId","good","quantity","reserved","avgCost") VALUES (${companyId}, ${cityId}, ${good}, ${qty}, 0, ${cost})
    ON CONFLICT ("companyId","cityId","good") DO UPDATE SET
      "avgCost" = CASE WHEN "Inventory"."quantity" + "Inventory"."reserved" + EXCLUDED."quantity" > 0
        THEN (("Inventory"."avgCost"::bigint * ("Inventory"."quantity" + "Inventory"."reserved") + EXCLUDED."avgCost"::bigint * EXCLUDED."quantity")
              / ("Inventory"."quantity" + "Inventory"."reserved" + EXCLUDED."quantity"))::int
        ELSE 0 END,
      "quantity" = "Inventory"."quantity" + EXCLUDED."quantity"`;
}

/** Изважда свободни (нерезервирани) стоки; при недостиг – грешка и отмяна на транзакцията. */
export async function takeGoods(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number): Promise<void> {
  if (qty <= 0) return;
  const n =
    await tx.$executeRaw`UPDATE "Inventory" SET "quantity" = "quantity" - ${qty} WHERE "companyId" = ${companyId} AND "cityId" = ${cityId} AND "good" = ${good} AND "quantity" >= ${qty}`;
  if (n !== 1) throw new DomainError('INSUFFICIENT_GOODS', `Недостатъчна наличност: ${good}`, 409);
}

export async function tryTakeGoods(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number): Promise<boolean> {
  if (qty <= 0) return true;
  const n =
    await tx.$executeRaw`UPDATE "Inventory" SET "quantity" = "quantity" - ${qty} WHERE "companyId" = ${companyId} AND "cityId" = ${cityId} AND "good" = ${good} AND "quantity" >= ${qty}`;
  return n === 1;
}

export async function reserveGoods(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number): Promise<void> {
  const n =
    await tx.$executeRaw`UPDATE "Inventory" SET "quantity" = "quantity" - ${qty}, "reserved" = "reserved" + ${qty} WHERE "companyId" = ${companyId} AND "cityId" = ${cityId} AND "good" = ${good} AND "quantity" >= ${qty}`;
  if (n !== 1) throw new DomainError('INSUFFICIENT_GOODS', 'Недостатъчна свободна наличност за продажба', 409);
}

export async function releaseReserved(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number): Promise<void> {
  if (qty <= 0) return;
  const n =
    await tx.$executeRaw`UPDATE "Inventory" SET "quantity" = "quantity" + ${qty}, "reserved" = "reserved" - ${qty} WHERE "companyId" = ${companyId} AND "cityId" = ${cityId} AND "good" = ${good} AND "reserved" >= ${qty}`;
  if (n !== 1) throw new DomainError('INVENTORY_STATE', 'Несъответствие в резервираните наличности', 500);
}

export async function consumeReserved(tx: Tx, companyId: string, cityId: string, good: GoodId, qty: number): Promise<void> {
  if (qty <= 0) return;
  const n =
    await tx.$executeRaw`UPDATE "Inventory" SET "reserved" = "reserved" - ${qty} WHERE "companyId" = ${companyId} AND "cityId" = ${cityId} AND "good" = ${good} AND "reserved" >= ${qty}`;
  if (n !== 1) throw new DomainError('INVENTORY_STATE', 'Несъответствие в резервираните наличности', 500);
}

export async function storageUsed(tx: Tx, companyId: string, cityId: string): Promise<number> {
  const rows = await tx.$queryRaw<
    { used: bigint | null }[]
  >`SELECT SUM("quantity" + "reserved")::bigint AS used FROM "Inventory" WHERE "companyId" = ${companyId} AND "cityId" = ${cityId}`;
  return Number(rows[0]?.used ?? 0);
}

export async function storageCapacity(tx: Tx, companyId: string, cityId: string): Promise<number> {
  const warehouses = await tx.facility.count({ where: { companyId, cityId, type: 'warehouse' } });
  return BALANCE.company.baseStorage + warehouses * (FACILITIES.warehouse.storageBonus ?? 0);
}
