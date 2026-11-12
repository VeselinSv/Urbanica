import type { FacilityType, GoodId, ServiceType, UpgradeRequirement, ZoneType } from './catalog';

/** Категории пътища: улица (по подразбиране), булевард, градска магистрала, селски и индустриален път. */
export const ROAD_CLASSES = ['street', 'avenue', 'highway', 'rural', 'industrial'] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
/** Управление на кръстовище: кръгово движение или светофари (иначе – обикновено кръстовище с приоритет). */
export const JUNCTION_TYPES = ['roundabout', 'signals'] as const;
export type JunctionControl = (typeof JUNCTION_TYPES)[number];

/** Пътищата, които по подразбиране се строят с тротоари (останалите – с банкет). */
export const SIDEWALK_BY_DEFAULT: readonly RoadClass[] = ['street', 'avenue'];

/** Състояние на плочка в града. Ключът в картата е "x,y" в световни координати. */
export type TileState =
  /** Път; `st` – автобусна спирка; `sw` – тротоари от двете страни (ако липсва – според категорията, виж SIDEWALK_BY_DEFAULT). */
  | { t: 'road'; c?: RoadClass; j?: JunctionControl; sw?: boolean; st?: boolean }
  /** Пешеходна алея – само за хора (без коли). */
  | { t: 'path' }
  | {
      t: 'zone';
      z: ZoneType;
      /** 0 = празна зонирана земя, 1..3 = ниво на сградата. */
      lvl: 0 | 1 | 2 | 3;
      /** Заетост 0..1. */
      occ: number;
      /** Оставащи дни строителство (0 = няма строеж). */
      prog: number;
      /** Състояние 0..1 – пада при липса на услуги/рентабилност. */
      hp: number;
      /** Изоставена сграда. */
      ab?: boolean;
    }
  | { t: 'service'; s: ServiceType; cond: number }
  | { t: 'facility'; f: FacilityType; companyId: string; facilityId: string };

export type TileMap = Record<string, TileState>;

/** Има ли пътят тротоари. */
export function hasSidewalk(t: TileState | undefined): boolean {
  if (t?.t !== 'road') return false;
  return t.sw ?? SIDEWALK_BY_DEFAULT.includes(t.c ?? 'street');
}

/** Може ли човек да върви по плочката (тротоар на път или пешеходна алея). */
export function isWalkable(t: TileState | undefined): boolean {
  return t?.t === 'path' || hasSidewalk(t);
}

export interface CityPolicy {
  taxes: { income: number; property: number; corporate: number; sales: number; resource: number; pollution: number };
  /** Бюджет на услугите 0.5..1.5 (1 = 100%). */
  serviceBudget: number;
  /** Субсидии по зона (центове на заета плочка на ден). */
  subsidies: Partial<Record<ZoneType, number>>;
  powerTariff: number;
  waterTariff: number;
  /** Мито при внос на стоки към компании в този град от други градове (дял). */
  importTariff: number;
  /** Санкционирани потребители – търговията с тях е забранена. */
  sanctions: string[];
  /** Енергиен приоритет: първо обществени услуги, после предприятия, после зони. */
  powerPriority: Array<'services' | 'facilities' | 'zones'>;
}

export interface PopulationState {
  /** Жители по образование L0/L1/L2. */
  edu: [number, number, number];
  /** Натрупан прогрес в обучение (жители "в процес"). */
  schoolProgress: number;
  universityProgress: number;
  wages: [number, number, number];
  happiness: number;
}

export interface FacilityLoad {
  id: string;
  type: FacilityType;
  key: string; // "x,y"
  jobs: [number, number, number];
  power: number;
  water: number;
  pollution: number;
  powerOutput: number;
}

export interface CityDerived {
  /** Компактни слоеве за картата – стойности по плочка (ключ "x,y"). */
  landValue: Record<string, number>;
  pollution: Record<string, number>;
  traffic: Record<string, number>;
  powered: Record<string, number>;
  watered: Record<string, number>;
  activity: Record<string, number>;
  /** По сграда: липсващи условия за следващото ниво (next) и за запазване на текущото (keep). */
  levels?: Record<string, { next: UpgradeRequirement[]; keep: UpgradeRequirement[] }>;
  /**
   * По празна или изоставена зона: защо там не започва строеж (празно – условията са изпълнени и строежът
   * ще започне скоро). Само за зони без сграда.
   */
  growth?: Record<string, GrowthBlocker[]>;
}

/** Причина празна (или изоставена) зона да не се застроява. */
export type GrowthBlocker = 'road' | 'power' | 'power_capacity' | 'water' | 'water_capacity' | 'demand';

export interface CityStats {
  tick: number;
  population: number;
  edu: [number, number, number];
  workforce: number;
  jobs: [number, number, number];
  employed: [number, number, number];
  unemployed: number;
  unemploymentRate: number;
  vacancies: number;
  wages: [number, number, number];
  demand: Record<ZoneType, number>;
  power: { supply: number; demand: number; ratio: number; price: number };
  water: { supply: number; demand: number; ratio: number };
  sewage: { capacity: number; load: number };
  waste: { capacity: number; load: number };
  services: { education: number; health: number; safety: number; fire: number; transit: number };
  traffic: { congestion: number; commuteMinutes: number };
  pollutionAvg: number;
  happiness: number;
  attractiveness: number;
  landValueAvg: number;
  buildings: Record<ZoneType, number>;
  abandoned: number;
  /** Колко сгради не могат да се надградят заради всяко липсващо условие. */
  upgradeBlockers?: Partial<Record<UpgradeRequirement, number>>;
  /** Надградени сгради за деня. */
  upgraded?: number;
  gdp: number;
  income: Record<string, number>;
  expenses: Record<string, number>;
  net: number;
  treasury: number;
  /** Посрещнато градско търсене на храни/стоки. */
  retail?: Partial<Record<GoodId, { demand: number; supplied: number }>>;
}

export interface WorldInfo {
  id: number;
  seed: string;
  size: number;
  chunkSize: number;
  parcelSize: number;
  tick: number;
  tickIntervalMs: number;
  lastTickAt: string;
  /** Часовникът на сървъра в момента на отговора – клиентът изчислява часа от денонощието спрямо него. */
  serverTime: string;
  baseRate: number;
  priceIndex: number;
}

export type Side = 'BUY' | 'SELL';
export type HolderType = 'USER' | 'COMPANY' | 'CITY' | 'SYSTEM';

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
}
