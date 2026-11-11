import { getPrisma } from '@gce/database';
import { ensureWorld, worldInfo } from '@gce/domain';
import { loadEnv, requireEnv } from './env';

/** Инициализация на света (идемпотентно). Не създава тестови играчи – за тях вижте seed-demo. */
async function main() {
  loadEnv();
  requireEnv('DATABASE_URL');
  const prisma = getPrisma();
  await ensureWorld(prisma, process.env.WORLD_SEED ?? 'gce-alpha-1', Number(process.env.TICK_INTERVAL_MS ?? 20000));
  console.log('World ready:', await worldInfo(prisma));
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
