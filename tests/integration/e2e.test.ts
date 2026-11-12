import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { processTick } from '@gce/domain';
import { BALANCE, ECON, PRICE } from '@gce/shared';
import { prisma, resetDb } from './helpers';

/**
 * End-to-end сценарий през истинския HTTP API (компилиран NestJS процес) – стъпки 1–13 от спецификацията.
 * Времето се придвижва с processTick (същата функция, която изпълнява worker-ът).
 */
const PORT = 3199;
const BASE = `http://localhost:${PORT}/api`;
let api: ChildProcess | null = null;

async function startApi() {
  api = spawn(process.execPath, [resolve(__dirname, '../../apps/api/dist/main.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: process.env.DATABASE_URL,
      WORLD_SEED: 'integration-seed',
      CORS_ORIGINS: 'http://localhost',
      NODE_ENV: 'test',
      DEV_EXPOSE_RESET_TOKEN: 'false',
      RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* стартира */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('API не стартира');
}
async function stopApi() {
  if (!api) return;
  const p = api;
  api = null;
  await new Promise<void>((r) => {
    p.once('exit', () => r());
    p.kill();
  });
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function ticks(n: number) {
  for (let i = 0; i < n; i++) await processTick(prisma);
}

beforeAll(async () => {
  await resetDb();
  await startApi();
});
afterAll(async () => {
  await stopApi();
});

describe('E2E: пълен път на играча', () => {
  const A = { token: '', id: '', cityId: '', companyId: '', ox: 0, oy: 0 };
  const B = { token: '', id: '', cityId: '', companyId: '' };

  it('1–2. играта създава автоматичен играч без регистрация', async () => {
    const l = await call<{ token: string; user: { id: string } }>('POST', '/auth/guest');
    expect(l.status).toBe(201);
    A.token = l.data.token;
    A.id = l.data.user.id;
    const me = await call<{ wallet: number }>('GET', '/auth/me', A.token);
    expect(me.data.wallet).toBe(BALANCE.start.wallet);
    expect((await call('GET', '/auth/me')).status).toBe(401);
    const b = await call<{ token: string; user: { id: string } }>('POST', '/auth/guest');
    B.token = b.data.token;
    B.id = b.data.user.id;
    // регистрацията и входът с парола не съществуват
    expect((await call('POST', '/auth/register', undefined, { username: 'x', email: 'a@b.cd', password: '12345678' })).status).toBe(404);
    expect((await call('POST', '/auth/login', undefined, { login: 'x', password: 'x' })).status).toBe(404);
  });

  it('3. получава начална територия и ограничен капитал', async () => {
    const r = await call<{ id: string }>('POST', '/cities', A.token, { name: 'Е2Е Град' });
    expect(r.status).toBe(201);
    A.cityId = r.data.id;
    const c = await call<{ treasury: number; parcels: { px: number; py: number }[]; name: string }>('GET', `/cities/${A.cityId}`, A.token);
    expect(c.data.name).toBe('Е2Е Град');
    expect(c.data.treasury).toBe(BALANCE.start.cityTreasury);
    expect(c.data.parcels.length).toBe(9);
    A.ox = Math.min(...c.data.parcels.map((p) => p.px)) * 8;
    A.oy = Math.min(...c.data.parcels.map((p) => p.py)) * 8;
    const pub = await call<{ treasury?: number }>('GET', `/cities/${A.cityId}`, B.token);
    expect(pub.data.treasury).toBeUndefined(); // поверително за чужд играч
    B.cityId = (await call<{ id: string }>('POST', '/cities', B.token, { name: 'Bobville' })).data.id;
  });

  it('4–5. строи път и определя жилищна и индустриална зона', async () => {
    const { ox, oy } = A;
    const { getWorld } = await import('@gce/world-generation');
    const w = getWorld('integration-seed');
    // Територията може да съдържа плочки на национален път или вода – те не са строителна площ.
    const land = (t: { x: number; y: number }) => w.buildable(t.x, t.y);
    const road = Array.from({ length: 24 }, (_, i) => ({ x: ox + i, y: oy + 10 })).filter(land);
    const r = await call<{ applied: number }>('POST', `/cities/${A.cityId}/build`, A.token, { action: 'road', tiles: road }, { 'idempotency-key': 'road-1' });
    expect(r.status).toBe(201);
    expect(r.data.applied).toBeGreaterThan(10);
    const again = await call<{ applied: number }>(
      'POST',
      `/cities/${A.cityId}/build`,
      A.token,
      { action: 'road', tiles: road },
      { 'idempotency-key': 'road-1' },
    );
    expect(again.data.applied).toBe(r.data.applied); // идемпотентен отговор
    const R = Array.from({ length: 16 }, (_, i) => ({ x: ox + i, y: oy + 9 })).filter(land);
    const I = Array.from({ length: 10 }, (_, i) => ({ x: ox + i, y: oy + 11 })).filter(land);
    expect((await call('POST', `/cities/${A.cityId}/build`, A.token, { action: 'zone', zone: 'R', tiles: R })).status).toBe(201);
    expect((await call('POST', `/cities/${A.cityId}/build`, A.token, { action: 'zone', zone: 'I', tiles: I })).status).toBe(201);
    expect((await call('POST', `/cities/${A.cityId}/build`, B.token, { action: 'road', tiles: [{ x: ox, y: oy }] })).status).toBe(403);
    expect((await call('POST', `/cities/${A.cityId}/build`, A.token, { action: 'teleport', tiles: [] })).status).toBe(400);
  });

  it('6–8. инфраструктура, първи предприятия, население и работници', async () => {
    const { ox, oy } = A;
    const { getWorld: gw } = await import('@gce/world-generation');
    const wg = gw('integration-seed');
    // свободни плочки до пътя (след индустриалната зона), годни за строеж
    const spots = Array.from({ length: 12 }, (_, i) => ({ x: ox + 12 + i, y: oy + 11 })).filter((t) => wg.buildable(t.x, t.y) && wg.buildable(t.x, t.y - 1));
    expect(spots.length).toBeGreaterThanOrEqual(2);
    for (const [svc, t] of [
      ['power_wind', spots[0]],
      ['water_pump', spots[spots.length - 1]],
    ] as const) {
      const r = await call('POST', `/cities/${A.cityId}/build`, A.token, { action: 'service', service: svc, tiles: [t] });
      expect(r.status).toBe(201);
    }
    const co = await call<{ id: string }>('POST', '/companies', A.token, { name: 'Alice Agro', hqCityId: A.cityId, capital: 2_000_000 * ECON });
    expect(co.status).toBe(201);
    A.companyId = co.data.id;
    // Ферма на плодородна плочка до пътя.
    const { getWorld } = await import('@gce/world-generation');
    const w = getWorld('integration-seed');
    let placed = false;
    for (let x = 0; x < 24 && !placed; x++)
      for (const dy of [8, 12]) {
        if (placed) break;
        const tx = ox + x;
        const ty = oy + dy;
        if (w.tileAt(tx, ty).fertility < 0.3) continue;
        const r = await call('POST', `/companies/${A.companyId}/facilities`, A.token, { cityId: A.cityId, type: 'farm', x: tx, y: ty });
        if (r.status === 201) placed = true;
      }
    if (!placed) {
      const spot = Array.from({ length: 24 }, (_, i) => ({ x: ox + i, y: oy + 12 })).find((t) => w.buildable(t.x, t.y))!;
      const r = await call('POST', `/companies/${A.companyId}/facilities`, A.token, { cityId: A.cityId, type: 'warehouse', x: spot.x, y: spot.y });
      expect(r.status).toBe(201);
    }
    await ticks(25);
    const c = await call<{ stats: { population: number; employed: number[]; buildings: Record<string, number>; power: { supply: number } } }>(
      'GET',
      `/cities/${A.cityId}`,
      A.token,
    );
    expect(c.data.stats.power.supply).toBeGreaterThan(0);
    expect(c.data.stats.buildings.R).toBeGreaterThan(0);
    expect(c.data.stats.population).toBeGreaterThan(0);
    expect(c.data.stats.employed.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const company = await call<{ facilitiesDetail: { staffing: number; lastRuns: number; type: string }[]; inventory: { good: string; quantity: number }[] }>(
      'GET',
      `/companies/${A.companyId}`,
      A.token,
    );
    if (placed) {
      expect(company.data.facilitiesDetail[0].staffing).toBeGreaterThan(0);
      expect(company.data.inventory.find((i) => i.good === 'grain')?.quantity ?? 0).toBeGreaterThan(0);
    }
  });

  it('9–10. произвежда ресурси и търгува с друг играч', async () => {
    const coB = await call<{ id: string }>('POST', '/companies', B.token, { name: 'Bob Foods', hqCityId: B.cityId, capital: 2_000_000 * ECON });
    B.companyId = coB.data.id;
    // Ако фермата не е намерила място, даваме тестова наличност чрез вътрешния слой.
    const inv = await prisma.inventory.findFirst({ where: { companyId: A.companyId, good: 'grain' } });
    if (!inv || inv.quantity < 20) {
      const { withTx } = await import('@gce/database');
      const { addGoods } = await import('@gce/domain');
      await withTx(prisma, (tx) => addGoods(tx, A.companyId, A.cityId, 'grain', 50, 300 * PRICE));
    }
    const sell = await call<{ order: { id: string } }>(
      'POST',
      '/market/orders',
      A.token,
      { instrument: 'GOOD:grain', side: 'SELL', quantity: 20, price: 450 * PRICE, companyId: A.companyId, cityId: A.cityId },
      { 'idempotency-key': 'sell-1' },
    );
    expect(sell.status).toBe(201);
    const buy = await call<{ fills: { quantity: number; price: number }[] }>('POST', '/market/orders', B.token, {
      instrument: 'GOOD:grain',
      side: 'BUY',
      quantity: 20,
      price: 500 * PRICE,
      companyId: B.companyId,
      cityId: B.cityId,
    });
    expect(buy.status).toBe(201);
    expect(buy.data.fills).toEqual([{ quantity: 20, price: 450 * PRICE }]);
    const book = await call<{ trades: { kind: string; quantity: number }[] }>('GET', '/market/book/GOOD:grain');
    expect(book.data.trades.some((t) => t.kind === 'BOOK' && t.quantity === 20)).toBe(true);
    // Чужд играч не може да отмени поръчка.
    const orders = await call<{ id: string }[]>('GET', '/market/orders', A.token);
    for (const o of orders.data) expect((await call('DELETE', `/market/orders/${o.id}`, B.token)).status).toBe(403);
  });

  it('11. използва финансов инструмент (кредит за града)', async () => {
    const offer = await call<{ maxAmount: number; annualRate: number; rating: string }>('GET', `/bank/offer?type=CITY&id=${A.cityId}`, A.token);
    expect(offer.data.maxAmount).toBeGreaterThan(0);
    const amount = Math.min(1_000_000, offer.data.maxAmount);
    const before = (await call<{ treasury: number }>('GET', `/cities/${A.cityId}`, A.token)).data.treasury;
    const loan = await call<{ id: string; payment: number }>('POST', '/bank/loans', A.token, {
      borrowerType: 'CITY',
      borrowerId: A.cityId,
      amount,
      termDays: 360,
    });
    expect(loan.status).toBe(201);
    const after = (await call<{ treasury: number }>('GET', `/cities/${A.cityId}`, A.token)).data.treasury;
    expect(after - before).toBe(amount);
    expect((await call('POST', '/bank/loans', B.token, { borrowerType: 'CITY', borrowerId: A.cityId, amount: 1000, termDays: 90 })).status).toBe(403);
  });

  it('WebSocket: клиентът получава събитие за нов тик', async () => {
    const socket = io(`http://localhost:${PORT}`, { path: '/socket.io', auth: { token: A.token }, transports: ['websocket'] });
    await new Promise<void>((r, j) => {
      socket.on('connect', () => r());
      socket.on('connect_error', j);
    });
    const got = new Promise<{ tick: number }>((r) => socket.on('tick', r));
    await processTick(prisma);
    const ev = await Promise.race([got, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    socket.disconnect();
    expect(ev?.tick).toBeGreaterThan(0);
  });

  it('12–13. играчът затваря играта; светът продължава офлайн; след рестарт на сървъра прогресът е запазен', async () => {
    const before = await call<{ stats: { tick: number; population: number }; treasury: number }>('GET', `/cities/${A.cityId}`, A.token);
    // Играчът е офлайн: отбелязваме последната активност като стара -> обобщена (адаптивна) симулация.
    await prisma.user.update({ where: { id: A.id }, data: { lastActiveAt: new Date(Date.now() - 3600_000) } });
    await ticks(12);
    await stopApi();
    await startApi(); // рестарт на сървъра – състоянието идва от базата
    const l = { data: { token: A.token } }; // същата сесия от браузъра
    const after = await call<{ stats: { tick: number; population: number }; treasury: number }>('GET', `/cities/${A.cityId}`, l.data.token);
    expect(after.data.stats.tick).toBeGreaterThan(before.data.stats.tick);
    expect(after.data.treasury).not.toBe(before.data.treasury);
    const hist = await call<{ series: unknown[] }>('GET', `/cities/${A.cityId}/history`, l.data.token);
    // точка в историята се пише на всеки 5 игрови дни (и при всяка пакетна обработка офлайн)
    expect(hist.data.series.length).toBeGreaterThan(4);
  });

  it('сигурност: ограничаване на честотата и грешни данни', async () => {
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await call('POST', '/auth/guest')).status);
    expect(results).toContain(429);
    expect((await call('GET', '/cities/doesnotexist', B.token)).status).toBe(404);
    expect((await call('POST', '/market/orders', B.token, { instrument: "GOOD:coal'; DROP TABLE", side: 'BUY', quantity: 1, price: 1 })).status).toBe(400);
  });
});
