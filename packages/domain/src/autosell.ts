/**
 * Автоматични продажби (решение на компанията): продукцията, която компанията не влага сама, се пуска на борсата
 * на избраната цена спрямо референтната. За всяка стока и град се държи ЕДНА отворена поръчка – старата се
 * отменя и се пуска нова с цялото свободно количество, когато цената се е разминала или е натрупана нова стока.
 */
import { FACILITIES, companyPolicy, type FacilityType, type GoodId } from '@gce/shared';
import type { PrismaClient } from '@gce/database';
import { cancelOrder, placeOrder } from './market';

/** Колко често (в игрови дни) компанията преглежда автоматичните си продажби. */
export const AUTOSELL_EVERY = 5;

export async function autoSell(prisma: PrismaClient, tick: number, refs: Record<GoodId, number>): Promise<number> {
  const companies = await prisma.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true, policy: true, founderId: true } });
  let placed = 0;
  for (const c of companies) {
    const p = companyPolicy(c.policy);
    if (!p.autoSell) continue;
    // компаниите се разпределят по различни дни, за да не се натрупват всички в един тик
    if ((tick + hash(c.id)) % AUTOSELL_EVERY !== 0) continue;
    const ceo = (await prisma.companyRole.findFirst({ where: { companyId: c.id, role: { in: ['CEO', 'MANAGER'] } } }))?.userId ?? c.founderId;
    const facilities = await prisma.facility.findMany({ where: { companyId: c.id }, select: { type: true } });
    // суровините за собствените съоръжения не се продават
    const ownInputs = new Set<string>();
    for (const f of facilities) {
      const def = FACILITIES[f.type as FacilityType];
      for (const g of Object.keys(def.recipe?.inputs ?? {})) ownInputs.add(g);
      if (def.coalUse) ownInputs.add('coal');
    }
    const inv = await prisma.inventory.findMany({ where: { companyId: c.id, quantity: { gt: 0 } } });
    for (const i of inv) {
      if (ownInputs.has(i.good)) continue;
      const ref = refs[i.good as GoodId];
      if (!ref) continue;
      const instrument = `GOOD:${i.good}`;
      const price = Math.max(1, Math.round(ref * p.sellPrice));
      const open = await prisma.marketOrder.findMany({
        where: { traderType: 'COMPANY', traderId: c.id, instrument, cityId: i.cityId, side: 'SELL', status: 'OPEN' },
      });
      const fresh = i.quantity - p.keepStock;
      const priceOff = open.some((o) => Math.abs(Number(o.price) - price) / price > 0.03);
      // нищо ново за продаване и цената е същата – поръчката остава
      if (open.length && !priceOff && fresh < Math.max(20, open.reduce((a, o) => a + o.remaining, 0) * 0.25)) continue;
      for (const o of open) await cancelOrder(prisma, ceo, String(o.id)).catch(() => undefined);
      const now = await prisma.inventory.findUnique({ where: { companyId_cityId_good: { companyId: c.id, cityId: i.cityId, good: i.good } } });
      const qty = (now?.quantity ?? 0) - p.keepStock;
      if (qty < 1) continue;
      const r = await placeOrder(prisma, ceo, { instrument, side: 'SELL', quantity: qty, price, companyId: c.id, cityId: i.cityId }).catch(() => null);
      if (r) placed++;
    }
  }
  return placed;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
