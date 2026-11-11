// Използване: node scripts/db-backup.mjs [файл]   (DATABASE_URL от средата или .env)
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { backup } from './backup-lib.mjs';
import { loadEnv } from './env.mjs';

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL липсва');
mkdirSync('backups', { recursive: true });
const file = resolve(process.argv[2] ?? `backups/gce-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
const r = await backup(url, file);
console.log(`Резервно копие: ${r.file} (${r.tables} таблици, ${r.rows} реда, ${r.createdAt})`);
