/**
 * Решения на ръководството на компанията – от тях зависи дали тя ще потръгне.
 *
 *  - Заплати: под пазарните хората напускат (по-малко персонал), над пазарните работят по-продуктивно.
 *  - Поддръжка: по-малко пари → съоръженията се износват и произвеждат по-малко; повече → ремонтират се.
 *  - Автоматични продажби: продукцията се пуска на борсата на избраната цена (спрямо референтната).
 *    По-ниска цена – продава се по-бързо; по-висока – повече пари, но може да остане в склада.
 */
export interface CompanyPolicy {
  /** Заплати спрямо пазарните в града (1 = пазарни). */
  wageLevel: number;
  /** Бюджет за поддръжка спрямо нормалния (1 = нормален). */
  maintenance: number;
  /** Автоматично пускане на продукцията за продажба. */
  autoSell: boolean;
  /** Цена при автоматичните продажби спрямо референтната (1 = пазарна). */
  sellPrice: number;
  /** Колко единици от всяка стока да се пазят в склада (за собствени нужди/договори). */
  keepStock: number;
}

export const COMPANY_POLICY_LIMITS = {
  wageLevel: [0.7, 1.5],
  maintenance: [0.5, 2],
  sellPrice: [0.7, 1.4],
  keepStock: [0, 100_000],
} as const;

/** Старите компании (празно policy) – без автоматични продажби; новите се основават с включени (виж foundCompany). */
export const DEFAULT_COMPANY_POLICY: CompanyPolicy = { wageLevel: 1, maintenance: 1, autoSell: false, sellPrice: 0.9, keepStock: 0 };

export function companyPolicy(raw: unknown): CompanyPolicy {
  const p = { ...DEFAULT_COMPANY_POLICY, ...((raw ?? {}) as Partial<CompanyPolicy>) };
  const L = COMPANY_POLICY_LIMITS;
  const c = (v: number, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : a));
  return {
    wageLevel: c(p.wageLevel, L.wageLevel),
    maintenance: c(p.maintenance, L.maintenance),
    autoSell: !!p.autoSell,
    sellPrice: c(p.sellPrice, L.sellPrice),
    keepStock: Math.round(c(p.keepStock, L.keepStock)),
  };
}

/** Ефектът на решенията върху едно съоръжение (използва се от симулацията и от прогнозата в интерфейса). */
export function companyPolicyEffects(p: CompanyPolicy) {
  // под пазарните заплати част от хората напускат; над тях – по-мотивирани (до +15%)
  const staffMult = Math.min(1, Math.max(0.4, p.wageLevel ** 2));
  const productivity = 1 + 0.3 * Math.min(0.5, Math.max(0, p.wageLevel - 1));
  // износване на ден: 0.08% при нормална поддръжка; при двойна – съоръженията се ремонтират
  const wear = 0.0008 * (2 - p.maintenance) - 0.0006 * Math.max(0, p.maintenance - 1);
  return { staffMult, productivity, wear, upkeepMult: p.maintenance, wageMult: p.wageLevel };
}
