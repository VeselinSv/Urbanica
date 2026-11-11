import { BALANCE, clamp } from '@gce/shared';

export type Tri = [number, number, number];

export interface LaborResult {
  /** Заети работници по ниво на работното място (L0/L1/L2 позиции). */
  filledJobs: Tri;
  /** Заети хора по образователно ниво. */
  employedByEdu: Tri;
  unemployedByEdu: Tri;
  vacancies: Tri;
  /** Дял запълнени позиции по ниво. */
  fillRatio: Tri;
}

/**
 * Съпоставяне на работна сила и работни места.
 * По-квалифицираните първо заемат позиции на своето ниво, после по-ниските (свръхквалификация),
 * но никога по-високи. Детерминистично и запазва броя хора (няма "създаване" на работници).
 */
export function matchLabor(workers: Tri, jobs: Tri): LaborResult {
  const avail: Tri = [...workers] as Tri;
  const open: Tri = [...jobs] as Tri;
  const filled: Tri = [0, 0, 0];
  const employed: Tri = [0, 0, 0];
  for (let edu = 2; edu >= 0; edu--) {
    for (let lvl = edu; lvl >= 0; lvl--) {
      const take = Math.min(avail[edu], open[lvl]);
      avail[edu] -= take;
      open[lvl] -= take;
      filled[lvl] += take;
      employed[edu] += take;
    }
  }
  return {
    filledJobs: filled,
    employedByEdu: employed,
    unemployedByEdu: avail,
    vacancies: open,
    fillRatio: [0, 1, 2].map((l) => (jobs[l] > 0 ? filled[l] / jobs[l] : 1)) as Tri,
  };
}

/**
 * Корекция на заплатите: при недостиг на работници (свободни позиции > безработни) заплатата расте,
 * при безработица – пада. Ограничена в [min, max] от конфигурацията.
 */
export function adjustWages(wages: Tri, jobs: Tri, labor: LaborResult): Tri {
  const W = BALANCE.wages;
  return [0, 1, 2].map((l) => {
    const pool = Math.max(1, jobs[l] + labor.unemployedByEdu[l]);
    const pressure = (labor.vacancies[l] - labor.unemployedByEdu[l]) / pool; // -1..1
    const next = wages[l] * (1 + W.adjustSpeed * clamp(pressure, -1, 1));
    return Math.round(clamp(next, W.min[l], W.max[l]));
  }) as Tri;
}

export function payroll(filledJobs: Tri, wages: Tri): number {
  return filledJobs[0] * wages[0] + filledJobs[1] * wages[1] + filledJobs[2] * wages[2];
}

/** Разпределя работни места с образователен микс в три нива (цели числа). */
export function splitJobs(total: number, mix: Tri): Tri {
  const a = Math.round(total * mix[0]);
  const b = Math.round(total * mix[1]);
  const c = Math.max(0, Math.round(total * mix[2]));
  return [a, b, c];
}
