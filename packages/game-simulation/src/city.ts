import {
  BALANCE,
  isWalkable,
  FACILITIES,
  SERVICES,
  ZONES,
  ZONE_TYPES,
  clamp,
  hashString,
  parseKey,
  rand01,
  tileKey,
  type CityDerived,
  type CityPolicy,
  type CityStats,
  type FacilityLoad,
  type PopulationState,
  type ServiceType,
  type TileMap,
  type TileState,
  type ZoneType,
  UPGRADE_REQUIREMENTS,
  type UpgradeRequirement,
  ISSUE_TYPES,
} from '@gce/shared';
import { adjustWages, matchLabor, payroll, splitJobs, tax, type Tri } from '@gce/economy-engine';
import type { WorldGenerator } from '@gce/world-generation';

export interface CityContext {
  /** Средна привлекателност на всички градове – за миграция между градовете. */
  worldAttractiveness: number;
  coalPrice: number;
  foodPriceRatio: number;
  priceIndex: number;
  /** Посрещнат дял от потребителското търсене на храни/стоки за предходния ден (0..1). */
  retailSatisfaction: number;
  /** Градът е в режим на финансово оздравяване (принудително намален бюджет). */
  receivership: boolean;
  /** Отворени сигнали от гражданите (дупки, аварии…) – влияят на мрежите, стойността на земята и удовлетвореността. */
  issues?: { kind: string; key: string; severity: number }[];
}

export interface CityInput {
  cityId: string;
  tick: number;
  tiles: TileMap;
  territory: string[];
  pop: PopulationState;
  policy: CityPolicy;
  facilities: FacilityLoad[];
  world: WorldGenerator;
  ctx: CityContext;
}

export interface FacilityStatus {
  staffing: number;
  power: number;
  water: number;
  /** Задължение към града за ток и вода (центове). */
  utilityCharge: number;
  /** Енергия, изкупена от града (единици) и плащане (центове). */
  energySold: number;
  energyRevenue: number;
}

export interface CityEvent {
  type: 'fire' | 'flood' | 'abandon' | 'shortage' | 'growth';
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface CityStepResult {
  tiles: TileMap;
  pop: PopulationState;
  stats: Omit<CityStats, 'treasury' | 'tick'>;
  derived: CityDerived;
  income: Record<string, number>;
  expenses: Record<string, number>;
  facilityStatus: Record<string, FacilityStatus>;
  retailDemand: { food: number; goods: number };
  coalUsed: number;
  events: CityEvent[];
}

const LVL_WEIGHT = [0, 1, 2.5, 6];
const COVERAGE_SERVICES: ServiceType[] = ['school', 'university', 'clinic', 'fire_station', 'police_station', 'bus_depot', 'park', 'parking'];

function neighborsWithin(key: string, r: number): string[] {
  const [x, y] = parseKey(key);
  const out: string[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dy) <= r) out.push(tileKey(x + dx, y + dy));
  return out;
}

function sumTri(a: Tri, b: Tri): Tri {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mixStaffing(jobs: Tri, fill: Tri): number {
  const total = jobs[0] + jobs[1] + jobs[2];
  if (total <= 0) return 1;
  return (jobs[0] * fill[0] + jobs[1] * fill[1] + jobs[2] * fill[2]) / total;
}

/**
 * Една стъпка (един игрови ден) от симулацията на град. Чиста функция:
 * получава състоянието и връща новото състояние + финансови потоци + статистика.
 * Не пипа базата данни и не създава пари – паричните потоци се осчетоводяват от извикващия код.
 */
export function stepCity(input: CityInput): CityStepResult {
  const { tiles: inTiles, policy, world, ctx, tick } = input;
  const seed = hashString(input.cityId);
  const tiles: TileMap = {};
  for (const [k, v] of Object.entries(inTiles)) tiles[k] = { ...v } as TileState;
  const pop: PopulationState = {
    ...input.pop,
    edu: [...input.pop.edu] as Tri,
    wages: [...input.pop.wages] as Tri,
  };
  const events: CityEvent[] = [];
  const P = BALANCE.population;
  const budget = clamp(policy.serviceBudget * (ctx.receivership ? 0.5 : 1), 0.25, 1.5);
  const budgetEff = Math.min(1.1, budget);

  // ---------- 1. Пътна мрежа и достъп ----------
  const roads: string[] = [];
  for (const [k, t] of Object.entries(tiles)) if (t.t === 'road') roads.push(k);
  const access = new Set<string>();
  for (const r of roads) for (const n of neighborsWithin(r, 2)) access.add(n);
  // Пешеходен достъп: тротоар или алея на до 2 плочки от сградата.
  const walkAccess = new Set<string>();
  for (const [k, t] of Object.entries(tiles)) if (isWalkable(t)) for (const n of neighborsWithin(k, 2)) walkAccess.add(n);

  // ---------- 2. Обществени услуги ----------
  type Svc = { key: string; type: ServiceType; eff: number; x: number; y: number };
  const services: Svc[] = [];
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'service') continue;
    // Естествено износване; бюджет над 90% поддържа сградите.
    t.cond = clamp(t.cond - 0.0006 + (budget - 0.9) * 0.002, 0.2, 1);
    const [x, y] = parseKey(k);
    services.push({ key: k, type: t.s, eff: access.has(k) ? t.cond * budgetEff : 0, x, y });
  }

  // ---------- 3. Сгради в зони: товар и работни места ----------
  interface ZoneInfo {
    key: string;
    z: ZoneType;
    lvl: number;
    occ: number;
    jobs: Tri;
    residents: number;
    power: number;
    water: number;
  }
  const zones: ZoneInfo[] = [];
  let housingCap = 0;
  const zoneJobs: Record<ZoneType, number> = { R: 0, C: 0, I: 0, O: 0, A: 0, L: 0, H: 0 };
  const buildings: Record<ZoneType, number> = { R: 0, C: 0, I: 0, O: 0, A: 0, L: 0, H: 0 };
  let abandoned = 0;
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'zone') continue;
    if (t.ab) {
      abandoned++;
      continue;
    }
    if (t.lvl === 0) {
      if (t.prog > 0) zoneJobs[t.z] += ZONES[t.z].capacity[0] * 0.5; // в строеж – очаквани работни места
      continue;
    }
    const def = ZONES[t.z];
    const cap = def.capacity[t.lvl - 1];
    buildings[t.z]++;
    const load = Math.max(0.3, t.occ);
    const info: ZoneInfo = {
      key: k,
      z: t.z,
      lvl: t.lvl,
      occ: t.occ,
      jobs: [0, 0, 0],
      residents: 0,
      power: def.power[t.lvl - 1] * load,
      water: def.water[t.lvl - 1] * load,
    };
    if (t.z === 'R') housingCap += cap;
    else {
      info.jobs = splitJobs(cap * t.occ, def.eduMix as Tri);
      zoneJobs[t.z] += cap * t.occ;
    }
    zones.push(info);
  }

  // ---------- 4. Електричество и вода с приоритети ----------
  let citySupply = 0;
  let coalUsed = 0;
  let waterSupply = 0;
  let sewageCap = 0;
  let wasteCap = 0;
  for (const s of services) {
    const d = SERVICES[s.type];
    if (d.powerSupply) citySupply += d.powerSupply * s.eff;
    if (d.waterSupply) waterSupply += d.waterSupply * s.eff * (world.nearWater(s.x, s.y, 3) ? 1 : 0.4);
    if (d.sewageCapacity) sewageCap += d.sewageCapacity * s.eff;
    if (d.wasteCapacity) wasteCap += d.wasteCapacity * s.eff;
  }
  const companySupply = input.facilities.reduce((a, f) => a + (access.has(f.key) ? f.powerOutput : 0), 0);
  const demandGroups = {
    services: services.reduce((a, s) => a + SERVICES[s.type].power, 0),
    facilities: input.facilities.reduce((a, f) => a + f.power, 0),
    zones: zones.reduce((a, z) => a + z.power, 0),
  };
  const waterGroups = {
    services: services.reduce((a, s) => a + SERVICES[s.type].water, 0),
    facilities: input.facilities.reduce((a, f) => a + f.water, 0),
    zones: zones.reduce((a, z) => a + z.water, 0),
  };
  const powerDemand = demandGroups.services + demandGroups.facilities + demandGroups.zones;
  const waterDemand = waterGroups.services + waterGroups.facilities + waterGroups.zones;
  // Аварии от сигналите намаляват наличните ток и вода.
  const openIssues = ctx.issues ?? [];
  let waterLoss = 0;
  let powerLoss = 0;
  for (const is of openIssues) {
    const def = ISSUE_TYPES[is.kind];
    if (!def) continue;
    waterLoss += (def.effects.waterLoss ?? 0) * is.severity;
    powerLoss += (def.effects.powerLoss ?? 0) * is.severity;
  }
  waterSupply *= 1 - Math.min(0.5, waterLoss);
  const totalPowerSupply = (citySupply + companySupply) * (1 - Math.min(0.5, powerLoss));
  const allocate = (supply: number, groups: Record<'services' | 'facilities' | 'zones', number>) => {
    let remaining = supply;
    const ratio = { services: 1, facilities: 1, zones: 1 };
    for (const g of policy.powerPriority) {
      const need = groups[g];
      if (need <= 0) continue;
      const got = Math.min(need, remaining);
      ratio[g] = got / need;
      remaining -= got;
    }
    return ratio;
  };
  const powerRatio = allocate(totalPowerSupply, demandGroups);
  const waterRatio = allocate(waterSupply, waterGroups);
  // Градът използва първо собствените централи, после изкупува от частните.
  const ownUsed = Math.min(citySupply, powerDemand);
  const purchased = Math.min(companySupply, Math.max(0, powerDemand - ownUsed));
  for (const s of services) {
    const d = SERVICES[s.type];
    if (d.coalUse && d.powerSupply && citySupply > 0) coalUsed += d.coalUse * s.eff * Math.min(1, ownUsed / citySupply);
  }
  coalUsed = Math.ceil(coalUsed);
  const U = BALANCE.utilities;
  const scarcity = totalPowerSupply > 0 ? powerDemand / totalPowerSupply : 2;
  const energyPrice = Math.round(
    clamp(U.energyBuyBase * Math.pow(Math.max(0.3, scarcity), U.energyScarcityElasticity), U.energyBuyBase * 0.5, U.energyBuyBase * 3),
  );
  if (powerRatio.zones < 0.95 && powerDemand > 0)
    events.push({
      type: 'shortage',
      message: `Недостиг на електроенергия: покрити ${(powerRatio.zones * 100).toFixed(0)}% от нуждите на сградите`,
      severity: 'warning',
    });
  if (waterRatio.zones < 0.95 && waterDemand > 0)
    events.push({ type: 'shortage', message: `Недостиг на вода: покрити ${(waterRatio.zones * 100).toFixed(0)}% от нуждите`, severity: 'warning' });

  const powerSpare = totalPowerSupply - powerDemand;
  const waterSpare = waterSupply - waterDemand;
  const tilePowered = (k: string, ratio: number) => access.has(k) && rand01(seed, tick, hashString(k), 7) < ratio + 1e-9;

  // ---------- 5. Трудов пазар ----------
  const totalPop = pop.edu[0] + pop.edu[1] + pop.edu[2];
  const workers: Tri = pop.edu.map((e) => Math.floor(e * P.workforceShare)) as Tri;
  let jobs: Tri = [0, 0, 0];
  for (const z of zones) jobs = sumTri(jobs, z.jobs);
  const serviceJobs: Tri = services.reduce((a, s) => sumTri(a, s.eff > 0 ? (SERVICES[s.type].staff as Tri) : [0, 0, 0]), [0, 0, 0] as Tri);
  const facilityJobs: Tri = input.facilities.reduce((a, f) => sumTri(a, access.has(f.key) ? f.jobs : [0, 0, 0]), [0, 0, 0] as Tri);
  jobs = sumTri(sumTri(jobs, serviceJobs), facilityJobs);
  const labor = matchLabor(workers, jobs);
  const employedTotal = labor.employedByEdu[0] + labor.employedByEdu[1] + labor.employedByEdu[2];
  const workforce = workers[0] + workers[1] + workers[2];
  const unemployed = workforce - employedTotal;
  const vacancies = labor.vacancies[0] + labor.vacancies[1] + labor.vacancies[2];
  const unemploymentRate = workforce > 0 ? unemployed / workforce : 0;
  const totalPayroll = payroll(labor.filledJobs, pop.wages);
  const servicePayroll = Math.round(
    serviceJobs[0] * labor.fillRatio[0] * pop.wages[0] +
      serviceJobs[1] * labor.fillRatio[1] * pop.wages[1] +
      serviceJobs[2] * labor.fillRatio[2] * pop.wages[2],
  );

  // ---------- 6. Покритие с услуги ----------
  const coverage: Record<string, Record<string, number>> = {};
  const covAt = (k: string, kind: ServiceType) => coverage[kind]?.[k] ?? 0;
  const capacityRatio: Partial<Record<ServiceType, number>> = {};
  const needs: Partial<Record<ServiceType, number>> = {
    school: totalPop * 0.15,
    university: (pop.edu[1] + pop.edu[0] * 0.2) * 0.1,
    clinic: totalPop,
    bus_depot: employedTotal,
  };
  // автобусните спирки работят само ако има депо – всяка спирка дава обхват около себе си
  const depotEff = Math.max(0, ...services.filter((s) => s.type === 'bus_depot').map((s) => s.eff));
  const stops: { x: number; y: number }[] = [];
  if (depotEff > 0)
    for (const [k, t] of Object.entries(tiles))
      if (t.t === 'road' && t.st) {
        const [x, y] = parseKey(k);
        stops.push({ x, y });
      }
  for (const type of COVERAGE_SERVICES) {
    const list = services.filter((s) => s.type === type && s.eff > 0);
    const cap = list.reduce((a, s) => a + (SERVICES[type].capacity ?? 0) * s.eff, 0);
    const need = needs[type];
    capacityRatio[type] = need === undefined ? 1 : need <= 0 ? 1 : clamp(cap / need, 0, 1);
    const r = SERVICES[type].radius;
    const m: Record<string, number> = {};
    for (const k of input.territory) {
      const [x, y] = parseKey(k);
      let best = 0;
      for (const s of list) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= r) best = Math.max(best, s.eff * (1 - (d / (r + 1)) * 0.5));
      }
      if (type === 'bus_depot') {
        const sr = BALANCE.construction.busStopRadius;
        for (const s of stops) {
          const d = Math.hypot(s.x - x, s.y - y);
          if (d <= sr) best = Math.max(best, depotEff * (1 - (d / (sr + 1)) * 0.5));
        }
      }
      if (best > 0) m[k] = Math.min(1, best);
    }
    coverage[type] = m;
  }

  // ---------- 7. Замърсяване ----------
  const pollution: Record<string, number> = {};
  const emit = (key: string, amount: number) => {
    if (amount === 0) return;
    const R = BALANCE.pollution.radius;
    const [x, y] = parseKey(key);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d > R) continue;
        const v = amount * Math.max(0, 1 - d * BALANCE.pollution.decayPerTile);
        if (v === 0) continue;
        const kk = tileKey(x + dx, y + dy);
        pollution[kk] = (pollution[kk] ?? 0) + v;
      }
  };
  for (const z of zones) emit(z.key, ZONES[z.z].pollution[z.lvl - 1] * z.occ);
  for (const s of services) emit(s.key, SERVICES[s.type].pollution * (s.eff > 0 ? 1 : 0));
  for (const f of input.facilities) emit(f.key, f.pollution);
  for (const is of openIssues) emit(is.key, (ISSUE_TYPES[is.kind]?.effects.pollution ?? 0) * is.severity);
  const sewageLoad = totalPop * U.sewagePerResident + employedTotal * U.sewagePerJob;
  const wasteLoad = totalPop * U.wastePerResident + employedTotal * U.wastePerJob;
  const overflow = Math.max(0, sewageLoad - sewageCap) / 50 + Math.max(0, wasteLoad - wasteCap) / 50;
  if (overflow > 0.5) events.push({ type: 'shortage', message: 'Канализацията или сметосъбирането са претоварени – замърсяването расте', severity: 'warning' });

  // ---------- 8. Трафик ----------
  let rx = 0,
    ry = 0,
    rn = 0,
    jx = 0,
    jy = 0,
    jn = 0;
  for (const z of zones) {
    const [x, y] = parseKey(z.key);
    if (z.z === 'R') {
      rx += x;
      ry += y;
      rn++;
    } else {
      jx += x;
      jy += y;
      jn++;
    }
  }
  const avgDist = rn && jn ? Math.hypot(rx / rn - jx / jn, ry / rn - jy / jn) + 3 : 3;
  let transitCovered = 0;
  for (const z of zones) if (z.z === 'R' && covAt(z.key, 'bus_depot') > 0) transitCovered++;
  const transitShare = rn > 0 ? (transitCovered / rn) * (capacityRatio.bus_depot ?? 0) : 0;
  const carTrips = employedTotal * (1 - BALANCE.traffic.busShare * transitShare);
  // Капацитет: категорията на пътя + управлявани кръстовища (кръгово движение, светофари).
  const RC = BALANCE.construction.roadClasses;
  const JC = BALANCE.construction.junctions;
  // Блокирани от катастрофа/авария/дърво пътни плочки не носят капацитет.
  const blocked = new Set(openIssues.filter((i) => ISSUE_TYPES[i.kind]?.effects.blocksRoad).map((i) => i.key));
  let roadCapRaw = 0;
  let roadUpkeep = 0;
  for (const r of roads) {
    if (blocked.has(r)) continue;
    const t = tiles[r] as Extract<TileState, { t: 'road' }>;
    const cls = RC[t.c ?? 'street'] ?? RC.street;
    roadCapRaw += BALANCE.traffic.roadCapacity * cls.capacity;
    roadUpkeep += BALANCE.construction.roadUpkeep * cls.upkeep;
    if (t.j) {
      roadCapRaw += JC[t.j].capacity;
      roadUpkeep += JC[t.j].upkeep;
    }
  }
  const roadCap = Math.max(1, roadCapRaw);
  const congestion = carTrips / roadCap;
  const commuteMinutes = Math.round(avgDist * 2.5 * (1 + congestion * congestion));
  const traffic: Record<string, number> = {};
  for (const r of roads) {
    let near = 0;
    for (const n of neighborsWithin(r, 2)) {
      const t = tiles[n];
      if (t?.t === 'zone' && t.lvl > 0) near += t.lvl;
    }
    traffic[r] = Math.round(congestion * (0.5 + near / 8) * 100) / 100;
  }

  // ---------- 9. Стойност на земята ----------
  // Сигналите наблизо (боклук, графити, канализация) свалят стойността на земята.
  const issueLv: Record<string, number> = {};
  for (const is of openIssues) {
    const lv = ISSUE_TYPES[is.kind]?.effects.landValue ?? 0;
    if (lv) for (const n of neighborsWithin(is.key, 2)) issueLv[n] = (issueLv[n] ?? 0) + lv * is.severity;
  }
  const landValue: Record<string, number> = {};
  let lvSum = 0;
  for (const k of input.territory) {
    const [x, y] = parseKey(k);
    const pol = (pollution[k] ?? 0) + overflow;
    let v = 0.55;
    if (access.has(k)) v += 0.25;
    v += 0.2 * covAt(k, 'school') + 0.15 * covAt(k, 'clinic') + 0.1 * covAt(k, 'police_station') + 0.05 * covAt(k, 'fire_station');
    v += 0.25 * covAt(k, 'park') + 0.15 * covAt(k, 'university') + 0.1 * covAt(k, 'bus_depot');
    if (world.nearWater(x, y, 2)) v += 0.15;
    v -= 0.03 * pol;
    v -= 0.15 * Math.max(0, congestion - 0.8);
    v -= issueLv[k] ?? 0;
    v = clamp(Math.round(v * 100) / 100, 0.1, 2.5);
    landValue[k] = v;
    lvSum += v;
  }
  const landValueAvg = input.territory.length ? lvSum / input.territory.length : 0;

  // ---------- 10. Удовлетвореност и привлекателност ----------
  const T = policy.taxes;
  const D0 = BALANCE.taxes.defaults;
  const E = BALANCE.taxes.demandElasticity;
  const polAvg = zones.length ? zones.reduce((a, z) => a + (pollution[z.key] ?? 0), 0) / zones.length + overflow : overflow;
  const residential = zones.filter((z) => z.z === 'R');
  const avgCov = (kind: ServiceType) => (residential.length ? residential.reduce((a, z) => a + covAt(z.key, kind), 0) / residential.length : 0);
  const eduSvc = avgCov('school') * (capacityRatio.school ?? 0);
  const healthSvc = avgCov('clinic') * (capacityRatio.clinic ?? 0);
  const safetySvc = avgCov('police_station');
  const fireSvc = avgCov('fire_station');
  const transitSvc = transitShare;
  const avgWage = workforce > 0 ? totalPayroll / Math.max(1, employedTotal) : pop.wages[0];
  const rentBurden = (landValueAvg * BALANCE.landValue.base * BALANCE.consumption.rentYield) / 360 / Math.max(1, avgWage);
  let h = 0.55;
  h += 0.18 * clamp((1 - unemploymentRate - 0.85) / 0.15, -1, 1);
  h += 0.1 * eduSvc + 0.1 * healthSvc + 0.05 * safetySvc + 0.03 * fireSvc + 0.03 * transitSvc;
  h -= 0.012 * polAvg;
  h -= (T.income - D0.income) * 1.2;
  h -= 0.15 * (1 - powerRatio.zones) + 0.15 * (1 - waterRatio.zones);
  h -= 0.08 * clamp(congestion - 1, 0, 1);
  h -= 0.1 * (1 - ctx.retailSatisfaction);
  h -= 0.08 * clamp(rentBurden - 0.3, 0, 1);
  h -= 0.04 * clamp(policy.powerTariff / U.defaultPowerTariff - 1, 0, 2);
  // Нерешените сигнали дразнят гражданите.
  h -= Math.min(
    0.2,
    openIssues.reduce((a, i) => a + (ISSUE_TYPES[i.kind]?.effects.happiness ?? 0) * i.severity, 0),
  );
  h = clamp(h, 0, 1);
  pop.happiness = Math.round((pop.happiness * 0.8 + h * 0.2) * 1000) / 1000;
  const vacancyPull = clamp((vacancies - unemployed) / Math.max(50, workforce), -1, 1);
  const attractiveness = clamp(pop.happiness * 0.7 + 0.3 * (0.5 + vacancyPull / 2), 0, 1);

  // ---------- 11. Търсене по зони ----------
  const subsidyEffect = (z: ZoneType) => ((policy.subsidies[z] ?? 0) / 1000) * 0.3;
  const bizTax = -(T.corporate - D0.corporate) * E.corporate - (T.property - D0.property) * E.property;
  const workersL12 = workers[1] + workers[2];
  const hasUniversity = services.some((s) => s.type === 'university' && s.eff > 0);
  const bootstrap = totalPop < 200 ? 0.45 : totalPop < 600 ? 0.2 : 0;
  const migration = clamp(0.5 * vacancyPull + 1.0 * (attractiveness - ctx.worldAttractiveness) + bootstrap + 0.1, -1, 1);
  const occRate = housingCap > 0 ? totalPop / housingCap : 1;
  const ratio = (need: number, have: number, floor: number) => (need - have) / Math.max(floor, need);
  const demand: Record<ZoneType, number> = {
    R: clamp(0.6 * migration + (occRate - 0.8) * 2 - (T.income - D0.income) * E.income - (T.property - D0.property) * E.property + subsidyEffect('R'), -1, 1),
    C: clamp(ratio(totalPop * 0.12 + 6, zoneJobs.C, 20) + bizTax + subsidyEffect('C'), -1, 1),
    I: clamp(ratio(workforce * 0.3 + 12, zoneJobs.I, 20) + 0.3 * (ctx.priceIndex - 1) + bizTax + subsidyEffect('I'), -1, 1),
    O: clamp(ratio(workersL12 * 0.35, zoneJobs.O, 20) + bizTax + subsidyEffect('O'), -1, 1),
    A: clamp(ratio(totalPop * 0.03 + 8, zoneJobs.A, 10) + 0.3 * (ctx.foodPriceRatio - 1) + bizTax + subsidyEffect('A'), -1, 1),
    L: clamp(ratio((zoneJobs.I + zoneJobs.A + facilityJobs[0] + facilityJobs[1]) * 0.15, zoneJobs.L, 10) + bizTax + subsidyEffect('L'), -1, 1),
    H: clamp(ratio(workers[2] * 0.5 + (hasUniversity ? 20 : 0), zoneJobs.H, 10) + bizTax + subsidyEffect('H'), -1, 1),
  };
  for (const z of ZONE_TYPES) demand[z] = Math.round(demand[z] * 1000) / 1000;

  // ---------- 12. Развитие на сградите ----------
  // Условия за надграждане: проверява се всяко изискване за зоната и нивото (виж UPGRADE_REQUIREMENTS).
  const UP = BALANCE.upgrade;
  const sewageOk = sewageCap >= sewageLoad;
  const wasteOk = wasteCap >= wasteLoad;
  const missing = (k: string, z: ZoneType, nextLvl: 2 | 3, occ: number, D: number): UpgradeRequirement[] => {
    const out: UpgradeRequirement[] = [];
    for (const req of UPGRADE_REQUIREMENTS[z][nextLvl - 2]) {
      let ok: boolean;
      switch (req) {
        case 'road':
          ok = access.has(k);
          break;
        case 'sidewalk':
          ok = walkAccess.has(k);
          break;
        case 'power':
          ok = tilePowered(k, powerRatio.zones);
          break;
        case 'water':
          ok = access.has(k) && waterRatio.zones >= UP.waterRatioMin;
          break;
        case 'sewage':
          ok = sewageOk;
          break;
        case 'waste':
          ok = wasteOk;
          break;
        case 'clean_air':
          ok = (pollution[k] ?? 0) <= UP.maxPollution;
          break;
        default:
          ok = covAt(k, req as ServiceType) >= UP.coverageMin;
      }
      if (!ok) out.push(req);
    }
    if ((landValue[k] ?? 0) < ZONES[z].landValueReq[nextLvl - 1]) out.push('land_value');
    if (occ < UP.minOccupancy) out.push('occupancy');
    if (D <= 0) out.push('demand');
    if (issueNear.has(k)) out.push('no_issues');
    return out;
  };
  const issueNear = new Set<string>();
  for (const is of openIssues) for (const n of neighborsWithin(is.key, 2)) issueNear.add(n);
  const levels: Record<string, { next: UpgradeRequirement[]; keep: UpgradeRequirement[] }> = {};
  const upgradeBlockers: Partial<Record<UpgradeRequirement, number>> = {};
  let upgraded = 0;
  const fireRisk = BALANCE.events.fireBaseChance;
  let fires = 0;
  let newlyAbandoned = 0;
  const flooded =
    rand01(seed, tick, 991) <
    BALANCE.events.floodBaseChance *
      25 *
      (input.territory.reduce((a, k) => {
        const [x, y] = parseKey(k);
        return a + world.tileAt(x, y).floodRisk;
      }, 0) /
        Math.max(1, input.territory.length));
  let floodDamage = 0;
  const residentShare = housingCap > 0 ? Math.min(1, totalPop / housingCap) : 0;
  for (const [k, t] of Object.entries(tiles)) {
    if (t.t !== 'zone') continue;
    const def = ZONES[t.z];
    const r = rand01(seed, tick, hashString(k));
    const D = demand[t.z];
    const hasRoad = access.has(k);
    const pOk = !def.needsUtilities || tilePowered(k, powerRatio.zones);
    const wOk = !def.needsUtilities || (access.has(k) && rand01(seed, tick, hashString(k), 11) < waterRatio.zones + 1e-9);
    const ok = hasRoad && pOk && wOk;
    if (t.ab) {
      if (ok && D > 0.3 && r < 0.05) {
        t.ab = false;
        t.hp = 0.6;
        t.lvl = 0;
        t.prog = def.buildDays;
        t.occ = 0;
      }
      continue;
    }
    if (t.lvl === 0) {
      if (t.prog > 0) {
        t.prog -= 1;
        if (t.prog <= 0) {
          t.prog = 0;
          t.lvl = 1;
          t.occ = t.z === 'R' ? 0.1 : 0.3;
          t.hp = 1;
        }
      } else if (ok && (!def.needsUtilities || (powerSpare > 0 && waterSpare > 0)) && D > 0.05 && r < 0.12 + 0.45 * D) {
        // Ново строителство изисква свободен капацитет в мрежите (ток и вода).
        t.prog = def.buildDays;
      }
      continue;
    }
    // Заетост
    if (t.z === 'R') t.occ = Math.round(residentShare * 1000) / 1000;
    else {
      const staffing = mixStaffing(splitJobs(def.capacity[t.lvl - 1], def.eduMix as Tri), labor.fillRatio);
      const target = clamp((0.55 + D * 0.5) * (0.4 + 0.6 * staffing), 0.05, 1);
      t.occ = Math.round((t.occ + (target - t.occ) * 0.15) * 1000) / 1000;
    }
    // Изисквания на текущото ниво (обществени услуги, мрежи) – без заетост и търсене.
    const keep =
      t.lvl >= 2 ? missing(k, t.z, t.lvl as 2 | 3, 1, 1).filter((m) => m !== 'land_value' && m !== 'occupancy' && m !== 'demand' && m !== 'no_issues') : [];
    // Състояние
    let dh = ok ? 0.03 : -0.06;
    if (keep.length) dh -= UP.declinePerDay + 0.03; // компенсира и обичайното възстановяване
    if (D < -0.5) dh -= 0.02;
    if (t.z === 'R' && (pollution[k] ?? 0) > 10) dh -= 0.01;
    if (rand01(seed, tick, hashString(k), 3) < fireRisk * (1 - 0.85 * covAt(k, 'fire_station'))) {
      dh -= 0.5;
      fires++;
    }
    if (flooded) {
      const [x, y] = parseKey(k);
      const fr = world.tileAt(x, y).floodRisk;
      if (fr > 0.3) {
        dh -= 0.4 * fr;
        floodDamage++;
      }
    }
    t.hp = clamp(Math.round((t.hp + dh) * 1000) / 1000, 0, 1);
    // Без условията на текущото ниво сградата слиза едно ниво, вместо да бъде изоставена.
    if (keep.length && t.lvl >= 2 && t.hp < UP.downgradeBelowHp) {
      const lv = t.lvl as 2 | 3;
      t.lvl = (lv - 1) as 1 | 2;
      t.occ = Math.min(1, Math.round(((t.occ * def.capacity[lv - 1]) / def.capacity[lv - 2]) * 1000) / 1000);
      t.hp = 0.7;
    }
    if (t.hp <= 0) {
      t.ab = true;
      t.occ = 0;
      newlyAbandoned++;
      continue;
    }
    // Надграждане – самостоятелно, когато всички условия за следващото ниво са изпълнени.
    const lvl: number = t.lvl;
    const next = lvl < 3 ? missing(k, t.z, (lvl + 1) as 2 | 3, t.occ, D) : [];
    levels[k] = { next, keep };
    for (const m of next) upgradeBlockers[m] = (upgradeBlockers[m] ?? 0) + 1;
    if (lvl < 3 && ok && next.length === 0 && r < UP.chanceBase + UP.chancePerDemand * Math.max(0, D)) {
      const oldCap = def.capacity[lvl - 1];
      t.lvl = (lvl + 1) as 1 | 2 | 3;
      t.occ = Math.round(((t.occ * oldCap) / def.capacity[lvl as 1 | 2]) * 1000) / 1000;
      upgraded++;
      levels[k] = { next: t.lvl < 3 ? missing(k, t.z, (t.lvl + 1) as 2 | 3, t.occ, D) : [], keep: [] };
    }
    // Упадък при продължително отрицателно търсене
    if (lvl > 1 && D < -0.6 && t.occ < 0.3 && r < 0.03) t.lvl = (lvl - 1) as 1 | 2;
  }
  if (flooded) {
    for (const s of services) {
      const fr = world.tileAt(s.x, s.y).floodRisk;
      const st = tiles[s.key];
      if (fr > 0.3 && st?.t === 'service') st.cond = clamp(st.cond - 0.25 * fr, 0.2, 1);
    }
    events.push({ type: 'flood', message: `Наводнение! Засегнати ${floodDamage} сгради в рискови зони`, severity: floodDamage > 0 ? 'critical' : 'warning' });
  }
  if (fires > 0) events.push({ type: 'fire', message: `Пожари в ${fires} сгради`, severity: 'warning' });
  if (newlyAbandoned > 0)
    events.push({ type: 'abandon', message: `${newlyAbandoned} сгради бяха изоставени (липса на услуги или рентабилност)`, severity: 'warning' });

  // ---------- 13. Миграция и образование ----------
  const freeHousing = Math.max(0, housingCap - totalPop);
  if (totalPop > housingCap) {
    // Пренаселеност след изоставяне – излишните жители напускат.
    const excess = totalPop - housingCap;
    for (let l = 0; l < 3; l++) pop.edu[l] = Math.max(0, pop.edu[l] - Math.ceil((excess * pop.edu[l]) / totalPop));
  } else if (migration > 0 && freeHousing > 0) {
    const inflow = Math.min(freeHousing, Math.ceil(migration * (P.minDailyMigrants + housingCap * P.maxDailyGrowthShare)));
    const vac = labor.vacancies;
    const w = [P.initialEduMix[0] * 10 + vac[0], P.initialEduMix[1] * 10 + vac[1], P.initialEduMix[2] * 10 + vac[2]];
    const ws = w[0] + w[1] + w[2];
    let left = inflow;
    for (let l = 2; l >= 1; l--) {
      const add = Math.floor((inflow * w[l]) / ws);
      pop.edu[l] += add;
      left -= add;
    }
    pop.edu[0] += left;
  } else if (migration < 0 && totalPop > 0) {
    const out = Math.floor(-migration * totalPop * P.emigrationShare);
    for (let l = 0; l < 3; l++) pop.edu[l] = Math.max(0, pop.edu[l] - Math.floor((out * pop.edu[l]) / totalPop));
  }
  if (unemploymentRate > 0.15) {
    for (let l = 0; l < 3; l++) pop.edu[l] = Math.max(0, pop.edu[l] - Math.floor(labor.unemployedByEdu[l] * P.unemployedExodus));
  }
  const schoolCap = services.filter((s) => s.type === 'school').reduce((a, s) => a + (SERVICES.school.capacity ?? 0) * s.eff, 0);
  const uniCap = services.filter((s) => s.type === 'university').reduce((a, s) => a + (SERVICES.university.capacity ?? 0) * s.eff, 0);
  pop.schoolProgress += Math.min(schoolCap, pop.edu[0]) / P.schoolDays;
  const grads = Math.min(Math.floor(pop.schoolProgress), pop.edu[0]);
  pop.schoolProgress -= grads;
  pop.edu[0] -= grads;
  pop.edu[1] += grads;
  pop.universityProgress += Math.min(uniCap, pop.edu[1]) / P.universityDays;
  const uniGrads = Math.min(Math.floor(pop.universityProgress), pop.edu[1]);
  pop.universityProgress -= uniGrads;
  pop.edu[1] -= uniGrads;
  pop.edu[2] += uniGrads;
  pop.schoolProgress = Math.round(pop.schoolProgress * 1000) / 1000;
  pop.universityProgress = Math.round(pop.universityProgress * 1000) / 1000;
  pop.wages = adjustWages(pop.wages, jobs, labor);

  // ---------- 14. Финанси на града ----------
  const income: Record<string, number> = {};
  const expenses: Record<string, number> = {};
  income.income_tax = tax(totalPayroll, T.income);
  let propertyBase = 0;
  let zonedValueAdded = 0;
  let zonePower = 0;
  let zoneWater = 0;
  for (const z of zones) {
    propertyBase += (landValue[z.key] ?? 1) * BALANCE.landValue.base * LVL_WEIGHT[z.lvl];
    const staffing = mixStaffing(z.jobs, labor.fillRatio);
    zonedValueAdded += (z.jobs[0] + z.jobs[1] + z.jobs[2]) * staffing * ZONES[z.z].valueAddedPerJob;
    zonePower += z.power * powerRatio.zones;
    zoneWater += z.water * waterRatio.zones;
  }
  income.property_tax = tax(propertyBase / 360, T.property);
  income.corporate_tax_zoned = tax(zonedValueAdded * 0.25, T.corporate);
  const retailSpend = totalPayroll * BALANCE.consumption.retailSpendShare;
  income.sales_tax = tax(retailSpend, T.sales);
  income.utility_fees = Math.round(zonePower * policy.powerTariff * 0.5 + zoneWater * policy.waterTariff * 0.5);

  expenses.road_upkeep = Math.round(roadUpkeep);
  expenses.service_upkeep = Math.round(services.reduce((a, s) => a + SERVICES[s.type].upkeep, 0) * budget);
  expenses.service_wages = Math.round(servicePayroll * Math.min(1, budget + 0.25));
  expenses.fuel = Math.round(coalUsed * ctx.coalPrice);
  expenses.energy_purchases = Math.round(purchased * energyPrice);
  let subsidyCost = 0;
  for (const z of zones) subsidyCost += (policy.subsidies[z.z] ?? 0) * (z.occ > 0 ? 1 : 0);
  expenses.subsidies = Math.round(subsidyCost);

  // Състояние на предприятията и сметки за комунални услуги / изкупена енергия.
  const facilityStatus: Record<string, FacilityStatus> = {};
  const energyShare = companySupply > 0 ? purchased / companySupply : 0;
  let energyPaid = 0;
  const sellers = input.facilities.filter((f) => f.powerOutput > 0 && access.has(f.key));
  for (const f of input.facilities) {
    const reach = access.has(f.key);
    const staffing = reach ? mixStaffing(f.jobs, labor.fillRatio) : 0;
    const pw = reach ? powerRatio.facilities : 0;
    const wt = reach ? waterRatio.facilities : 0;
    const charge = Math.round(f.power * pw * policy.powerTariff + f.water * wt * policy.waterTariff);
    facilityStatus[f.id] = {
      staffing: Math.round(staffing * 1000) / 1000,
      power: Math.round(pw * 1000) / 1000,
      water: Math.round(wt * 1000) / 1000,
      utilityCharge: charge,
      energySold: 0,
      energyRevenue: 0,
    };
  }
  for (let i = 0; i < sellers.length; i++) {
    const f = sellers[i];
    const sold = f.powerOutput * energyShare;
    const pay = i === sellers.length - 1 ? expenses.energy_purchases - energyPaid : Math.round(sold * energyPrice);
    energyPaid += pay;
    facilityStatus[f.id].energySold = Math.round(sold);
    facilityStatus[f.id].energyRevenue = Math.max(0, pay);
  }
  // Комуналните такси на предприятията се осчетоводяват ежедневно от стъпката на компаниите (не тук).

  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const totalExpenses = Object.values(expenses).reduce((a, b) => a + b, 0);

  // ---------- 15. Слоеве и статистика ----------
  const powered: Record<string, number> = {};
  const watered: Record<string, number> = {};
  const activity: Record<string, number> = {};
  for (const z of zones) {
    powered[z.key] = tilePowered(z.key, powerRatio.zones) ? 1 : 0;
    watered[z.key] = access.has(z.key) && waterRatio.zones > 0.5 ? 1 : 0;
    activity[z.key] = Math.round((z.jobs[0] + z.jobs[1] + z.jobs[2]) * mixStaffing(z.jobs, labor.fillRatio) * 10) / 10;
  }
  for (const f of input.facilities) activity[f.key] = (activity[f.key] ?? 0) + f.jobs[0] + f.jobs[1] + f.jobs[2];
  const polOut: Record<string, number> = {};
  for (const [k, v] of Object.entries(pollution)) if (v >= 0.5 && landValue[k] !== undefined) polOut[k] = Math.round(v * 10) / 10;

  const newPop = pop.edu[0] + pop.edu[1] + pop.edu[2];
  const retailDemand = {
    food: Math.ceil(newPop * 0.05),
    goods: Math.ceil(newPop * 0.02),
  };
  const gdp = Math.round(zonedValueAdded + totalPayroll);

  return {
    tiles,
    pop,
    stats: {
      population: newPop,
      edu: [...pop.edu] as Tri,
      workforce,
      jobs,
      employed: labor.employedByEdu,
      unemployed,
      unemploymentRate: Math.round(unemploymentRate * 1000) / 1000,
      vacancies,
      wages: [...pop.wages] as Tri,
      demand,
      power: { supply: Math.round(totalPowerSupply), demand: Math.round(powerDemand), ratio: Math.round(powerRatio.zones * 1000) / 1000, price: energyPrice },
      water: { supply: Math.round(waterSupply), demand: Math.round(waterDemand), ratio: Math.round(waterRatio.zones * 1000) / 1000 },
      sewage: { capacity: Math.round(sewageCap), load: Math.round(sewageLoad) },
      waste: { capacity: Math.round(wasteCap), load: Math.round(wasteLoad) },
      services: {
        education: Math.round(eduSvc * 100) / 100,
        health: Math.round(healthSvc * 100) / 100,
        safety: Math.round(safetySvc * 100) / 100,
        fire: Math.round(fireSvc * 100) / 100,
        transit: Math.round(transitSvc * 100) / 100,
      },
      traffic: { congestion: Math.round(congestion * 100) / 100, commuteMinutes },
      pollutionAvg: Math.round(polAvg * 100) / 100,
      happiness: pop.happiness,
      attractiveness: Math.round(attractiveness * 1000) / 1000,
      landValueAvg: Math.round(landValueAvg * 100) / 100,
      buildings,
      abandoned: abandoned + newlyAbandoned,
      upgradeBlockers,
      upgraded,
      gdp,
      income,
      expenses,
      net: totalIncome - totalExpenses,
    },
    derived: { landValue, pollution: polOut, traffic, powered, watered, activity, levels },
    income,
    expenses,
    facilityStatus,
    retailDemand,
    coalUsed,
    events,
  };
}

/** Брой работни места и товар на съоръжение (с технологичните ефекти), за вход към градската симулация. */
export function facilityLoad(
  f: { id: string; type: keyof typeof FACILITIES; x: number; y: number; lastEnergy: number },
  jobs: [number, number, number],
  pollutionMult: number,
): FacilityLoad {
  const d = FACILITIES[f.type];
  return {
    id: f.id,
    type: f.type,
    key: tileKey(f.x, f.y),
    jobs,
    power: d.power,
    water: d.water,
    pollution: d.pollution * pollutionMult,
    powerOutput: f.lastEnergy,
  };
}

/**
 * Обобщена (адаптивна) симулация за неактивни градове: прилага същата дневна функция N пъти в паметта
 * и връща сумарните потоци. Резултатът е математически идентичен с N отделни дни, само записите са по-малко.
 */
export function stepCityDays(input: CityInput, days: number, ctxForDay?: (d: number) => CityContext): CityStepResult {
  let cur = input;
  let last: CityStepResult | null = null;
  const income: Record<string, number> = {};
  const expenses: Record<string, number> = {};
  const events: CityEvent[] = [];
  let coalUsed = 0;
  const fs: Record<string, FacilityStatus> = {};
  for (let d = 0; d < days; d++) {
    const r = stepCity({ ...cur, tick: input.tick + d, ctx: ctxForDay ? ctxForDay(d) : cur.ctx });
    for (const [k, v] of Object.entries(r.income)) income[k] = (income[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.expenses)) expenses[k] = (expenses[k] ?? 0) + v;
    for (const [id, s] of Object.entries(r.facilityStatus)) {
      const prev = fs[id];
      fs[id] = prev ? { ...s, energySold: prev.energySold + s.energySold, energyRevenue: prev.energyRevenue + s.energyRevenue } : { ...s };
    }
    coalUsed += r.coalUsed;
    events.push(...r.events);
    cur = { ...cur, tiles: r.tiles, pop: r.pop };
    last = r;
  }
  if (!last) throw new Error('days must be >= 1');
  return { ...last, income, expenses, coalUsed, events, facilityStatus: fs };
}
