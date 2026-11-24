/**
 * Магистрали между градовете. Кметът плаща от бюджета на града си; магистралата важи и в двете посоки:
 * превозът на стоки между двата града е по-евтин и по-бърз (множител BALANCE.links.shippingMult).
 */
import { BALANCE, type TileMap } from '@gce/shared';
import { Prisma, isUniqueViolation, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, transfer } from './ledger';
import { idempotent } from './idempotency';
import { cityDistance, currentTick, worldGen } from './world';
import { lockCity } from './cities';
import { logEvent } from './events';
import { loadCityHeavy } from './cityCache';

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * Проверка на начертаното трасе: последователни съседни плочки (без диагонали), извън територията на който и да
 * е град, на суша или над река/езеро (мост), не в открито море; началото опира в единия град, краят – в другия.
 * Цена: `costPerTile` × теренен множител на всяка плочка (река ×4, планина ×3 – тунел…).
 */
export async function checkRoute(tx: Tx | PrismaClient, fromCityId: string, toCityId: string, path: { x: number; y: number }[]) {
  const S = BALANCE.world.parcelSize;
  const maxTiles = BALANCE.links.maxLength * 2;
  if (path.length > maxTiles) throw bad(`Трасето е твърде дълго (максимум ${maxTiles} плочки)`);
  const seen = new Set<string>();
  const pk = (x: number, y: number) => `${Math.floor(x / S)},${Math.floor(y / S)}`;
  for (let i = 0; i < path.length; i++) {
    const k = `${path[i].x},${path[i].y}`;
    if (seen.has(k)) throw bad('Трасето минава два пъти през една и съща плочка');
    seen.add(k);
    if (i > 0 && Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y) !== 1) throw bad('Трасето трябва да е непрекъснато (съседни плочки, без диагонали)');
  }
  const parcels = await tx.parcel.findMany({
    where: { OR: [...new Set(path.flatMap((p) => [-1, 0, 1].flatMap((d) => [pk(p.x + d, p.y), pk(p.x, p.y + d)])))].map((k) => {
      const [px, py] = k.split(',').map(Number);
      return { px, py };
    }) },
    select: { px: true, py: true, cityId: true },
  });
  const owner = new Map(parcels.map((p) => [`${p.px},${p.py}`, p.cityId]));
  const cityAt = (x: number, y: number) => owner.get(pk(x, y));
  for (const p of path) if (cityAt(p.x, p.y)) throw bad('Магистралата между градовете минава извън териториите на градовете – вътре строете градски път');
  const touches = (p: { x: number; y: number }, id: string) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => cityAt(p.x + dx, p.y + dy) === id);
  const first = path[0];
  const last = path[path.length - 1];
  const ok = (touches(first, fromCityId) && touches(last, toCityId)) || (touches(first, toCityId) && touches(last, fromCityId));
  if (!ok) throw bad('Трасето трябва да започва точно до вашия град и да стига точно до другия град');
  const gen = await worldGen(tx);
  let cost = 0;
  for (const p of path) {
    const m = gen.roadCostMult(p.x, p.y);
    if (!Number.isFinite(m)) throw bad('Магистрала не може да минава през открито море или извън България');
    cost += Math.round(BALANCE.links.costPerTile * m);
  }
  return { route: path.map((p) => [p.x, p.y] as [number, number]), cost };
}

/** Цена на магистрала с дадена дължина (центове). */
export function linkCost(length: number) {
  return Math.round(length * BALANCE.links.costPerTile);
}

export async function buildLink(
  prisma: PrismaClient,
  userId: string,
  cityId: string,
  toCityId: string,
  idemKey?: string,
  path?: { x: number; y: number }[],
) {
  if (cityId === toCityId) throw bad('Изберете друг град');
  try {
    return await withTx(prisma, (tx) =>
      idempotent(tx, userId, idemKey ? `link:${idemKey}` : undefined, async () => {
        const city = await lockCity(tx, cityId);
        if (city.ownerId !== userId) throw forbidden('Само кметът може да строи магистрали');
        const other = await tx.city.findUnique({ where: { id: toCityId } });
        if (!other) throw notFound('Градът не съществува');
        const [aId, bId] = pair(cityId, toCityId);
        if (await tx.cityLink.findUnique({ where: { aId_bId: { aId, bId } } })) throw conflict('Двата града вече са свързани');
        let length = Math.max(1, Math.round(cityDistance(city, other)));
        let cost = linkCost(length);
        let route: [number, number][] = [];
        if (path?.length) {
          // трасе, начертано от кмета – проверка и цена по терена (мостове и тунели струват повече)
          const r = await checkRoute(tx, cityId, toCityId, path);
          route = r.route;
          length = route.length;
          cost = r.cost;
        } else if (length > BALANCE.links.maxLength) throw bad(`Градът е твърде далеч (максимум ${BALANCE.links.maxLength} плочки)`);
        const tick = await currentTick(tx);
        await tx.cityLink.create({ data: { aId, bId, builtById: userId, length, cost: BigInt(cost), createdTick: tick, path: route as unknown as Prisma.InputJsonValue } });
        await transfer(tx, {
          from: acc.city(cityId),
          to: SYS.WORLD,
          amount: cost,
          kind: 'CONSTRUCTION',
          tick,
          key: `link:${aId}:${bId}`,
          refType: 'City',
          refId: cityId,
          memo: `магистрала до ${other.name}`,
        });
        const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(cityId) } });
        if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', `Недостатъчно средства в бюджета (нужни ${(cost / 100).toFixed(0)} €)`, 402);
        await logEvent(tx, { tick, kind: 'city_link', message: `Магистрала свързва „${city.name}“ и „${other.name}“`, cityId, userId });
        return { aId, bId, length, cost };
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Двата града вече са свързани');
    throw e;
  }
}

/** Всички магистрали (за картата): краищата са центровете на градовете. */
export async function listLinks(prisma: PrismaClient | Tx) {
  const links = await prisma.cityLink.findMany({ orderBy: { createdAt: 'asc' } });
  if (!links.length) return [];
  const ids = [...new Set(links.flatMap((l) => [l.aId, l.bId]))];
  const cities = await prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, originX: true, originY: true, version: true } });
  const byId = new Map(cities.map((c) => [c.id, c]));
  const heavy = new Map<string, Awaited<ReturnType<typeof loadCityHeavy>>>();
  for (const c of cities) heavy.set(c.id, await loadCityHeavy(prisma as PrismaClient, c.id, c.version));
  const end = (c: { id: string; originX: number; originY: number }, toward: { originX: number; originY: number }) =>
    linkEnd(heavy.get(c.id)?.tiles as TileMap | undefined, heavy.get(c.id)?.parcels ?? [], c, toward);
  return links
    .filter((l) => byId.has(l.aId) && byId.has(l.bId))
    .map((l) => {
      const a = byId.get(l.aId)!;
      const b = byId.get(l.bId)!;
      return {
        id: l.id,
        a: { id: a.id, name: a.name, originX: a.originX, originY: a.originY, ...end(a, b) },
        b: { id: b.id, name: b.name, originX: b.originX, originY: b.originY, ...end(b, a) },
        length: l.length,
        cost: Number(l.cost),
        path: (l.path as unknown as [number, number][]) ?? [],
      };
    });
}

/**
 * Къде магистралата влиза в града: „вход“ (gate) – точка точно извън територията в посока към другия град
 * (там е пътният възел), и „изход“ (exit) – най-добрият път на града (магистрала/булевард/улица), най-близо
 * до другия град, с който възелът се свързва с рампа. Без пътища – центърът на ръба на територията.
 */
export function linkEnd(
  tiles: TileMap | undefined,
  parcels: { px: number; py: number }[],
  c: { originX: number; originY: number },
  toward: { originX: number; originY: number },
): { gate: { x: number; y: number }; exit: { x: number; y: number }; branch: { x: number; y: number } | null } {
  const S = BALANCE.world.parcelSize;
  const own = new Set(parcels.map((p) => `${p.px},${p.py}`));
  const inside = (x: number, y: number) => own.has(`${Math.floor(x / S)},${Math.floor(y / S)}`);
  const rank: Record<string, number> = { highway: 0, avenue: 1, industrial: 2, street: 3, rural: 4 };
  let exit = { x: c.originX, y: c.originY };
  let best = Infinity;
  for (const [k, t] of Object.entries(tiles ?? {})) {
    if (t.t !== 'road') continue;
    const [x, y] = k.split(',').map(Number);
    const d = Math.hypot(toward.originX - x, toward.originY - y) + (rank[t.c ?? 'street'] ?? 3) * 3;
    if (d < best) {
      best = d;
      exit = { x, y };
    }
  }
  // разклонение: втори път в града (поне на 4 плочки от главния вход), към който магистралата се разделя
  let branch: { x: number; y: number } | null = null;
  let bestB = Infinity;
  for (const [k, t] of Object.entries(tiles ?? {})) {
    if (t.t !== 'road') continue;
    const [x, y] = k.split(',').map(Number);
    if (Math.hypot(x - exit.x, y - exit.y) < 4) continue;
    // встрани от главната посока (иначе не е разклонение, а същият път)
    const mx = toward.originX - exit.x;
    const my = toward.originY - exit.y;
    const ml = Math.hypot(mx, my) || 1;
    if (Math.abs(((x - exit.x) * my - (y - exit.y) * mx) / ml) < 2) continue;
    const d = Math.hypot(toward.originX - x, toward.originY - y) + (rank[t.c ?? 'street'] ?? 3) * 3;
    if (d < bestB) {
      bestB = d;
      branch = { x, y };
    }
  }
  // от изхода към другия град – до първата точка извън територията
  const dx = toward.originX - exit.x;
  const dy = toward.originY - exit.y;
  const L = Math.max(1, Math.hypot(dx, dy));
  let gate = { ...exit };
  if (parcels.length)
    for (let s = 0; s < 200; s++) {
      const x = Math.round(exit.x + (dx / L) * s);
      const y = Math.round(exit.y + (dy / L) * s);
      gate = { x, y };
      if (!inside(x, y)) break;
    }
  // възелът – малко извън границата
  gate = { x: Math.round(gate.x + (dx / L) * 2), y: Math.round(gate.y + (dy / L) * 2) };
  return { gate, exit, branch };
}

/** Множител на превоза между два града (по-евтино при магистрала). */
export async function linkShippingMult(tx: PrismaClient | Tx, fromCityId: string, toCityId: string): Promise<number> {
  if (fromCityId === toCityId) return 1;
  const [aId, bId] = pair(fromCityId, toCityId);
  const l = await tx.cityLink.findUnique({ where: { aId_bId: { aId, bId } } });
  return l ? BALANCE.links.shippingMult : 1;
}
