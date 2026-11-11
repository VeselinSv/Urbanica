import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BALANCE } from '@gce/shared';
import { isUniqueViolation, withTx, type PrismaClient } from '@gce/database';
import { DomainError, conflict } from './errors';
import { SYS, ensureAccount, transfer } from './ledger';
import { currentTick } from './world';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** Сесията на автоматичния играч е дълга – тя е самата му самоличност (пази се в браузъра). */
const SESSION_DAYS = 3650;

/** Хеширане на парола със scrypt (memory-hard) и случайна сол. Формат: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function createSession(prisma: PrismaClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) } });
  return token;
}

export function publicUser(u: { id: string; username: string; email: string; role: string; createdAt: Date }) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.createdAt };
}

export async function register(prisma: PrismaClient, input: { username: string; email: string; password: string }) {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await withTx(prisma, async (tx) => {
      const u = await tx.user.create({ data: { username: input.username, email: input.email.toLowerCase(), passwordHash } });
      const wallet = await ensureAccount(tx, 'USER', u.id);
      const tick = await currentTick(tx);
      await transfer(tx, {
        from: SYS.MINT,
        to: wallet,
        amount: BALANCE.start.wallet,
        kind: 'START_CAPITAL',
        tick,
        key: `wallet-start:${u.id}`,
        refType: 'User',
        refId: u.id,
      });
      return u;
    });
    const token = await createSession(prisma, user.id);
    return { token, user: publicUser(user) };
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Потребителското име или e-mail адресът вече е зает');
    throw e;
  }
}

/**
 * Автоматичен играч: без регистрация и вход. При първо отваряне на играта се създава кмет с
 * уникално име и стартов капитал; браузърът пази дългата сесия. Паролата е случайна и не се показва.
 */
export async function createGuest(prisma: PrismaClient) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const tag = randomBytes(3).toString('hex').toUpperCase();
    try {
      const r = await register(prisma, {
        username: `Кмет-${tag}`,
        email: `${tag.toLowerCase()}-${randomBytes(6).toString('hex')}@guest.urbanica`,
        password: randomBytes(24).toString('base64url'),
      });
      return { ...r, guest: true };
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'CONFLICT')) throw e;
    }
  }
  throw conflict('Неуспешно създаване на играч – опитайте отново');
}

const touchCache = new Map<string, number>();

export async function sessionUser(prisma: PrismaClient, token: string | undefined) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) return null;
  const last = touchCache.get(s.userId) ?? 0;
  if (Date.now() - last > 60_000) {
    touchCache.set(s.userId, Date.now());
    await prisma.user.update({ where: { id: s.userId }, data: { lastActiveAt: new Date() } });
  }
  return s.user;
}
