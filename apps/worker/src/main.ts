import { getPrisma } from '@gce/database';
import { ensureWorld, runSimulationLoop } from '@gce/domain';
import { loadEnv, requireEnv } from './env';

loadEnv();
requireEnv('DATABASE_URL');

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, svc: 'worker', msg, ...extra }));

/**
 * Симулационен worker: изпълнява игровите тикове по централния часовник (виж runSimulationLoop).
 * Светът продължава, когато играчите са офлайн.
 */
async function main() {
  const prisma = getPrisma();
  const interval = Number(process.env.GAME_DAY_MS ?? 1000);
  await ensureWorld(prisma, process.env.WORLD_SEED ?? 'gce-alpha-1', interval);
  const sim = runSimulationLoop(prisma, log);
  log('info', 'worker started', { interval });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down');
    await sim.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  log('fatal', 'worker crashed', { error: (e as Error).message });
  process.exit(1);
});
