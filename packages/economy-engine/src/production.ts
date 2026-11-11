import { BALANCE, FACILITIES, TECHS, type FacilityType, type GoodId, type TechId } from '@gce/shared';

export interface TechEffects {
  outputMult: number;
  staffMult: number;
  inputMult: number;
  shippingMult: number;
  pollutionMult: number;
}

/** Обединява ефектите на наличните технологии за даден тип съоръжение. */
export function techEffects(type: FacilityType | null, techs: Iterable<TechId>): TechEffects {
  const e: TechEffects = { outputMult: 1, staffMult: 1, inputMult: 1, shippingMult: 1, pollutionMult: 1 };
  const sector = type ? FACILITIES[type].sector : null;
  for (const id of techs) {
    const t = TECHS[id].effect;
    if (t.shippingMult) e.shippingMult *= t.shippingMult;
    if (t.pollutionMult) e.pollutionMult *= t.pollutionMult;
    if (t.sector && t.sector !== sector) continue;
    if (t.outputMult) e.outputMult *= t.outputMult;
    if (t.staffMult) e.staffMult *= t.staffMult;
    if (t.inputMult) e.inputMult *= t.inputMult;
  }
  return e;
}

export function requiredJobs(type: FacilityType, fx: TechEffects): [number, number, number] {
  return FACILITIES[type].jobs.map((j) => Math.ceil(j * fx.staffMult)) as [number, number, number];
}

export interface ProductionInput {
  type: FacilityType;
  staffing: number; // 0..1
  power: number; // 0..1 (за енергийни мощности = 1)
  condition: number; // 0..1
  placementFactor: number; // плодородие/богатство на находището
  upgrades: number;
  fx: TechEffects;
  carry: number; // натрупани дробни цикли
  inventory: Partial<Record<GoodId, number>>;
  storageFree: number;
}

export interface ProductionResult {
  runs: number;
  consumed: Partial<Record<GoodId, number>>;
  produced: Partial<Record<GoodId, number>>;
  carry: number;
  energy: number;
  coalUsed: number;
  pollution: number;
  /** Ограничаващ фактор за обяснение в интерфейса. */
  limitedBy: 'none' | 'staff' | 'power' | 'inputs' | 'storage' | 'idle';
}

/**
 * Дневно производство на едно съоръжение. Чиста функция – не създава стоки извън рецептата:
 * произведеното е ограничено от персонал, ток, състояние, входни суровини и свободен склад.
 */
export function produce(p: ProductionInput): ProductionResult {
  const def = FACILITIES[p.type];
  const pollution = def.pollution * p.fx.pollutionMult * Math.min(1, p.staffing);
  const upgradeMult = 1 + p.upgrades * BALANCE.company.machineryUpgradeBonus;
  const empty: ProductionResult = { runs: 0, consumed: {}, produced: {}, carry: p.carry, energy: 0, coalUsed: 0, pollution: 0, limitedBy: 'idle' };

  if (def.powerOutput) {
    // Енергийна мощност: продава енергия към градската мрежа.
    let factor = Math.min(p.staffing, p.condition);
    let coalUsed = 0;
    if (def.coalUse) {
      const need = Math.ceil(def.coalUse * factor);
      coalUsed = Math.min(need, p.inventory.coal ?? 0);
      factor = need > 0 ? factor * (coalUsed / need) : 0;
    }
    const energy = Math.floor(def.powerOutput * factor * p.fx.outputMult * upgradeMult);
    return {
      ...empty,
      runs: energy > 0 ? 1 : 0,
      consumed: coalUsed ? { coal: coalUsed } : {},
      energy,
      coalUsed,
      pollution: pollution * factor,
      limitedBy: factor < 1 ? (p.staffing < 1 ? 'staff' : 'inputs') : 'none',
    };
  }

  const recipe = def.recipe;
  if (!recipe) return { ...empty, pollution };

  const capacity = recipe.runsPerDay * p.fx.outputMult * upgradeMult * p.placementFactor;
  let limitedBy: ProductionResult['limitedBy'] = 'none';
  let factor = 1;
  if (p.staffing < factor) {
    factor = p.staffing;
    limitedBy = 'staff';
  }
  if (p.power < factor) {
    factor = p.power;
    limitedBy = 'power';
  }
  factor *= p.condition;
  let possible = capacity * factor + p.carry;

  // Ограничение от входни суровини.
  for (const [g, q] of Object.entries(recipe.inputs) as [GoodId, number][]) {
    const perRun = q * p.fx.inputMult;
    const maxRuns = (p.inventory[g] ?? 0) / perRun;
    if (maxRuns < possible) {
      possible = maxRuns;
      limitedBy = 'inputs';
    }
  }
  // Ограничение от свободен склад (нетно увеличение на наличностите).
  let outPerRun = 0;
  for (const q of Object.values(recipe.outputs)) outPerRun += q ?? 0;
  let inPerRun = 0;
  for (const q of Object.values(recipe.inputs)) inPerRun += (q ?? 0) * p.fx.inputMult;
  const netPerRun = outPerRun - inPerRun;
  if (netPerRun > 0 && p.storageFree / netPerRun < possible) {
    possible = Math.max(0, p.storageFree / netPerRun);
    limitedBy = 'storage';
  }

  const runs = Math.floor(possible);
  const carry = Math.min(1, possible - runs);
  const consumed: Partial<Record<GoodId, number>> = {};
  const produced: Partial<Record<GoodId, number>> = {};
  if (runs > 0) {
    for (const [g, q] of Object.entries(recipe.inputs) as [GoodId, number][]) consumed[g] = Math.ceil(q * p.fx.inputMult * runs);
    for (const [g, q] of Object.entries(recipe.outputs) as [GoodId, number][]) produced[g] = q * runs;
  }
  return {
    runs,
    consumed,
    produced,
    carry,
    energy: 0,
    coalUsed: 0,
    pollution: pollution * Math.min(1, factor),
    limitedBy: runs === 0 && limitedBy === 'none' ? 'idle' : limitedBy,
  };
}
