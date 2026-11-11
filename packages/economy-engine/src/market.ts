import { BALANCE, GOODS, clamp, type GoodId, type Side } from '@gce/shared';

export interface BookOrder {
  id: string;
  side: Side;
  price: number;
  remaining: number;
  createdSeq: number; // монотонно нарастващ ред за ценово-времеви приоритет
  ownerKey: string; // "USER:id" / "COMPANY:id" – за забрана на самотърговия
}

export interface Fill {
  makerId: string;
  quantity: number;
  price: number;
}

/** Сортиране на противоположната страна по ценово-времеви приоритет. */
export function sortBook(orders: BookOrder[], side: Side): BookOrder[] {
  // side = страната на насрещните поръчки
  return [...orders].sort((a, b) => (side === 'SELL' ? a.price - b.price : b.price - a.price) || a.createdSeq - b.createdSeq);
}

/**
 * Чисто (без странични ефекти) съпоставяне на входяща лимитирана поръчка с книгата.
 * Цената на сделката е цената на чакащата (maker) поръчка. Собствени поръчки се пропускат.
 * `allow` позволява външни ограничения (санкции).
 */
export function matchIncoming(
  incoming: { side: Side; price: number; quantity: number; ownerKey: string },
  book: BookOrder[],
  allow: (maker: BookOrder) => boolean = () => true,
): { fills: Fill[]; remaining: number } {
  const opposite: Side = incoming.side === 'BUY' ? 'SELL' : 'BUY';
  const sorted = sortBook(
    book.filter((o) => o.side === opposite && o.remaining > 0),
    opposite,
  );
  let remaining = incoming.quantity;
  const fills: Fill[] = [];
  for (const maker of sorted) {
    if (remaining <= 0) break;
    const crosses = incoming.side === 'BUY' ? maker.price <= incoming.price : maker.price >= incoming.price;
    if (!crosses) break;
    if (maker.ownerKey === incoming.ownerKey) continue;
    if (!allow(maker)) continue;
    const q = Math.min(remaining, maker.remaining);
    fills.push({ makerId: maker.id, quantity: q, price: maker.price });
    remaining -= q;
  }
  return { fills, remaining };
}

export interface PriceSignal {
  good: GoodId;
  ref: number;
  /** Нетно неудовлетворено търсене (положително = недостиг) в единици за деня. */
  excessDemand: number;
  /** Базов обем за нормиране. */
  volume: number;
  /** Текущи референтни цени (за cost-push на преработените стоки). */
  refs: Record<GoodId, number>;
}

/**
 * Нова референтна цена от търсене и предлагане:
 *   P' = P * exp(k * clamp(excess/volume)) , после частично приближаване към себестойността
 *   (входове по текущи цени * надценка). Ограничена между 20% и 600% от базовата цена.
 * Така недостигът на суровина вдига цената ѝ, а оттам и себестойността на свързаните продукти.
 */
export function nextReferencePrice(s: PriceSignal): number {
  const M = BALANCE.market;
  const def = GOODS[s.good];
  const signal = clamp(s.excessDemand / Math.max(1, s.volume), -1, 1);
  let p = s.ref * Math.exp(M.priceAdjust * signal);
  // Световният пазар е котва: при липса на сигнал цената бавно се връща към базовото ниво.
  p += (def.basePrice - p) * M.meanReversion;
  if (def.costInputs && def.costOutput) {
    let cost = 0;
    let baseCost = 0;
    for (const [g, q] of Object.entries(def.costInputs) as [GoodId, number][]) {
      cost += s.refs[g] * q;
      baseCost += GOODS[g].basePrice * q;
    }
    // Себестойността се пренася относително: при базови цени на входовете равновесието е базовата цена.
    const unitCost = baseCost > 0 ? def.basePrice * (cost / baseCost) : def.basePrice;
    p = p * (1 - M.costPushWeight) + unitCost * M.costPushWeight;
  }
  return Math.round(clamp(p, def.basePrice * M.minPriceShare, def.basePrice * M.maxPriceShare));
}

/** Ценови индекс (средно претеглено спрямо базовите цени), 1.0 = базово ниво. */
export function priceIndex(refs: Record<GoodId, number>): number {
  let num = 0;
  let den = 0;
  for (const g of Object.values(GOODS)) {
    const w = g.worldVolume * g.basePrice;
    num += (refs[g.id] / g.basePrice) * w;
    den += w;
  }
  return den > 0 ? num / den : 1;
}

/** Транспорт: разход и време според разстоянието (плочки) и технологичния множител. */
export function shippingQuote(distanceTiles: number, quantity: number, mult = 1): { cost: number; days: number } {
  const C = BALANCE.company;
  const cost = Math.round(distanceTiles * quantity * C.shippingCostPerUnitPerTile * mult);
  const days = distanceTiles <= 0 ? 0 : C.shippingBaseDays + Math.floor(distanceTiles / C.tilesPerShippingDay);
  return { cost, days };
}
