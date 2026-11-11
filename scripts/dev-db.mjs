// Стартира локален PostgreSQL сървър (embedded-postgres) за разработка и тестове.
// Използва се само когато няма Docker/инсталиран PostgreSQL. В production се използва управлявана база.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';

const dataDir = resolve(process.env.PG_DATA_DIR ?? '.data/pg');
const port = Number(process.env.PG_PORT ?? 5433);
const user = 'gce';
const password = 'gce_dev_password';

const busy = await new Promise((ok) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => {
    s.destroy();
    ok(true);
  });
  s.once('error', () => ok(false));
});
if (busy) {
  console.log(`[dev-db] Порт ${port} вече е зает – PostgreSQL вероятно вече работи (в друг терминал). Нищо ново не е стартирано.`);
  process.exit(0);
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  onLog: () => {},
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});
const firstRun = !existsSync(resolve(dataDir, 'PG_VERSION'));
if (firstRun) {
  console.log('[dev-db] initialising cluster in', dataDir);
  await pg.initialise();
}
try {
  await pg.start();
} catch (e) {
  console.error('[dev-db] PostgreSQL не успя да стартира:', e ?? '(без съобщение – проверете за останал .data/pg/postmaster.pid от спрял процес)');
  process.exit(1);
}
for (const db of ['gce', 'gce_test']) {
  try {
    await pg.createDatabase(db);
    console.log('[dev-db] created database', db);
  } catch {
    /* exists */
  }
}
console.log(`[dev-db] PostgreSQL ready: postgresql://${user}:${password}@localhost:${port}/gce`);
const stop = async () => {
  console.log('[dev-db] stopping');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
