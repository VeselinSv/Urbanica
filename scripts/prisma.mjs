// Изпълнява Prisma CLI от корена на проекта, като зарежда DATABASE_URL от .env.
// Използване: node scripts/prisma.mjs migrate deploy
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnv } from './env.mjs';

loadEnv();
// `generate` не се свързва с базата – при билд (напр. Docker) адресът може да липсва.
if (!process.env.DATABASE_URL && process.argv[2] === 'generate') process.env.DATABASE_URL = 'postgresql://build:build@localhost:5432/build';
if (!process.env.DATABASE_URL) {
  console.error('[prisma] Липсва DATABASE_URL. Копирайте .env.example в .env (Windows: copy .env.example .env).');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const cli = require.resolve('prisma/build/index.js');
const args = [cli, ...process.argv.slice(2), '--schema', 'packages/database/prisma/schema.prisma'];
const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
if (r.status !== 0 && process.argv[2] === 'generate') {
  console.error('[prisma] Ако грешката е EPERM: спрете работещите API/worker процеси (те държат заредена библиотеката на Prisma) и опитайте отново.');
}
process.exit(r.status ?? 1);
