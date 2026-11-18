import { describe, expect, it } from 'vitest';
import { companyPolicy, companyPolicyEffects, DEFAULT_COMPANY_POLICY } from '@gce/shared';

describe('Решения на компанията', () => {
  it('стойностите се ограничават до позволените граници', () => {
    const p = companyPolicy({ wageLevel: 9, maintenance: -1, sellPrice: 0, keepStock: -5, autoSell: 1 });
    expect(p).toEqual({ wageLevel: 1.5, maintenance: 0.5, autoSell: true, sellPrice: 0.7, keepStock: 0 });
    expect(companyPolicy(undefined)).toEqual(DEFAULT_COMPANY_POLICY);
  });

  it('ниски заплати → по-малко персонал; високи → по-продуктивни', () => {
    const low = companyPolicyEffects(companyPolicy({ wageLevel: 0.8 }));
    const base = companyPolicyEffects(companyPolicy({}));
    const high = companyPolicyEffects(companyPolicy({ wageLevel: 1.4 }));
    expect(low.staffMult).toBeLessThan(base.staffMult);
    expect(base.staffMult).toBe(1);
    expect(high.productivity).toBeGreaterThan(base.productivity);
    expect(high.wageMult).toBeGreaterThan(base.wageMult);
  });

  it('поддръжката определя износването (при двойна – ремонт)', () => {
    const cheap = companyPolicyEffects(companyPolicy({ maintenance: 0.5 }));
    const norm = companyPolicyEffects(companyPolicy({}));
    const rich = companyPolicyEffects(companyPolicy({ maintenance: 2 }));
    expect(cheap.wear).toBeGreaterThan(norm.wear);
    expect(norm.wear).toBeCloseTo(0.0008);
    expect(rich.wear).toBeLessThan(0);
  });
});
