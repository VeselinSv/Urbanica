import { hostname } from 'node:os';
import { getPrisma } from '@gce/database';
import { acquireLease, ensureWorld, processTick, releaseLease, worldRow } from '@gce/domain';
import { loadEnv, requireEnv } from './env';

loadEnv();
requireEnv('DATABASE_URL');

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, svc: 'worker', msg, ...extra }));

/**
 * Симулационен worker: единствен лидер (лиз в базата) изпълнява игровите тикове по централния часовник.
 * Светът продължава, когато играчите са офлайн. След рестарт състоянието се възстановява от базата
 * и пропуснатите тикове се наваксват (ограничено), като всяка фаза е идемпотентна.
 */
async function main() {
  const prisma = getPrisma();
  const holder = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const interval = Number(process.env.TICK_INTERVAL_MS ?? 20000);
  await ensureWorld(prisma, process.env.WORLD_SEED ?? 'gce-alpha-1', interval);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down');
    await releaseLease(prisma, holder).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log('info', 'worker started', { holder, interval });
  let leader = false;
  let failures = 0;
  while (!stopping) {
    try {
      const got = await acquireLease(prisma, holder);
      if (got !== leader) log('info', got ? 'acquired leadership' : 'lost leadership');
      leader = got;
      if (!leader) {
        await sleep(5000);
        continue;
      }
      const w = await worldRow(prisma);
      const wait = w.lastTickAt.getTime() + w.tickIntervalMs - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 2000));
        continue;
      }
      const r = await processTick(prisma);
      failures = 0;
      log('info', 'tick', { tick: r.tick, ms: r.durationMs, phases: r.phases, counts: r.counts });
      if (r.durationMs > w.tickIntervalMs * 0.8) log('warn', 'tick is close to interval – consider scaling', { ms: r.durationMs });
    } catch (e) {
      failures++;
      log('error', 'tick failed', { error: (e as Error).message, stack: (e as Error).stack, failures });
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => {
  log('fatal', 'worker crashed', { error: (e as Error).message });
  process.exit(1);
});
