import { BALANCE, DAYS_PER_YEAR, clamp } from '@gce/shared';

/** Анюитетна вноска за период (кредит, изплащан на равни вноски). */
export function annuityPayment(principal: number, annualRate: number, termDays: number, intervalDays: number): number {
  const n = Math.max(1, Math.round(termDays / intervalDays));
  const r = (annualRate * intervalDays) / DAYS_PER_YEAR;
  if (r <= 0) return Math.ceil(principal / n);
  return Math.ceil((principal * r) / (1 - Math.pow(1 + r, -n)));
}

/** Лихва за период върху остатъка. */
export function periodInterest(balance: number, annualRate: number, intervalDays: number): number {
  return Math.round((balance * annualRate * intervalDays) / DAYS_PER_YEAR);
}

export const RATINGS = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'D'] as const;
export type Rating = (typeof RATINGS)[number];

export interface CreditInputs {
  assets: number; // центове
  debt: number;
  cash: number;
  /** Среден дневен нетен паричен поток за последните 30 дни. */
  dailyCashFlow: number;
  /** Дневни задължения за лихви/вноски. */
  dailyDebtService: number;
  missedPayments: number;
  defaulted: boolean;
}

/**
 * Кредитен рейтинг: точкова система от ливъридж, покритие на дълга, ликвидност и история на плащанията.
 * Резултатът е детерминистичен и обясним.
 */
export function creditScore(i: CreditInputs): { score: number; rating: Rating } {
  if (i.defaulted) return { score: 0, rating: 'D' };
  let score = 70;
  const leverage = i.assets > 0 ? i.debt / i.assets : i.debt > 0 ? 2 : 0;
  score -= clamp(leverage, 0, 2) * 30;
  const coverage = i.dailyDebtService > 0 ? i.dailyCashFlow / i.dailyDebtService : i.dailyCashFlow >= 0 ? 5 : -1;
  score += clamp(coverage, -2, 5) * 5;
  const liquidity = i.debt > 0 ? i.cash / i.debt : 1;
  score += clamp(liquidity, 0, 1) * 10;
  score -= i.missedPayments * 12;
  score = clamp(Math.round(score), 1, 100);
  const rating: Rating = score >= 90 ? 'AAA' : score >= 80 ? 'AA' : score >= 70 ? 'A' : score >= 60 ? 'BBB' : score >= 48 ? 'BB' : score >= 35 ? 'B' : 'CCC';
  return { score, rating };
}

export function loanRate(baseRate: number, rating: Rating): number {
  return clamp(baseRate + (BALANCE.banking.spreads[rating] ?? 0.2), BALANCE.banking.minRate, 0.6);
}

export function maxBorrowing(assets: number, existingDebt: number, rating: Rating): number {
  const lev = BALANCE.banking.maxLeverage[rating] ?? 0;
  return Math.max(0, Math.floor(assets * lev - existingDebt));
}

/**
 * Правило на централната банка (тип Тейлър): базовата лихва реагира на инфлацията на ценовия индекс
 * и на растежа на кредита. Високото кредитиране поскъпва парите -> естествен икономически цикъл.
 */
export function centralBankRate(annualInflation: number, creditGrowth: number): number {
  const B = BALANCE.banking;
  const r = B.neutralRate + B.rateInflationWeight * (annualInflation - B.inflationTarget) + B.rateCreditWeight * creditGrowth;
  return clamp(Math.round(r * 10000) / 10000, B.minRate, B.maxRate);
}

/** Пропорционален данък – резултат в цели центове, никога отрицателен. */
export function tax(base: number, rate: number): number {
  if (base <= 0 || rate <= 0) return 0;
  return Math.floor(base * rate);
}
