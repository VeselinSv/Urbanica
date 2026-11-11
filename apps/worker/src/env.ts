import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Минимален .env зареждач (без външна зависимост). Променливите от средата имат предимство. */
export function loadEnv(): void {
  for (const dir of [process.cwd(), resolve(__dirname, '../../..')]) {
    const file = resolve(dir, '.env');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return;
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
