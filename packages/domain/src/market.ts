import { BALANCE, GOODS, GOOD_IDS, type CityPolicy, type GoodId, type Side } from '@gce/shared';
import { matchIncoming, nextReferencePrice, shippingQuote, techEffects, type BookOrder } from '@gce/economy-engine';
import { Prisma, withTx, type MarketOrder, type PrismaClient, type Tx } from '@gce/database';
import { DomainError, bad, forbidden, notFound } from './errors';
import { SYS, acc, transfer } from './ledger';
import { idempotent } from './idempotency';
import { cityDistance, currentTick, refPrices } from './world';
import { linkShippingMult } from './links';
import { requirePermission } from './companies';
import { addGoods, consumeReserved, releaseReserved, reserveGoods } from './inventory';
import { notify, publish } from './events';
import { companyTechs } from './research';

type OwnerT = 'USER' | 'COMPANY';

async function lockInstrument(tx: Tx, instrument: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${instrument}))`;
}

async function sanctioned(tx: Tx, buyerCityId: string | null, sellerCityId: string | null, buyerUser: string, sellerUser: string): Promise<boolean> {
  const ids = [buyerCityId, sellerCityId].filter(Boolean) as string[];
  const cities = await tx.city.findMany({ where: { id: { in: ids } }, select: { id: true, policy: true } });
  for (const c of cities) {
    const p = c.policy as unknown as CityPolicy;
    if (c.id === buyerCityId && p.sanctions.includes(sellerUser)) return true;
    if (c.id === sellerCityId && p.sanctions.includes(buyerUser)) return true;
  }
  // Санкции на ниво съюз.
  const members = await tx.allianceMember.findMany({ where: { userId: { in: [buyerUser, sellerUser] } } });
  for (const m of members) {
    const target = m.userId === buyerUser ? sellerUser : buyerUser;
    const s = await tx.allianceSanction.findUnique({ where: { allianceId_targetUserId: { allianceId: m.allianceId, targetUserId: target } } });
    if (s) return true;
  }
  return false;
}

/** Мито при внос между градове; членовете на един съюз (търговски блок) не плащат мито помежду си. */
async function tariffRate(tx: Tx, buyerCityId: string, sellerCityId: string, buyerUser: string, sellerUser: string): Promise<number> {
  if (buyerCityId === sellerCityId) return 0;
  const city = await tx.city.findUnique({ where: { id: buyerCityId }, select: { policy: true, ownerId: true } });
  if (!city) return 0;
  const rate = (city.policy as unknown as CityPolicy).importTariff ?? 0;
  if (rate <= 0) return 0;
  const [a, b] = await Promise.all([
    tx.allianceMember.findUnique({ where: { userId: buyerUser } }),
    tx.allianceMember.findUnique({ where: { userId: sellerUser } }),
  ]);
  if (a && b && a.allianceId === b.allianceId) return 0;
  return rate;
}

interface PlaceInput {
  instrument: string;
  side: Side;
  quantity: number;
  price: number;
  companyId?: string;
  cityId?: string;
}

export async function placeOrder(prisma: PrismaClient, userId: string, input: PlaceInput, idemKey?: string) {
  return withTx(prisma, (tx) =>
    idempotent(tx, userId, idemKey ? `order:${idemKey}` : undefined, async () => {
      const tick = await currentTick(tx);
      const isGood = input.instrument.startsWith('GOOD:');
      let traderType: OwnerT;
      let traderId: string;
      if (isGood) {
        if (!input.companyId || !input.cityId) throw bad('Нужни са компания и град');
        await requirePermission(tx, input.companyId, userId, 'trade');
        const city = await tx.city.findUnique({ where: { id: input.cityId } });
        if (!city) throw notFound('Градът');
        if (input.side === 'BUY') {
          const company = await tx.company.findUniqueOrThrow({ where: { id: input.companyId } });
          const present = company.hqCityId === input.cityId || (await tx.facility.count({ where: { companyId: input.companyId, cityId: input.cityId } })) > 0;
          if (!present) throw bad('Дестинацията трябва да е седалището или град с ваше съоръжение');
        }
        traderType = 'COMPANY';
        traderId = input.companyId;
      } else {
        const target = input.instrument.slice(6);
        const tc = await tx.company.findUnique({ where: { id: target } });
        if (!tc || tc.status !== 'ACTIVE') throw bad('Акциите на тази компания не се търгуват');
        if (input.companyId) {
          if (input.companyId === target) throw bad('Компанията не може да търгува собствените си акции');
          await requirePermission(tx, input.companyId, userId, 'trade');
          traderType = 'COMPANY';
          traderId = input.companyId;
        } else {
          traderType = 'USER';
          traderId = userId;
        }
      }
      await lockInstrument(tx, input.instrument);
      const order = await tx.marketOrder.create({
        data: {
          instrument: input.instrument,
          side: input.side,
          price: BigInt(input.price),
          quantity: input.quantity,
          remaining: input.quantity,
          traderType,
          traderId,
          userId,
          cityId: input.cityId ?? null,
          escrow: input.side === 'BUY' ? BigInt(input.price) * BigInt(input.quantity) : 0n,
        },
      });
      // Резервиране на актива / средствата.
      if (input.side === 'BUY') {
        await transfer(tx, {
          from: acc.of(traderType, traderId),
          to: SYS.ESCROW,
          amount: input.price * input.quantity,
          kind: 'ORDER_ESCROW',
          tick,
          key: `escrow:${order.id}`,
          refType: 'MarketOrder',
          refId: String(order.id),
        });
      } else if (isGood) {
        await reserveGoods(tx, traderId, input.cityId!, input.instrument.slice(5) as GoodId, input.quantity);
      } else {
        const n =
          await tx.$executeRaw`UPDATE "Shareholding" SET "reserved" = "reserved" + ${input.quantity} WHERE "companyId" = ${input.instrument.slice(6)} AND "holderType" = ${traderType}::"OwnerType" AND "holderId" = ${traderId} AND "shares" - "reserved" >= ${input.quantity}`;
        if (n !== 1) throw new DomainError('INSUFFICIENT_SHARES', 'Нямате достатъчно свободни акции', 409);
      }
      const fills = await matchOrder(tx, order, tick);
      await publish(tx, { type: 'market', instrument: input.instrument });
      const fresh = await tx.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
      return { order: serializeOrder(fresh), fills };
    }),
  );
}

export function serializeOrder(o: MarketOrder) {
  return { ...o, id: String(o.id), price: Number(o.price), escrow: Number(o.escrow) };
}

/** Съпоставя нова поръчка с книгата (вече заключен инструмент). */
async function matchOrder(tx: Tx, incoming: MarketOrder, tick: number) {
  const opposite = incoming.side === 'BUY' ? 'SELL' : 'BUY';
  const candidates = await tx.$queryRaw<MarketOrder[]>`
    SELECT * FROM "MarketOrder" WHERE instrument = ${incoming.instrument} AND side = ${opposite} AND status = 'OPEN' AND remaining > 0
      AND (CASE WHEN ${incoming.side} = 'BUY' THEN price <= ${incoming.price} ELSE price >= ${incoming.price} END)
    ORDER BY CASE WHEN ${incoming.side} = 'BUY' THEN price END ASC, CASE WHEN ${incoming.side} = 'SELL' THEN price END DESC, id ASC
    LIMIT 100 FOR UPDATE`;
  const book: BookOrder[] = candidates.map((o) => ({
    id: String(o.id),
    side: o.side as Side,
    price: Number(o.price),
    remaining: o.remaining,
    createdSeq: Number(o.id),
    ownerKey: `${o.traderType}:${o.traderId}`,
  }));
  const blocked = new Set<string>();
  if (incoming.instrument.startsWith('GOOD:')) {
    for (const c of candidates) {
      const buyer = incoming.side === 'BUY' ? incoming : c;
      const seller = incoming.side === 'BUY' ? c : incoming;
      if (await sanctioned(tx, buyer.cityId, seller.cityId, buyer.userId, seller.userId)) blocked.add(String(c.id));
    }
  }
  const { fills } = matchIncoming(
    { side: incoming.side as Side, price: Number(incoming.price), quantity: incoming.remaining, ownerKey: `${incoming.traderType}:${incoming.traderId}` },
    book,
    (m) => !blocked.has(m.id),
  );
  const byId = new Map(candidates.map((c) => [String(c.id), c]));
  const results: { price: number; quantity: number }[] = [];
  for (const f of fills) {
    const maker = byId.get(f.makerId)!;
    const buy = incoming.side === 'BUY' ? incoming : maker;
    const sell = incoming.side === 'BUY' ? maker : incoming;
    await settle(tx, buy, sell, f.quantity, f.price, tick);
    results.push({ price: f.price, quantity: f.quantity });
  }
  return results;
}

/** Атомарно сетълмънт на сделка между две поръчки (стоки или акции). */
async function settle(tx: Tx, buy: MarketOrder, sell: MarketOrder, qty: number, price: number, tick: number) {
  const gross = price * qty;
  const buyReserved = Number(buy.price) * qty;
  const trade = await tx.trade.create({
    data: {
      instrument: buy.instrument,
      price: BigInt(price),
      quantity: qty,
      buyOrderId: buy.id,
      sellOrderId: sell.id,
      buyerType: buy.traderType,
      buyerId: buy.traderId,
      sellerType: sell.traderType,
      sellerId: sell.traderId,
      tick,
    },
  });
  const key = `trade:${trade.id}`;
  const fee = Math.floor(gross * BALANCE.market.tradeFee);
  let tariff = 0;
  let shipping = 0;
  if (buy.instrument.startsWith('GOOD:')) {
    const good = buy.instrument.slice(5) as GoodId;
    await consumeReserved(tx, sell.traderId, sell.cityId!, good, qty);
    const [fromCity, toCity] = await Promise.all([
      tx.city.findUniqueOrThrow({ where: { id: sell.cityId! } }),
      tx.city.findUniqueOrThrow({ where: { id: buy.cityId! } }),
    ]);
    const dist = cityDistance(fromCity, toCity);
    const fx = techEffects(null, await companyTechs(tx, sell.traderId, tick));
    const quote = shippingQuote(dist, qty, fx.shippingMult * (await linkShippingMult(tx, sell.cityId!, buy.cityId!)));
    shipping = quote.cost;
    tariff = Math.floor(gross * (await tariffRate(tx, buy.cityId!, sell.cityId!, buy.userId, sell.userId)));
    if (quote.days === 0) await addGoods(tx, buy.traderId, buy.cityId!, good, qty, price);
    else
      await tx.shipment.create({
        data: {
          companyId: buy.traderId,
          good,
          quantity: qty,
          fromCityId: sell.cityId!,
          toCityId: buy.cityId!,
          departTick: tick,
          arriveTick: tick + quote.days,
          cost: BigInt(shipping),
          refType: 'Trade',
          refId: String(trade.id),
        },
      });
    if (tariff > 0)
      await transfer(tx, {
        from: SYS.ESCROW,
        to: acc.city(buy.cityId!),
        amount: tariff,
        kind: 'IMPORT_TARIFF',
        tick,
        key: `${key}:tariff`,
        refType: 'Trade',
        refId: String(trade.id),
      });
  } else {
    const companyId = buy.instrument.slice(6);
    const n =
      await tx.$executeRaw`UPDATE "Shareholding" SET "shares" = "shares" - ${qty}, "reserved" = "reserved" - ${qty} WHERE "companyId" = ${companyId} AND "holderType" = ${sell.traderType}::"OwnerType" AND "holderId" = ${sell.traderId} AND "reserved" >= ${qty}`;
    if (n !== 1) throw new DomainError('SHARE_STATE', 'Несъответствие в резервираните акции', 500);
    await tx.$executeRaw`INSERT INTO "Shareholding" ("companyId","holderType","holderId","shares","reserved") VALUES (${companyId}, ${buy.traderType}::"OwnerType", ${buy.traderId}, ${qty}, 0)
      ON CONFLICT ("companyId","holderType","holderId") DO UPDATE SET "shares" = "Shareholding"."shares" + ${qty}`;
    await updateControl(tx, companyId, tick);
  }
  const deductions = fee + tariff;
  shipping = Math.min(shipping, Math.max(0, gross - deductions));
  const net = gross - deductions - shipping;
  await transfer(tx, { from: SYS.ESCROW, to: SYS.FEES, amount: fee, kind: 'TRADE_FEE', tick, key: `${key}:fee` });
  if (shipping > 0) await transfer(tx, { from: SYS.ESCROW, to: SYS.WORLD, amount: shipping, kind: 'SHIPPING', tick, key: `${key}:shipping` });
  await transfer(tx, {
    from: SYS.ESCROW,
    to: acc.of(sell.traderType as OwnerT, sell.traderId),
    amount: net,
    kind: 'TRADE_PROCEEDS',
    tick,
    key: `${key}:proceeds`,
    refType: 'Trade',
    refId: String(trade.id),
  });
  const refund = buyReserved - gross;
  if (refund > 0)
    await transfer(tx, {
      from: SYS.ESCROW,
      to: acc.of(buy.traderType as OwnerT, buy.traderId),
      amount: refund,
      kind: 'ESCROW_REFUND',
      tick,
      key: `${key}:refund`,
    });
  // Обновяване на поръчките.
  for (const o of [buy, sell]) {
    const remaining = o.remaining - qty;
    const escrow = o.side === 'BUY' ? o.escrow - BigInt(buyReserved) : 0n;
    await tx.marketOrder.update({ where: { id: o.id }, data: { remaining, escrow, status: remaining === 0 ? 'FILLED' : 'OPEN' } });
    o.remaining = remaining;
    o.escrow = escrow;
  }
  await tx.marketState.upsert({
    where: { instrument: buy.instrument },
    create: { instrument: buy.instrument, refPrice: BigInt(price), lastPrice: BigInt(price), dayVolume: qty },
    update: { lastPrice: BigInt(price), dayVolume: { increment: qty } },
  });
  const sellerUser = sell.userId;
  const buyerUser = buy.userId;
  await notify(tx, sellerUser, 'trade', `Продадени ${qty} × ${buy.instrument} по ${(price / 100).toFixed(2)} €`);
  if (buyerUser !== sellerUser) await notify(tx, buyerUser, 'trade', `Купени ${qty} × ${buy.instrument} по ${(price / 100).toFixed(2)} €`);
}

/** Контрол: компания с над 50% от акциите на друга става нейна компания-майка (дъщерно дружество). */
export async function updateControl(tx: Tx, companyId: string, tick: number) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
  const top = await tx.shareholding.findFirst({ where: { companyId, holderType: 'COMPANY' }, orderBy: { shares: 'desc' } });
  const parent = top && top.shares * 2 > company.totalShares ? top.holderId : null;
  if (parent !== company.parentCompanyId) {
    await tx.company.update({ where: { id: companyId }, data: { parentCompanyId: parent } });
    if (parent) {
      const p = await tx.company.findUniqueOrThrow({ where: { id: parent } });
      await tx.worldEvent.create({ data: { tick, kind: 'acquisition', message: `„${p.name}“ придоби контролен пакет в „${company.name}“` } });
    }
  }
}

export async function cancelOrder(prisma: PrismaClient, userId: string, orderId: string) {
  return withTx(prisma, async (tx) => {
    const o = await tx.marketOrder.findUnique({ where: { id: BigInt(orderId) } });
    if (!o) throw notFound('Поръчката');
    if (o.traderType === 'USER' && o.traderId !== userId) throw forbidden();
    if (o.traderType === 'COMPANY') await requirePermission(tx, o.traderId, userId, 'trade');
    await lockInstrument(tx, o.instrument);
    const cur = await tx.marketOrder.findUniqueOrThrow({ where: { id: o.id } });
    if (cur.status !== 'OPEN') throw bad('Поръчката вече е изпълнена или отменена');
    await releaseOrder(tx, cur, await currentTick(tx));
    await publish(tx, { type: 'market', instrument: o.instrument });
    return { ok: true };
  });
}

/** Освобождава резервираните стоки/акции/пари на отворена поръчка. */
export async function releaseOrder(tx: Tx, o: MarketOrder, tick: number) {
  if (o.side === 'BUY') {
    if (o.escrow > 0n)
      await transfer(tx, {
        from: SYS.ESCROW,
        to: acc.of(o.traderType as OwnerT, o.traderId),
        amount: o.escrow,
        kind: 'ESCROW_REFUND',
        tick,
        key: `cancel:${o.id}`,
      });
  } else if (o.instrument.startsWith('GOOD:')) {
    await releaseReserved(tx, o.traderId, o.cityId!, o.instrument.slice(5) as GoodId, o.remaining);
  } else {
    await tx.$executeRaw`UPDATE "Shareholding" SET "reserved" = "reserved" - ${o.remaining} WHERE "companyId" = ${o.instrument.slice(6)} AND "holderType" = ${o.traderType}::"OwnerType" AND "holderId" = ${o.traderId} AND "reserved" >= ${o.remaining}`;
  }
  await tx.marketOrder.update({ where: { id: o.id }, data: { status: 'CANCELLED', escrow: 0n } });
}

export async function orderBook(prisma: PrismaClient, instrument: string) {
  const [bids, asks, trades, state, history] = await Promise.all([
    prisma.$queryRaw<
      { price: bigint; qty: bigint; n: bigint }[]
    >`SELECT price, SUM(remaining)::bigint AS qty, COUNT(*)::bigint AS n FROM "MarketOrder" WHERE instrument = ${instrument} AND side = 'BUY' AND status = 'OPEN' GROUP BY price ORDER BY price DESC LIMIT 15`,
    prisma.$queryRaw<
      { price: bigint; qty: bigint; n: bigint }[]
    >`SELECT price, SUM(remaining)::bigint AS qty, COUNT(*)::bigint AS n FROM "MarketOrder" WHERE instrument = ${instrument} AND side = 'SELL' AND status = 'OPEN' GROUP BY price ORDER BY price ASC LIMIT 15`,
    prisma.trade.findMany({ where: { instrument }, orderBy: { id: 'desc' }, take: 30 }),
    prisma.marketState.findUnique({ where: { instrument } }),
    prisma.priceHistory.findMany({ where: { instrument }, orderBy: { tick: 'desc' }, take: 180 }),
  ]);
  const lvl = (r: { price: bigint; qty: bigint; n: bigint }) => ({ price: Number(r.price), quantity: Number(r.qty), orders: Number(r.n) });
  return {
    instrument,
    bids: bids.map(lvl),
    asks: asks.map(lvl),
    trades: trades.map((t) => ({ id: String(t.id), price: Number(t.price), quantity: t.quantity, kind: t.kind, tick: t.tick })),
    refPrice: state ? Number(state.refPrice) : null,
    lastPrice: state?.lastPrice != null ? Number(state.lastPrice) : null,
    history: history
      .reverse()
      .map((h) => ({ tick: h.tick, ref: Number(h.ref), last: h.last != null ? Number(h.last) : null, volume: h.volume, unmet: h.unmet })),
  };
}

export async function marketSummary(prisma: PrismaClient) {
  const states = await prisma.marketState.findMany({ where: { instrument: { startsWith: 'GOOD:' } } });
  const tick = await currentTick(prisma);
  const prev = await prisma.priceHistory.findMany({ where: { tick: { gte: tick - 30 }, instrument: { startsWith: 'GOOD:' } }, orderBy: { tick: 'asc' } });
  return GOOD_IDS.map((g) => {
    const s = states.find((x) => x.instrument === `GOOD:${g}`);
    const first = prev.find((p) => p.instrument === `GOOD:${g}`);
    const ref = s ? Number(s.refPrice) : GOODS[g].basePrice;
    return {
      good: g,
      name: GOODS[g].name,
      refPrice: ref,
      basePrice: GOODS[g].basePrice,
      lastPrice: s?.lastPrice != null ? Number(s.lastPrice) : null,
      change30d: first ? (ref - Number(first.ref)) / Number(first.ref) : 0,
      unmetDemand: s?.unmetDemand ?? 0,
    };
  });
}

export async function myOrders(prisma: PrismaClient, userId: string) {
  const orders = await prisma.marketOrder.findMany({ where: { userId, status: 'OPEN' }, orderBy: { id: 'desc' }, take: 100 });
  return orders.map(serializeOrder);
}

/**
 * Дневен цикъл на световния пазар за една стока (worker):
 * 1) градското потребление (храни/стоки) купува от най-евтините продажни поръчки до 130% от реф. цена;
 * 2) световният пазар изкупува поръчки под 80% от реф. цена (ценови под) в ограничен обем;
 * 3) световният пазар продава на купувачи, предлагащи над 125% от реф. цена (ценови таван) в ограничен обем;
 * 4) референтната цена се обновява от нетното търсене и себестойността (виж economy-engine).
 */
export async function marketDailyGood(
  prisma: PrismaClient,
  good: GoodId,
  tick: number,
  retailDemand: number,
  refs: Record<GoodId, number>,
  cityDemand: Map<string, number>,
) {
  return withTx(
    prisma,
    async (tx) => {
      const instrument = `GOOD:${good}`;
      await lockInstrument(tx, instrument);
      const done = await tx.priceHistory.findUnique({ where: { instrument_tick: { instrument, tick } } });
      if (done) return { supplied: 0, imported: 0 };
      const M = BALANCE.market;
      const ref = refs[good];
      const def = GOODS[good];
      let supplied = 0;
      let exported = 0;
      let imported = 0;
      // 1) Потребление + 2) износ: купуване от продажните поръчки.
      const sells = await tx.$queryRaw<
        MarketOrder[]
      >`SELECT * FROM "MarketOrder" WHERE instrument = ${instrument} AND side = 'SELL' AND status = 'OPEN' AND remaining > 0 AND price <= ${Math.round(ref * M.retailMaxPremium)} ORDER BY price ASC, id ASC FOR UPDATE`;
      let retailLeft = retailDemand;
      let exportLeft = Math.round(def.worldVolume * 0.6);
      for (const o of sells) {
        const price = Number(o.price);
        let q = 0;
        let kind = 'RETAIL';
        if (retailLeft > 0) {
          q = Math.min(retailLeft, o.remaining);
          retailLeft -= q;
          supplied += q;
        } else if (price <= ref * M.exportFloor && exportLeft > 0) {
          q = Math.min(exportLeft, o.remaining);
          exportLeft -= q;
          exported += q;
          kind = 'EXPORT';
        }
        if (q <= 0) continue;
        await npcBuy(tx, o, q, price, tick, kind);
      }
      // 3) Внос: световният пазар продава на високите купувачи.
      const buys = await tx.$queryRaw<
        MarketOrder[]
      >`SELECT * FROM "MarketOrder" WHERE instrument = ${instrument} AND side = 'BUY' AND status = 'OPEN' AND remaining > 0 AND price >= ${Math.round(ref * M.importPremium)} ORDER BY price DESC, id ASC FOR UPDATE`;
      let importLeft = def.worldVolume;
      for (const o of buys) {
        if (importLeft <= 0) break;
        const q = Math.min(importLeft, o.remaining);
        const price = Math.round(ref * M.importPremium);
        importLeft -= q;
        imported += q;
        await npcSell(tx, o, q, price, tick);
      }
      // 4) Ценови сигнал от неудовлетвореното търсене и натиска в книгата.
      const pressure = await tx.$queryRaw<
        { side: string; qty: bigint | null }[]
      >`SELECT side, SUM(remaining)::bigint AS qty FROM "MarketOrder" WHERE instrument = ${instrument} AND status = 'OPEN' GROUP BY side`;
      const openSell = Number(pressure.find((p) => p.side === 'SELL')?.qty ?? 0);
      const openBuy = Number(pressure.find((p) => p.side === 'BUY')?.qty ?? 0);
      const unmet = retailLeft;
      const excess = unmet * 0.5 + imported - exported + 0.05 * openBuy - 0.05 * openSell;
      const newRef = nextReferencePrice({ good, ref, excessDemand: excess, volume: def.worldVolume + retailDemand, refs });
      const state = await tx.marketState.findUnique({ where: { instrument } });
      await tx.priceHistory.create({
        data: {
          instrument,
          tick,
          ref: BigInt(newRef),
          last: state?.lastPrice ?? null,
          volume: (state?.dayVolume ?? 0) + supplied + exported + imported,
          unmet,
        },
      });
      await tx.marketState.update({
        where: { instrument },
        data: { refPrice: BigInt(newRef), dayVolume: 0, unmetDemand: unmet, dayImports: imported, dayExports: exported },
      });
      // Удовлетвореност на градовете: местни доставки = 1, вносни = 0.6.
      if (retailDemand > 0) {
        const sat = (supplied + unmet * 0.6) / retailDemand;
        for (const [cityId] of cityDemand)
          await tx.$executeRaw`UPDATE "City" SET "retailSatisfaction" = LEAST(1, GREATEST(0, ("retailSatisfaction" * 0.5) + ${sat * 0.5})) WHERE id = ${cityId}`;
      }
      return { supplied, imported, exported, unmet, newRef };
    },
    { timeoutMs: 60_000 },
  );
}

async function npcBuy(tx: Tx, o: MarketOrder, q: number, price: number, tick: number, kind: string) {
  const good = o.instrument.slice(5) as GoodId;
  const gross = q * price;
  await consumeReserved(tx, o.traderId, o.cityId!, good, q);
  const trade = await tx.trade.create({
    data: {
      instrument: o.instrument,
      price: BigInt(price),
      quantity: q,
      sellOrderId: o.id,
      buyerType: 'SYSTEM',
      buyerId: kind.toLowerCase(),
      sellerType: o.traderType,
      sellerId: o.traderId,
      kind,
      tick,
    },
  });
  const fee = Math.floor(gross * BALANCE.market.tradeFee);
  let salesTax = 0;
  if (kind === 'RETAIL') {
    const city = await tx.city.findUnique({ where: { id: o.cityId! }, select: { policy: true } });
    salesTax = Math.floor(gross * ((city?.policy as unknown as CityPolicy)?.taxes.sales ?? 0));
  }
  await transfer(tx, {
    from: SYS.WORLD,
    to: acc.of(o.traderType as OwnerT, o.traderId),
    amount: gross - fee - salesTax,
    kind: `${kind}_SALE`,
    tick,
    key: `trade:${trade.id}:proceeds`,
    refType: 'Trade',
    refId: String(trade.id),
  });
  await transfer(tx, { from: SYS.WORLD, to: SYS.FEES, amount: fee, kind: 'TRADE_FEE', tick, key: `trade:${trade.id}:fee` });
  if (salesTax > 0)
    await transfer(tx, { from: SYS.WORLD, to: acc.city(o.cityId!), amount: salesTax, kind: 'SALES_TAX', tick, key: `trade:${trade.id}:salestax` });
  const remaining = o.remaining - q;
  await tx.marketOrder.update({ where: { id: o.id }, data: { remaining, status: remaining === 0 ? 'FILLED' : 'OPEN' } });
  o.remaining = remaining;
  await tx.marketState.update({ where: { instrument: o.instrument }, data: { lastPrice: BigInt(price) } });
}

async function npcSell(tx: Tx, o: MarketOrder, q: number, price: number, tick: number) {
  const good = o.instrument.slice(5) as GoodId;
  const reserved = Number(o.price) * q;
  const trade = await tx.trade.create({
    data: {
      instrument: o.instrument,
      price: BigInt(price),
      quantity: q,
      buyOrderId: o.id,
      buyerType: o.traderType,
      buyerId: o.traderId,
      sellerType: 'SYSTEM',
      sellerId: 'import',
      kind: 'IMPORT',
      tick,
    },
  });
  await transfer(tx, { from: SYS.ESCROW, to: SYS.WORLD, amount: price * q, kind: 'IMPORT_PURCHASE', tick, key: `trade:${trade.id}:import` });
  if (reserved - price * q > 0)
    await transfer(tx, {
      from: SYS.ESCROW,
      to: acc.of(o.traderType as OwnerT, o.traderId),
      amount: reserved - price * q,
      kind: 'ESCROW_REFUND',
      tick,
      key: `trade:${trade.id}:refund`,
    });
  await tx.shipment.create({
    data: {
      companyId: o.traderId,
      good,
      quantity: q,
      fromCityId: 'WORLD',
      toCityId: o.cityId!,
      departTick: tick,
      arriveTick: tick + 2,
      refType: 'Trade',
      refId: String(trade.id),
    },
  });
  const remaining = o.remaining - q;
  await tx.marketOrder.update({ where: { id: o.id }, data: { remaining, escrow: o.escrow - BigInt(reserved), status: remaining === 0 ? 'FILLED' : 'OPEN' } });
  o.remaining = remaining;
  o.escrow = o.escrow - BigInt(reserved);
}

/** Пристигане на доставки (worker). */
export async function deliverShipments(prisma: PrismaClient, tick: number) {
  const due = await prisma.shipment.findMany({ where: { status: 'IN_TRANSIT', arriveTick: { lte: tick } }, take: 2000 });
  let delivered = 0;
  for (const s of due) {
    await withTx(prisma, async (tx) => {
      const n = await tx.shipment.updateMany({ where: { id: s.id, status: 'IN_TRANSIT' }, data: { status: 'DELIVERED' } });
      if (n.count !== 1) return;
      const company = await tx.company.findUnique({ where: { id: s.companyId } });
      if (!company || company.status !== 'ACTIVE') return;
      const trade = s.refType === 'Trade' && s.refId ? await tx.trade.findUnique({ where: { id: BigInt(s.refId) } }) : null;
      await addGoods(tx, s.companyId, s.toCityId, s.good as GoodId, s.quantity, trade ? Number(trade.price) : 0);
      delivered++;
    });
  }
  return delivered;
}

export async function refPricesNow(prisma: PrismaClient) {
  return refPrices(prisma);
}

export { Prisma };
