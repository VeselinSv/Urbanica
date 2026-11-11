import { BALANCE } from '@gce/shared';
import { isUniqueViolation, withTx, type PrismaClient } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { currentTick } from './world';
import { logEvent, notify, publish } from './events';

const rate = new Map<string, number[]>();

/** Канал за лични съобщения – подреден, за да е един и същ за двамата участници. */
export function dmChannel(a: string, b: string) {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

async function canAccessChannel(prisma: PrismaClient, userId: string, channel: string): Promise<boolean> {
  if (channel === 'global') return true;
  if (channel.startsWith('dm:')) return channel.split(':').slice(1).includes(userId);
  if (channel.startsWith('company:')) {
    const id = channel.slice(8);
    const [role, share] = await Promise.all([
      prisma.companyRole.findFirst({ where: { companyId: id, userId } }),
      prisma.shareholding.findFirst({ where: { companyId: id, holderType: 'USER', holderId: userId, shares: { gt: 0 } } }),
    ]);
    return Boolean(role || share);
  }
  if (channel.startsWith('alliance:')) {
    const m = await prisma.allianceMember.findUnique({ where: { userId } });
    return m?.allianceId === channel.slice(9);
  }
  return false;
}

/** Нормализира канал от клиента: "dm:<otherUserId>" -> "dm:<a>:<b>". */
export function normalizeChannel(userId: string, channel: string) {
  if (channel.startsWith('dm:') && channel.split(':').length === 2) return dmChannel(userId, channel.slice(3));
  return channel;
}

export async function sendChat(prisma: PrismaClient, userId: string, rawChannel: string, body: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mutedUntil && user.mutedUntil > new Date()) throw forbidden('Временно не можете да изпращате съобщения (модерация)');
  const now = Date.now();
  const recent = (rate.get(userId) ?? []).filter((t) => now - t < BALANCE.chat.rateWindowMs);
  if (recent.length >= BALANCE.chat.rateMax) throw new DomainError('RATE_LIMIT', 'Твърде много съобщения – изчакайте малко', 429);
  recent.push(now);
  rate.set(userId, recent);
  const channel = normalizeChannel(userId, rawChannel);
  if (!(await canAccessChannel(prisma, userId, channel))) throw forbidden('Нямате достъп до този канал');
  if (channel.startsWith('dm:')) {
    const other = channel
      .split(':')
      .slice(1)
      .find((x) => x !== userId);
    if (!other || !(await prisma.user.findUnique({ where: { id: other } }))) throw notFound('Получателят');
    if (await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: other, blockedId: userId } } }))
      throw forbidden('Получателят ви е блокирал');
  }
  const msg = await prisma.chatMessage.create({ data: { channel, senderId: userId, body } });
  const out = { id: String(msg.id), channel, senderId: userId, senderName: user.username, body, createdAt: msg.createdAt.toISOString() };
  await publish(prisma, { type: 'chat', ...out });
  return out;
}

export async function chatHistory(prisma: PrismaClient, userId: string, rawChannel: string, beforeId?: string) {
  const channel = normalizeChannel(userId, rawChannel);
  if (!(await canAccessChannel(prisma, userId, channel))) throw forbidden('Нямате достъп до този канал');
  const blocked = await prisma.block.findMany({ where: { blockerId: userId } });
  const msgs = await prisma.chatMessage.findMany({
    where: { channel, senderId: { notIn: blocked.map((b) => b.blockedId) }, ...(beforeId ? { id: { lt: BigInt(beforeId) } } : {}) },
    orderBy: { id: 'desc' },
    take: 50,
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.senderId))] } }, select: { id: true, username: true } });
  const n = new Map(users.map((u) => [u.id, u.username]));
  return msgs.reverse().map((m) => ({
    id: String(m.id),
    channel,
    senderId: m.senderId,
    senderName: n.get(m.senderId) ?? '?',
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function canReceive(prisma: PrismaClient, userId: string, channel: string) {
  return canAccessChannel(prisma, userId, channel);
}

export async function friendRequest(prisma: PrismaClient, userId: string, username: string) {
  const other = await prisma.user.findUnique({ where: { username } });
  if (!other) throw notFound('Потребителят');
  if (other.id === userId) throw bad('Не можете да добавите себе си');
  const reverse = await prisma.friendship.findUnique({ where: { requesterId_addresseeId: { requesterId: other.id, addresseeId: userId } } });
  if (reverse) {
    await prisma.friendship.update({ where: { requesterId_addresseeId: { requesterId: other.id, addresseeId: userId } }, data: { status: 'ACCEPTED' } });
    return { status: 'ACCEPTED' };
  }
  try {
    await prisma.friendship.create({ data: { requesterId: userId, addresseeId: other.id } });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Поканата вече е изпратена');
    throw e;
  }
  await notify(prisma, other.id, 'friend', 'Имате нова покана за приятелство');
  return { status: 'PENDING' };
}

export async function friends(prisma: PrismaClient, userId: string) {
  const rows = await prisma.friendship.findMany({ where: { OR: [{ requesterId: userId }, { addresseeId: userId }] } });
  const ids = rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, lastActiveAt: true } });
  const n = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const otherId = r.requesterId === userId ? r.addresseeId : r.requesterId;
    const u = n.get(otherId);
    return {
      userId: otherId,
      username: u?.username,
      status: r.status,
      incoming: r.addresseeId === userId,
      online: u ? Date.now() - u.lastActiveAt.getTime() < 5 * 60_000 : false,
    };
  });
}

export async function block(prisma: PrismaClient, userId: string, targetId: string, on: boolean) {
  if (targetId === userId) throw bad('Невалидна цел');
  if (on)
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
      create: { blockerId: userId, blockedId: targetId },
      update: {},
    });
  else await prisma.block.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
  return { ok: true };
}

export async function report(prisma: PrismaClient, userId: string, input: { userId: string; reason: string; messageId?: string }) {
  if (!(await prisma.user.findUnique({ where: { id: input.userId } }))) throw notFound('Потребителят');
  return prisma.report.create({ data: { reporterId: userId, targetUserId: input.userId, reason: input.reason, messageId: input.messageId } });
}

export async function moderate(prisma: PrismaClient, adminId: string, targetId: string, minutes: number) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  if (admin.role !== 'ADMIN') throw forbidden();
  await prisma.user.update({ where: { id: targetId }, data: { mutedUntil: new Date(Date.now() + minutes * 60_000) } });
  await prisma.report.updateMany({ where: { targetUserId: targetId, status: 'OPEN' }, data: { status: 'ACTIONED' } });
  await prisma.auditLog.create({ data: { userId: adminId, action: 'moderation.mute', details: { targetId, minutes } } });
  return { ok: true };
}

export async function notifications(prisma: PrismaClient, userId: string) {
  const list = await prisma.notification.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 50 });
  return list.map((n) => ({ ...n, id: String(n.id) }));
}

export async function markNotificationsRead(prisma: PrismaClient, userId: string) {
  await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  return { ok: true };
}

export async function news(prisma: PrismaClient) {
  const list = await prisma.worldEvent.findMany({ where: { public: true }, orderBy: { id: 'desc' }, take: 50 });
  return list.map((e) => ({ ...e, id: String(e.id) }));
}

export async function cityEvents(prisma: PrismaClient, cityId: string) {
  const list = await prisma.worldEvent.findMany({ where: { cityId }, orderBy: { id: 'desc' }, take: 50 });
  return list.map((e) => ({ ...e, id: String(e.id) }));
}

/** Изтриване на стари съобщения – не пазим повече комуникационни данни от необходимото. */
export async function purgeOldChat(prisma: PrismaClient) {
  const cutoff = new Date(Date.now() - BALANCE.chat.retentionDays * 86400_000);
  const r = await prisma.chatMessage.deleteMany({ where: { createdAt: { lt: cutoff } } });
  await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff }, read: true } });
  return r.count;
}

// ---------------- Съюзи (икономическа дипломация) ----------------

export async function createAlliance(prisma: PrismaClient, userId: string, input: { name: string; description: string }) {
  try {
    return await withTx(prisma, async (tx) => {
      if (await tx.allianceMember.findUnique({ where: { userId } })) throw conflict('Вече членувате в съюз');
      const a = await tx.alliance.create({ data: { name: input.name, description: input.description, leaderId: userId } });
      await tx.allianceMember.create({ data: { allianceId: a.id, userId, role: 'LEADER' } });
      await logEvent(tx, { tick: await currentTick(tx), kind: 'alliance', message: `Създаден е съюз „${a.name}“`, userId });
      return a;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Съюз с това име вече съществува');
    throw e;
  }
}

export async function inviteToAlliance(prisma: PrismaClient, userId: string, allianceId: string, username: string) {
  const m = await prisma.allianceMember.findUnique({ where: { userId } });
  if (!m || m.allianceId !== allianceId || m.role !== 'LEADER') throw forbidden('Само лидерът кани нови членове');
  const target = await prisma.user.findUnique({ where: { username } });
  if (!target) throw notFound('Потребителят');
  if (await prisma.allianceMember.findUnique({ where: { userId: target.id } })) throw conflict('Потребителят вече е в съюз');
  const inv = await prisma.allianceInvite.create({ data: { allianceId, userId: target.id } });
  const a = await prisma.alliance.findUniqueOrThrow({ where: { id: allianceId } });
  await notify(prisma, target.id, 'alliance', `Покана за членство в съюз „${a.name}“`);
  return inv;
}

export async function respondInvite(prisma: PrismaClient, userId: string, inviteId: string, accept: boolean) {
  return withTx(prisma, async (tx) => {
    const inv = await tx.allianceInvite.findUnique({ where: { id: inviteId } });
    if (!inv || inv.userId !== userId || inv.status !== 'PENDING') throw notFound('Поканата');
    await tx.allianceInvite.update({ where: { id: inviteId }, data: { status: accept ? 'ACCEPTED' : 'DECLINED' } });
    if (accept) {
      if (await tx.allianceMember.findUnique({ where: { userId } })) throw conflict('Вече членувате в съюз');
      await tx.allianceMember.create({ data: { allianceId: inv.allianceId, userId } });
    }
    return { ok: true };
  });
}

export async function leaveAlliance(prisma: PrismaClient, userId: string) {
  return withTx(prisma, async (tx) => {
    const m = await tx.allianceMember.findUnique({ where: { userId } });
    if (!m) throw bad('Не членувате в съюз');
    await tx.allianceMember.delete({ where: { userId } });
    if (m.role === 'LEADER') {
      const next = await tx.allianceMember.findFirst({ where: { allianceId: m.allianceId }, orderBy: { joinedAt: 'asc' } });
      if (next) {
        await tx.allianceMember.update({ where: { userId: next.userId }, data: { role: 'LEADER' } });
        await tx.alliance.update({ where: { id: m.allianceId }, data: { leaderId: next.userId } });
      } else {
        await tx.allianceSanction.deleteMany({ where: { allianceId: m.allianceId } });
        await tx.alliance.delete({ where: { id: m.allianceId } });
      }
    }
    return { ok: true };
  });
}

export async function alliances(prisma: PrismaClient, userId: string) {
  const list = await prisma.alliance.findMany({ orderBy: { createdAt: 'asc' } });
  const members = await prisma.allianceMember.findMany();
  const users = await prisma.user.findMany({ where: { id: { in: members.map((m) => m.userId) } }, select: { id: true, username: true } });
  const n = new Map(users.map((u) => [u.id, u.username]));
  const sanctions = await prisma.allianceSanction.findMany();
  const invites = await prisma.allianceInvite.findMany({ where: { userId, status: 'PENDING' } });
  const mine = members.find((m) => m.userId === userId);
  return {
    myAllianceId: mine?.allianceId ?? null,
    myRole: mine?.role ?? null,
    invites: invites.map((i) => ({ id: i.id, allianceId: i.allianceId, allianceName: list.find((a) => a.id === i.allianceId)?.name })),
    alliances: list.map((a) => ({
      ...a,
      members: members.filter((m) => m.allianceId === a.id).map((m) => ({ userId: m.userId, username: n.get(m.userId), role: m.role })),
      sanctions: sanctions.filter((s) => s.allianceId === a.id).map((s) => ({ userId: s.targetUserId, username: n.get(s.targetUserId) ?? s.targetUserId })),
    })),
  };
}
