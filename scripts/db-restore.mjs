// Използване: node scripts/db-restore.mjs <файл> --yes   (ЗАМЕНЯ всички данни в DATABASE_URL!)
import { resolve } from 'node:path';
import { restore } from './backup-lib.mjs';
import { loadEnv } from './env.mjs';

loadEnv();
const url = process.env.DATABASE_URL;
const file = process.argv[2];
if (!url || !file) throw new Error('Използване: node scripts/db-restore.mjs <файл> --yes');
if (!process.argv.includes('--yes')) {
  console.error('Възстановяването изтрива текущите данни. Спрете API и worker и добавете --yes за потвърждение.');
  process.exit(2);
}
const r = await restore(url, resolve(file));
console.log(`Възстановени ${r.rows} реда в ${r.tables} таблици.`);
