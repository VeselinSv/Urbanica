import type { PrismaClient, Tx } from '@gce/database';

/** Канал на PostgreSQL LISTEN/NOTIFY – worker-ът и API-то обменят събития в реално време. */
export const PG_CHANNEL = 'gce_events';

export type BusEvent =
  | { type: 'tick'; tick: number; at?: string }
  | { type: 'notification'; userId: string; kind: string; message: string }
  | { type: 'city'; cityId: string; ownerId: string }
  | { type: 'market'; instrument: string }
  | { type: 'chat'; channel: string; id: string; senderId: string; senderName: string; body: string; createdAt: string };

/** Публикува събитие – доставя се при commit на транзакцията (гарантира, че клиентите виждат само записани промени). */
export async function publish(db: Tx | PrismaClient, ev: BusEvent): Promise<void> {
  const payload = JSON.stringify(ev);
  if (payload.length > 7900) return;
  await db.$executeRaw`SELECT pg_notify(${PG_CHANNEL}, ${payload})`;
}

export async function notify(db: Tx | PrismaClient, userId: string, kind: string, message: string): Promise<void> {
  await db.notification.create({ data: { userId, kind, message } });
  await publish(db, { type: 'notification', userId, kind, message });
}

export async function logEvent(
  db: Tx | PrismaClient,
  e: { tick: number; kind: string; message: string; cityId?: string; userId?: string; public?: boolean },
): Promise<void> {
  await db.worldEvent.create({ data: { tick: e.tick, kind: e.kind, message: e.message, cityId: e.cityId, userId: e.userId, public: e.public ?? true } });
}
