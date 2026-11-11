// Тест при натоварване срещу работещ API.
// Използване: node scripts/load-test.mjs [baseUrl] [виртуални потребители] [секунди]
// Пример: node scripts/load-test.mjs http://localhost:3000 40 20
// Всеки виртуален потребител се регистрира, основава град и изпълнява смес от четене и запис.
const base = (process.argv[2] ?? 'http://localhost:3000') + '/api';
const users = Number(process.argv[3] ?? 30);
const seconds = Number(process.argv[4] ?? 20);
const run = Math.random().toString(36).slice(2, 7);

const lat = [];
const byKind = {};
let errors = 0;
let rateLimited = 0;

async function call(kind, method, path, token, body) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    await res.text();
    const ms = performance.now() - t0;
    lat.push(ms);
    (byKind[kind] ??= []).push(ms);
    if (res.status === 429) rateLimited++;
    else if (res.status >= 500) errors++;
    return res.status;
  } catch {
    errors++;
    return 0;
  }
}

async function setup(i) {
  const r = await fetch(base + '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `load_${run}_${i}`, email: `load_${run}_${i}@load.test`, password: 'load-password-1' }),
  });
  if (!r.ok) return null;
  const { token } = await r.json();
  const c = await fetch(base + '/cities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `Load ${i}` }),
  });
  if (!c.ok) return { token, city: null };
  return { token, city: await c.json() };
}

async function vu(state, until) {
  let step = 0;
  while (Date.now() < until) {
    const { token, city } = state;
    const r = step++ % 6;
    if (r === 0) await call('world', 'GET', '/world', token);
    else if (r === 1 && city) await call('city', 'GET', `/cities/${city.id}`, token);
    else if (r === 2 && city)
      await call('region', 'GET', `/world/region?x0=${city.originX - 40}&y0=${city.originY - 40}&x1=${city.originX + 40}&y1=${city.originY + 40}`, token);
    else if (r === 3) await call('market', 'GET', '/market/summary', token);
    else if (r === 4 && city)
      await call('build', 'POST', `/cities/${city.id}/build`, token, {
        action: 'road',
        tiles: [{ x: city.originX - 10 + (step % 20), y: city.originY + (step % 7) }],
      });
    else await call('book', 'GET', '/market/book/GOOD:food', token);
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
};

console.log(`Подготовка на ${users} виртуални потребители…`);
const states = [];
for (let i = 0; i < users; i += 5) states.push(...(await Promise.all(Array.from({ length: Math.min(5, users - i) }, (_, k) => setup(i + k)))));
const ready = states.filter(Boolean);
console.log(`Готови: ${ready.length}; натоварване за ${seconds} s…`);
const t0 = Date.now();
await Promise.all(ready.map((s) => vu(s, t0 + seconds * 1000)));
const dur = (Date.now() - t0) / 1000;
console.log(`Заявки: ${lat.length}, пропускателна способност: ${(lat.length / dur).toFixed(1)} заявки/s`);
console.log(`Латентност ms: p50=${pct(lat, 0.5)} p95=${pct(lat, 0.95)} p99=${pct(lat, 0.99)} max=${pct(lat, 0.9999)}`);
console.log(`Грешки 5xx/мрежа: ${errors}, ограничени (429): ${rateLimited}`);
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(7)} n=${String(v.length).padStart(5)} p50=${pct(v, 0.5)} p95=${pct(v, 0.95)}`);
