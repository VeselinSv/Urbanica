import {
  BALANCE,
  SIDEWALK_BY_DEFAULT,
  hasSidewalk,
  SERVICES,
  hashString,
  parseKey,
  tileKey,
  type BuildInput,
  type CityPolicy,
  type PolicyInput,
  type PopulationState,
  type TileMap,
  type TileState,
  ZONES,
} from '@gce/shared';
import { isWater } from '@gce/world-generation';
import { Prisma, isUniqueViolation, withTx, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, conflict, forbidden, notFound } from './errors';
import { SYS, acc, ensureAccount, transfer } from './ledger';
import { idempotent } from './idempotency';
import { currentTick, territoryKeys, worldGen } from './world';
import { logEvent, notify } from './events';
import { loadCityHeavy } from './cityCache';

export function defaultPolicy(): CityPolicy {
  return {
    taxes: { ...BALANCE.taxes.defaults },
    serviceBudget: 1,
    subsidies: {},
    powerTariff: BALANCE.utilities.defaultPowerTariff,
    waterTariff: BALANCE.utilities.defaultWaterTariff,
    importTariff: 0,
    sanctions: [],
    powerPriority: ['services', 'facilities', 'zones'],
  };
}

export function initialPopulation(): PopulationState {
  return { edu: [0, 0, 0], schoolProgress: 0, universityProgress: 0, wages: [...BALANCE.wages.base] as [number, number, number], happiness: 0.6 };
}

/** Заключва реда на града (FOR UPDATE) – сериализира редакциите на играча и симулацията. */
export async function lockCity(tx: Tx, cityId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "City" WHERE id = ${cityId} FOR UPDATE`;
  if (!rows.length) throw notFound('Градът');
  const city = await tx.city.findUniqueOrThrow({ where: { id: cityId }, include: { parcels: true } });
  return city;
}

/** Търси свободно място за нов град: 3x3 парцела, предимно суша, далеч от други градове. */
async function findSpot(prisma: PrismaClient | Tx, userId: string, hint?: { x: number; y: number }) {
  const gen = await worldGen(prisma);
  const s = BALANCE.world.parcelSize;
  const n = BALANCE.world.startParcels;
  const maxP = Math.floor(BALANCE.world.size / s);
  const cities = await prisma.city.findMany({ select: { originX: true, originY: true } });
  const owned = new Set((await prisma.parcel.findMany({ select: { px: true, py: true } })).map((p) => `${p.px},${p.py}`));
  const ok = (px0: number, py0: number) => {
    if (px0 < 1 || py0 < 1 || px0 + n >= maxP - 1 || py0 + n >= maxP - 1) return false;
    let land = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (owned.has(`${px0 + i},${py0 + j}`)) return false;
        land += gen.parcelProfile(px0 + i, py0 + j).land;
      }
    if (land / (n * n) < 0.8) return false;
    const cx = (px0 + n / 2) * s;
    const cy = (py0 + n / 2) * s;
    return cities.every((c) => Math.hypot(c.originX - cx, c.originY - cy) >= BALANCE.start.minDistanceBetweenCities);
  };
  let sx: number;
  let sy: number;
  if (hint) {
    sx = Math.floor(hint.x / s) - 1;
    sy = Math.floor(hint.y / s) - 1;
    if (ok(sx, sy)) return { px0: sx, py0: sy };
    // най-близкото подходящо място до избраната точка (до ~6 парцела)
    for (let r = 1; r <= 6; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (ok(sx + dx, sy + dy)) return { px0: sx + dx, py0: sy + dy };
        }
    const prof = gen.parcelProfile(Math.floor(hint.x / s), Math.floor(hint.y / s));
    throw bad(
      prof.inCountry < 0.5
        ? 'Градовете се основават само на територията на България'
        : prof.land < 0.5
          ? 'Мястото е във вода – изберете суша'
          : 'Наблизо няма свободно място (заето от друг град или твърде много вода) – изберете друго място',
    );
  } else {
    const h = hashString(userId);
    sx = Math.floor(maxP * 0.2 + (h % Math.floor(maxP * 0.6)));
    sy = Math.floor(maxP * 0.2 + ((h >>> 12) % Math.floor(maxP * 0.6)));
  }
  // Спирално търсене около началната точка.
  for (let r = 0; r < maxP; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (ok(sx + dx, sy + dy)) return { px0: sx + dx, py0: sy + dy };
      }
  }
  throw conflict('Няма свободно подходящо място в света');
}

export async function foundCity(prisma: PrismaClient, userId: string, name: string, hint?: { x: number; y: number }) {
  const spot = await findSpot(prisma, userId, hint);
  const n = BALANCE.world.startParcels;
  const s = BALANCE.world.parcelSize;
  try {
    return await withTx(prisma, async (tx) => {
      const tick = await currentTick(tx);
      const count = await tx.city.count({ where: { ownerId: userId } });
      const city = await tx.city.create({
        data: {
          name,
          ownerId: userId,
          originX: spot.px0 * s + Math.floor((n * s) / 2),
          originY: spot.py0 * s + Math.floor((n * s) / 2),
          pop: initialPopulation() as unknown as Prisma.InputJsonValue,
          policy: defaultPolicy() as unknown as Prisma.InputJsonValue,
          foundedTick: tick,
          lastTick: tick - 1,
        },
      });
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) await tx.parcel.create({ data: { px: spot.px0 + i, py: spot.py0 + j, cityId: city.id } });
      const cityAcc = await ensureAccount(tx, 'CITY', city.id, true);
      if (count === 0) {
        await transfer(tx, {
          from: SYS.MINT,
          to: cityAcc,
          amount: BALANCE.start.cityTreasury,
          kind: 'START_CAPITAL',
          key: `city-start:${city.id}`,
          tick,
          refType: 'City',
          refId: city.id,
        });
      } else {
        // Допълнителен град: финансира се от личния портфейл (без създаване на пари).
        await transfer(tx, {
          from: acc.user(userId),
          to: cityAcc,
          amount: BALANCE.start.additionalCityCost,
          kind: 'CITY_FOUNDING',
          key: `city-found:${city.id}`,
          tick,
          refType: 'City',
          refId: city.id,
        });
      }
      await logEvent(tx, { tick, kind: 'city_founded', message: `Основан е нов град „${name}“`, cityId: city.id, userId });
      return city;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Територията току-що беше заета от друг играч – опитайте отново');
    throw e;
  }
}

function buildCost(gen: Awaited<ReturnType<typeof worldGen>>, x: number, y: number, base: number): number {
  const m = gen.roadCostMult(x, y);
  return Number.isFinite(m) ? Math.round(base * m) : Infinity;
}

export interface BuildResult {
  applied: number;
  skipped: number;
  cost: number;
  reasons: string[];
  version: number;
}

/** Строителство в града: пътища, зониране, обществени сгради, събаряне. Сървърът валидира и таксува. */
export async function build(prisma: PrismaClient, userId: string, cityId: string, input: BuildInput, idemKey?: string): Promise<BuildResult> {
  const gen = await worldGen(prisma);
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `build:${idemKey}` : undefined, async () => {
      const city = await lockCity(tx, cityId);
      if (city.ownerId !== userId) throw forbidden('Само кметът (собственикът) може да строи в града');
      const tick = await currentTick(tx);
      const territory = new Set(territoryKeys(city.parcels));
      const before = city.tiles as unknown as TileMap;
      const tiles = { ...before };
      let cost = 0;
      let applied = 0;
      const reasons = new Set<string>();
      const seen = new Set<string>();
      for (const { x, y } of input.tiles) {
        const k = tileKey(x, y);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!territory.has(k)) {
          reasons.add('Плочката е извън територията на града');
          continue;
        }
        const cur = tiles[k];
        const terrain = gen.tileAt(x, y).terrain;
        switch (input.action) {
          case 'road': {
            const cls = input.roadClass ?? 'street';
            const RC = BALANCE.construction.roadClasses;
            if (cur?.t === 'road') {
              // смяна на категорията: плаща се разликата (понижаването е безплатно)
              const was = cur.c ?? 'street';
              if (was === cls) continue;
              const diff = Math.max(0, RC[cls].cost - RC[was].cost);
              const c = buildCost(gen, x, y, Math.round(BALANCE.construction.roadCost * diff));
              const next: TileState = {
                t: 'road',
                ...(cls === 'street' ? {} : { c: cls }),
                ...(cur.j ? { j: cur.j } : {}),
                ...(cur.sw !== undefined ? { sw: cur.sw } : {}),
                ...(cur.st ? { st: true } : {}),
              };
              tiles[k] = next;
              cost += Number.isFinite(c) ? c : 0;
              applied++;
              continue;
            }
            if (cur) {
              reasons.add('Плочката е заета');
              continue;
            }
            const c = buildCost(gen, x, y, Math.round(BALANCE.construction.roadCost * RC[cls].cost));
            if (!Number.isFinite(c)) {
              reasons.add('Мост не може да се построи в открито (дълбоко) море');
              continue;
            }
            tiles[k] = cls === 'street' ? { t: 'road' } : { t: 'road', c: cls };
            cost += c;
            applied++;
            break;
          }
          case 'junction': {
            if (cur?.t !== 'road') {
              reasons.add('Кръстовище може да се управлява само върху път');
              continue;
            }
            const arms = [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)].filter((n) => tiles[n]?.t === 'road').length;
            if (input.control !== 'none' && arms < 3) {
              reasons.add('Кръгово движение и светофари се поставят на кръстовище с поне 3 пътя');
              continue;
            }
            if ((cur.j ?? 'none') === input.control) continue;
            const next: TileState = {
              t: 'road',
              ...(cur.c ? { c: cur.c } : {}),
              ...(cur.sw !== undefined ? { sw: cur.sw } : {}),
              ...(cur.st ? { st: true } : {}),
            };
            if (input.control !== 'none') {
              next.j = input.control;
              cost += BALANCE.construction.junctions[input.control].cost;
            }
            tiles[k] = next;
            applied++;
            break;
          }
          case 'busstop': {
            if (cur?.t !== 'road') {
              reasons.add('Спирка се поставя върху път');
              continue;
            }
            const want = !input.remove;
            if (!!cur.st === want) continue;
            const arms = [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)].filter((n) => tiles[n]?.t === 'road').length;
            if (want && (cur.j || arms >= 3)) {
              reasons.add('Спирката не може да е на кръстовище');
              continue;
            }
            if (want && cur.c === 'highway') {
              reasons.add('По магистрала няма спирки');
              continue;
            }
            const next: TileState = { ...cur };
            if (want) {
              next.st = true;
              cost += BALANCE.construction.busStopCost;
            } else delete next.st;
            tiles[k] = next;
            applied++;
            break;
          }
          case 'sidewalk': {
            if (cur?.t === 'road') {
              const want = !input.remove;
              if (hasSidewalk(cur) === want) continue;
              if (want && cur.c === 'highway') {
                reasons.add('Магистралите нямат тротоари – направете алея встрани');
                continue;
              }
              const def = SIDEWALK_BY_DEFAULT.includes(cur.c ?? 'street');
              const next: TileState = { t: 'road', ...(cur.c ? { c: cur.c } : {}), ...(cur.j ? { j: cur.j } : {}), ...(cur.st ? { st: true } : {}) };
              if (want !== def) next.sw = want;
              tiles[k] = next;
              if (want) cost += BALANCE.construction.sidewalkCost;
              applied++;
              continue;
            }
            if (input.remove) {
              if (cur?.t === 'path') {
                delete tiles[k];
                applied++;
              }
              continue;
            }
            if (cur) {
              if (cur.t !== 'path') reasons.add('Алея се прави на празна земя, а тротоар – върху път');
              continue;
            }
            const c = buildCost(gen, x, y, BALANCE.construction.pathCost);
            if (!Number.isFinite(c) || isWater(terrain)) {
              reasons.add('Не може да се прави алея върху вода');
              continue;
            }
            tiles[k] = { t: 'path' };
            cost += c;
            applied++;
            break;
          }
          case 'zone': {
            if (isWater(terrain)) {
              reasons.add('Не може да се зонира вода');
              continue;
            }
            if (cur && !(cur.t === 'zone' && cur.lvl === 0)) {
              reasons.add('Плочката е заета (съборете сградата първо)');
              continue;
            }
            if (cur?.t === 'zone' && cur.z === input.zone) continue;
            tiles[k] = { t: 'zone', z: input.zone, lvl: 0, occ: 0, prog: 0, hp: 1 };
            cost += ZONES[input.zone].zoningCost;
            applied++;
            break;
          }
          case 'dezone': {
            if (cur?.t !== 'zone') continue;
            delete tiles[k];
            cost += cur.lvl > 0 ? BALANCE.construction.bulldozeCost * cur.lvl : 0;
            applied++;
            break;
          }
          case 'service': {
            if (cur) {
              reasons.add('Плочката е заета');
              continue;
            }
            const def = SERVICES[input.service];
            // Сградите имат основи – теренният множител е ограничен до 1.3 (пътищата плащат пълния).
            const c = Math.round(def.cost * Math.min(1.3, gen.roadCostMult(x, y)));
            if (!Number.isFinite(c) || isWater(terrain)) {
              reasons.add('Не може да се строи върху вода');
              continue;
            }
            tiles[k] = { t: 'service', s: input.service, cond: 1 };
            cost += c;
            applied++;
            break;
          }
          case 'bulldoze': {
            if (!cur) continue;
            if (cur.t === 'facility') {
              reasons.add('Предприятията се премахват от собствената им компания');
              continue;
            }
            delete tiles[k];
            cost += BALANCE.construction.bulldozeCost * (cur.t === 'zone' ? Math.max(1, cur.lvl) : 1);
            applied++;
            break;
          }
        }
      }
      if (applied === 0) {
        if (reasons.size) throw bad([...reasons].join('; '));
        return { applied: 0, skipped: seen.size, cost: 0, reasons: [], version: city.version };
      }
      await transfer(tx, {
        from: acc.city(cityId),
        to: SYS.WORLD,
        amount: cost,
        kind: 'CONSTRUCTION',
        tick,
        key: `build:${cityId}:${city.version}`,
        refType: 'City',
        refId: cityId,
        memo: `${input.action} x${applied}`,
      }).catch((e) => {
        if (e instanceof DomainError && e.code === 'INSUFFICIENT_FUNDS')
          throw new DomainError('INSUFFICIENT_FUNDS', `Недостатъчно средства в бюджета (нужни ${(cost / 100).toFixed(0)} €)`, 402);
        throw e;
      });
      // Бюджетът на града може да е в дефицит, но новото строителство изисква наличност.
      const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(cityId) } });
      if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', `Недостатъчно средства в бюджета (нужни ${(cost / 100).toFixed(0)} €)`, 402);
      // запомня промените за „Отмени“
      const prev: Record<string, TileState | null> = {};
      const next: Record<string, TileState | null> = {};
      for (const k of seen) {
        if (JSON.stringify(before[k] ?? null) === JSON.stringify(tiles[k] ?? null)) continue;
        prev[k] = before[k] ?? null;
        next[k] = tiles[k] ?? null;
      }
      const lastBuild = { version: city.version + 1, tick, cost, action: input.action, prev, next };
      const updated = await tx.city.update({
        where: { id: cityId },
        data: { tiles: tiles as unknown as Prisma.InputJsonValue, version: { increment: 1 }, lastBuild: lastBuild as unknown as Prisma.InputJsonValue },
      });
      return { applied, skipped: seen.size - applied, cost, reasons: [...reasons], version: updated.version };
    }),
  );
}

interface LastBuild {
  version: number;
  tick: number;
  cost: number;
  action: string;
  prev: Record<string, TileState | null>;
  next: Record<string, TileState | null>;
}

/** Колко игрови дни след строителството то може да се отмени. */
/** Ден = 1 секунда: 180 дни ≈ 3 минути за „Отмени“. */
export const UNDO_WINDOW_DAYS = 180;

/**
 * Същото ли е построеното на плочката (без напредъка на строежа, заетостта и състоянието, които
 * симулацията променя всеки ден). Зона, в която вече има сграда (ниво 1+), не се отменя.
 */
function sameStructure(cur: TileState | null, built: TileState | null): boolean {
  if (!cur || !built) return cur === built;
  if (cur.t !== built.t) return false;
  if (cur.t === 'zone' && built.t === 'zone') return cur.z === built.z && cur.lvl === 0;
  if (cur.t === 'service' && built.t === 'service') return cur.s === built.s;
  return JSON.stringify(cur) === JSON.stringify(built);
}

/** „Отмени“: връща плочките от последното строителство и възстановява парите – само ако построеното още е същото. */
export async function undoBuild(prisma: PrismaClient, userId: string, cityId: string) {
  return withTx(prisma, async (tx) => {
    const city = await lockCity(tx, cityId);
    if (city.ownerId !== userId) throw forbidden('Само кметът може да отменя строителство');
    const lb = city.lastBuild as unknown as LastBuild | null;
    if (!lb) throw bad('Няма какво да се отмени');
    const tick = await currentTick(tx);
    if (tick - lb.tick > UNDO_WINDOW_DAYS) throw bad(`Може да се отмени само строителство от последните ${UNDO_WINDOW_DAYS} игрови дни`);
    const tiles = { ...(city.tiles as unknown as TileMap) };
    for (const [k, v] of Object.entries(lb.next))
      if (!sameStructure(tiles[k] ?? null, v)) throw bad('Градът вече се промени (напр. на мястото вече има сграда) – отмяната не е възможна');
    for (const [k, v] of Object.entries(lb.prev)) {
      if (v) tiles[k] = v;
      else delete tiles[k];
    }
    if (lb.cost > 0)
      await transfer(tx, {
        from: SYS.WORLD,
        to: acc.city(cityId),
        amount: lb.cost,
        kind: 'CONSTRUCTION_REFUND',
        tick,
        key: `undo:${cityId}:${lb.version}`,
        refType: 'City',
        refId: cityId,
        memo: `отмяна: ${lb.action}`,
      });
    const updated = await tx.city.update({
      where: { id: cityId },
      data: { tiles: tiles as unknown as Prisma.InputJsonValue, version: { increment: 1 }, lastBuild: Prisma.DbNull },
    });
    return { restored: Object.keys(lb.prev).length, refund: lb.cost, version: updated.version };
  });
}

export function parcelPrice(gen: Awaited<ReturnType<typeof worldGen>>, px: number, py: number, ownedCount: number): number {
  const prof = gen.parcelProfile(px, py);
  const L = BALANCE.land;
  const resource = prof.iron + prof.coal > 0 ? 1 + L.resourcePremium * Math.min(1, (prof.iron + prof.coal) / 8) : 1;
  return Math.round(L.parcelBasePrice * (1 + L.parcelGrowthFactor * ownedCount) * (0.4 + 0.6 * prof.land + 0.4 * prof.fertility) * resource);
}

export async function buyParcel(prisma: PrismaClient, userId: string, cityId: string, px: number, py: number, idemKey?: string) {
  const gen = await worldGen(prisma);
  const maxP = Math.floor(BALANCE.world.size / BALANCE.world.parcelSize);
  if (px < 0 || py < 0 || px >= maxP || py >= maxP) throw bad('Парцелът е извън света');
  try {
    return await withTx(prisma, (tx) =>
      idempotent(tx, userId, idemKey ? `parcel:${idemKey}` : undefined, async () => {
        const city = await lockCity(tx, cityId);
        if (city.ownerId !== userId) throw forbidden();
        if (city.parcels.length >= BALANCE.world.maxCityParcels) throw bad('Достигнат е максималният размер на града');
        const adjacent = city.parcels.some((p) => Math.abs(p.px - px) + Math.abs(p.py - py) === 1);
        if (!adjacent) throw bad('Парцелът трябва да граничи с територията на града');
        const prof = gen.parcelProfile(px, py);
        if (prof.inCountry < 0.5) throw bad('Земя може да се купува само в България');
        if (prof.land < 0.2) throw bad('Парцелът е почти изцяло вода');
        const price = parcelPrice(gen, px, py, city.parcels.length);
        const tick = await currentTick(tx);
        await tx.parcel.create({ data: { px, py, cityId, price: BigInt(price) } });
        await transfer(tx, {
          from: acc.city(cityId),
          to: SYS.WORLD,
          amount: price,
          kind: 'LAND_PURCHASE',
          tick,
          key: `parcel:${px},${py}:${cityId}`,
          refType: 'City',
          refId: cityId,
        });
        const bal = await tx.account.findUniqueOrThrow({ where: { id: acc.city(cityId) } });
        if (bal.balance < 0n) throw new DomainError('INSUFFICIENT_FUNDS', 'Недостатъчно средства в бюджета', 402);
        await tx.city.update({ where: { id: cityId }, data: { version: { increment: 1 } } });
        return { px, py, price };
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('Парцелът вече е собственост на друг град');
    throw e;
  }
}

export async function setPolicy(prisma: PrismaClient, userId: string, cityId: string, input: PolicyInput) {
  return withTx(prisma, async (tx) => {
    const city = await lockCity(tx, cityId);
    if (city.ownerId !== userId) throw forbidden();
    const cur = city.policy as unknown as CityPolicy;
    const next: CityPolicy = {
      ...cur,
      ...input,
      taxes: { ...cur.taxes, ...(input.taxes ?? {}) },
      subsidies: input.subsidies ? { ...input.subsidies } : cur.subsidies,
      sanctions: input.sanctions ? [...new Set(input.sanctions.filter((s) => s !== userId))] : cur.sanctions,
      powerPriority: input.powerPriority && new Set(input.powerPriority).size === 3 ? input.powerPriority : cur.powerPriority,
    };
    await tx.city.update({ where: { id: cityId }, data: { policy: next as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    await tx.auditLog.create({ data: { userId, action: 'city.policy', details: { cityId, input } as unknown as Prisma.InputJsonValue } });
    return next;
  });
}

/** Публичен или пълен изглед на града според правата на зрителя. */
export async function getCity(prisma: PrismaClient, cityId: string, viewerId: string | null) {
  // без тежките колони (плочки, население, слоеве) – те идват от кеша в паметта при същата версия
  const head = await prisma.city.findUnique({
    where: { id: cityId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      originX: true,
      originY: true,
      foundedTick: true,
      policy: true,
      stats: true,
      version: true,
      receivership: true,
      deficitDays: true,
      lastTick: true,
      owner: { select: { username: true } },
    },
  });
  if (!head) throw notFound('Градът');
  let heavy = await loadCityHeavy(prisma, cityId, head.version);
  // градът е сменен точно между двете четения – още един опит с прясна версия
  if (!heavy) heavy = await loadCityHeavy(prisma, cityId, (await prisma.city.findUnique({ where: { id: cityId }, select: { version: true } }))?.version ?? -1);
  if (!heavy) throw notFound('Градът');
  const city = { ...head, ...heavy };
  const isOwner = viewerId === city.ownerId;
  const stats = city.stats as Record<string, unknown>;
  const base = {
    id: city.id,
    name: city.name,
    ownerId: city.ownerId,
    ownerName: city.owner.username,
    originX: city.originX,
    originY: city.originY,
    parcels: city.parcels.map((p) => ({ px: p.px, py: p.py })),
    tiles: city.tiles,
    foundedTick: city.foundedTick,
    isOwner,
    publicStats: {
      population: stats.population ?? 0,
      landValueAvg: stats.landValueAvg ?? 0,
      unemploymentRate: stats.unemploymentRate ?? 0,
      happiness: stats.happiness ?? 0,
      gdp: stats.gdp ?? 0,
      buildings: stats.buildings ?? {},
    },
    publicPolicy: { taxes: (city.policy as unknown as CityPolicy).taxes, importTariff: (city.policy as unknown as CityPolicy).importTariff },
  };
  if (!isOwner) return base;
  const account = await prisma.account.findUnique({ where: { id: acc.city(cityId) } });
  return {
    ...base,
    treasury: Number(account?.balance ?? 0n),
    pop: city.pop,
    policy: city.policy,
    stats: city.stats,
    version: city.version,
    receivership: city.receivership,
    deficitDays: city.deficitDays,
    lastTick: city.lastTick,
  };
}

export async function cityLayers(prisma: PrismaClient, cityId: string, viewerId: string) {
  const city = await prisma.city.findUnique({ where: { id: cityId }, select: { ownerId: true, derived: true } });
  if (!city) throw notFound('Градът');
  if (city.ownerId !== viewerId) throw forbidden('Подробните слоеве са поверителни');
  return city.derived;
}

/** Градове и собственост в правоъгълен регион (за картата). Изпраща само видимата част. */
export async function region(prisma: PrismaClient, x0: number, y0: number, x1: number, y1: number) {
  const s = BALANCE.world.parcelSize;
  if (x1 - x0 > 256 || y1 - y0 > 256) throw bad('Регионът е твърде голям (макс. 256x256)');
  const parcels = await prisma.parcel.findMany({
    where: { px: { gte: Math.floor(x0 / s), lte: Math.floor(x1 / s) }, py: { gte: Math.floor(y0 / s), lte: Math.floor(y1 / s) } },
    select: { px: true, py: true, cityId: true },
  });
  const cityIds = [...new Set(parcels.map((p) => p.cityId))];
  const cities = await prisma.city.findMany({
    where: { id: { in: cityIds } },
    select: { id: true, name: true, ownerId: true, originX: true, originY: true, version: true, owner: { select: { username: true } } },
  });
  const heavy = await Promise.all(cities.map((c) => loadCityHeavy(prisma, c.id, c.version)));
  return {
    parcels,
    cities: cities.map((c, i) => {
      const tiles: Record<string, TileState> = {};
      for (const [k, v] of Object.entries((heavy[i]?.tiles ?? {}) as TileMap)) {
        const [x, y] = parseKey(k);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) tiles[k] = v;
      }
      return { id: c.id, name: c.name, ownerId: c.ownerId, ownerName: c.owner.username, originX: c.originX, originY: c.originY, tiles };
    }),
  };
}

export async function listCities(prisma: PrismaClient, ownerId?: string) {
  const cities = await prisma.city.findMany({
    where: ownerId ? { ownerId } : undefined,
    select: { id: true, name: true, ownerId: true, originX: true, originY: true, stats: true, owner: { select: { username: true } } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  return cities.map((c) => {
    const st = c.stats as Record<string, number>;
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      ownerName: c.owner.username,
      originX: c.originX,
      originY: c.originY,
      population: st.population ?? 0,
      happiness: st.happiness ?? 0,
    };
  });
}

/** Доброволен трансфер от личния портфейл към бюджета на собствен град. */
export async function walletToCity(prisma: PrismaClient, userId: string, cityId: string, amount: number, idemKey?: string) {
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `w2c:${idemKey}` : undefined, async () => {
      const city = await tx.city.findUnique({ where: { id: cityId } });
      if (!city) throw notFound('Градът');
      if (city.ownerId !== userId) throw forbidden();
      const tick = await currentTick(tx);
      await transfer(tx, {
        from: acc.user(userId),
        to: acc.city(cityId),
        amount,
        kind: 'WALLET_TO_CITY',
        tick,
        key: `w2c:${userId}:${cityId}:${Date.now()}:${Math.random()}`,
        refType: 'City',
        refId: cityId,
      });
      await notify(tx, userId, 'finance', `Преведени ${(amount / 100).toFixed(2)} € към бюджета на ${city.name}`);
      return { ok: true };
    }),
  );
}
