// Логическо резервно копие и възстановяване на базата (без зависимост от pg_dump).
// В production се препоръчва и управлявано резервно копие на платформата + pg_dump (виж docs/deployment).
import pg from 'pg';
import { createGzip, gunzipSync } from 'node:zlib';
import { createWriteStream, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// Ред на вмъкване, съобразен с външните ключове (родителите първо).
const FIRST = ['User', 'Proposal', 'City'];

async function tables(client) {
  const r = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const names = r.rows.map((x) => x.tablename);
  return [...FIRST.filter((t) => names.includes(t)), ...names.filter((t) => !FIRST.includes(t))];
}

/** Създава резервно копие (gzip JSON) и връща метаданни. */
export async function backup(databaseUrl, file) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // консистентен снимък
    const out = { format: 'gce-logical-backup', version: 1, createdAt: new Date().toISOString(), tables: {} };
    let rows = 0;
    for (const t of await tables(client)) {
      const r = await client.query(`SELECT COALESCE(json_agg(x), '[]'::json) AS rows FROM "${t}" x`);
      out.tables[t] = r.rows[0].rows;
      rows += out.tables[t].length;
    }
    await client.query('COMMIT');
    await pipeline(Readable.from([JSON.stringify(out)]), createGzip(), createWriteStream(file));
    return { file, tables: Object.keys(out.tables).length, rows, createdAt: out.createdAt };
  } finally {
    await client.end();
  }
}

/** Възстановява резервно копие в празна или съществуваща база със същата схема (всичко в една транзакция). */
export async function restore(databaseUrl, file) {
  const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  if (data.format !== 'gce-logical-backup') throw new Error('Непознат формат на резервното копие');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await tables(client);
    const missing = Object.keys(data.tables).filter((t) => !existing.includes(t));
    if (missing.length) throw new Error(`Схемата не съвпада (липсват таблици: ${missing.join(', ')}). Първо изпълнете миграциите.`);
    await client.query(`TRUNCATE ${existing.map((t) => `"${t}"`).join(',')} CASCADE`);
    let rows = 0;
    for (const t of existing) {
      const list = data.tables[t] ?? [];
      for (let i = 0; i < list.length; i += 2000) {
        const chunk = list.slice(i, i + 2000);
        await client.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, [JSON.stringify(chunk)]);
        rows += chunk.length;
      }
      // Синхронизиране на автоматичните броячи.
      const col = await client.query(
        `SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
        [t],
      );
      if (!String(col.rows[0]?.column_default ?? '').startsWith('nextval')) continue;
      const seq = await client.query(`SELECT pg_get_serial_sequence('"${t}"', 'id') AS s`);
      if (seq.rows[0]?.s)
        await client.query(`SELECT setval($1, GREATEST(1, (SELECT COALESCE(MAX(id), 0) FROM "${t}")), (SELECT COUNT(*) > 0 FROM "${t}"))`, [seq.rows[0].s]);
    }
    await client.query('COMMIT');
    return { rows, tables: existing.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}
