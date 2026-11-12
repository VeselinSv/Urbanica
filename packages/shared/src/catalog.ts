import { ECON, POP, PRICE, eur } from './scale';

/**
 * Игрови каталог: стоки, зони, обществени сгради, предприятия (съоръжения) и технологии.
 * Всички стойности са данни – могат да се разширяват, без да се променя кодът на симулацията.
 * Паричните стойности са в цели центове (1 € = 100 евроцента).
 */

export const GOOD_IDS = ['grain', 'wood', 'iron_ore', 'coal', 'steel', 'food', 'goods', 'machinery'] as const;
export type GoodId = (typeof GOOD_IDS)[number];

export interface GoodDef {
  id: GoodId;
  name: string;
  /** Базова референтна цена в центове за единица. */
  basePrice: number;
  /** Суровина (true) или преработена стока. */
  raw: boolean;
  /** Дневно потребление на жител (единици) – създава потребителско търсене. */
  retailPerCapita: number;
  /** Базов дневен обем на световното (NPC) търсене/предлагане. */
  worldVolume: number;
  /** Входни стоки за оценка на себестойността (cost-push) – съвпада с основната рецепта. */
  costInputs?: Partial<Record<GoodId, number>>;
  costOutput?: number;
}

export const GOODS: Record<GoodId, GoodDef> = {
  grain: { id: 'grain', name: 'Зърно', basePrice: 400, raw: true, retailPerCapita: 0, worldVolume: 300 },
  wood: { id: 'wood', name: 'Дървесина', basePrice: 600, raw: true, retailPerCapita: 0, worldVolume: 250 },
  iron_ore: { id: 'iron_ore', name: 'Желязна руда', basePrice: 800, raw: true, retailPerCapita: 0, worldVolume: 300 },
  coal: { id: 'coal', name: 'Въглища', basePrice: 500, raw: true, retailPerCapita: 0, worldVolume: 300 },
  steel: {
    id: 'steel',
    name: 'Стомана',
    basePrice: 3200,
    raw: false,
    retailPerCapita: 0,
    worldVolume: 120,
    costInputs: { iron_ore: 2, coal: 1 },
    costOutput: 1,
  },
  food: {
    id: 'food',
    name: 'Храни',
    basePrice: 1200,
    raw: false,
    retailPerCapita: 0.05,
    worldVolume: 80,
    costInputs: { grain: 3 },
    costOutput: 2,
  },
  goods: {
    id: 'goods',
    name: 'Потребителски стоки',
    basePrice: 3200,
    raw: false,
    retailPerCapita: 0.02,
    worldVolume: 60,
    costInputs: { steel: 1, wood: 2 },
    costOutput: 2,
  },
  machinery: {
    id: 'machinery',
    name: 'Машини',
    basePrice: 17000,
    raw: false,
    retailPerCapita: 0,
    worldVolume: 15,
    costInputs: { steel: 3, goods: 1 },
    costOutput: 1,
  },
};

export const ZONE_TYPES = ['R', 'C', 'I', 'O', 'A', 'L', 'H'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];
export type EduLevel = 0 | 1 | 2;
export type EduMix = [number, number, number];

export interface ZoneDef {
  id: ZoneType;
  name: string;
  /** Жители (R) или работни места (останалите) по ниво 1..3. */
  capacity: [number, number, number];
  eduMix: EduMix;
  power: [number, number, number];
  water: [number, number, number];
  /** Замърсяване, излъчвано от напълно заета сграда по ниво. */
  pollution: [number, number, number];
  /** Дни за строителство на ниво 1. */
  buildDays: number;
  /** Минимална стойност на земята (индекс 0..2) за всяко ниво. */
  landValueReq: [number, number, number];
  /** Цена на зониране (центове на плочка). */
  zoningCost: number;
  /** Дали изисква вода/ток за развитие. */
  needsUtilities: boolean;
  /** Брутна добавена стойност на работно място на ден (центове) – база за корпоративен данък. */
  valueAddedPerJob: number;
  color: number;
}

export const ZONES: Record<ZoneType, ZoneDef> = {
  R: {
    id: 'R',
    name: 'Жилищна',
    capacity: [10, 30, 80],
    eduMix: [0, 0, 0],
    power: [1, 3, 8],
    water: [1, 3, 8],
    pollution: [0, 0, 0],
    buildDays: 3,
    landValueReq: [0, 0.72, 1.1],
    zoningCost: 500,
    needsUtilities: true,
    valueAddedPerJob: 0,
    color: 0x4caf50,
  },
  C: {
    id: 'C',
    name: 'Търговска',
    capacity: [6, 20, 60],
    eduMix: [0.6, 0.35, 0.05],
    power: [2, 6, 15],
    water: [1, 3, 6],
    pollution: [0, 0.5, 1],
    buildDays: 3,
    landValueReq: [0, 0.8, 1.2],
    zoningCost: 500,
    needsUtilities: true,
    valueAddedPerJob: 1800,
    color: 0x2196f3,
  },
  I: {
    id: 'I',
    name: 'Индустриална',
    capacity: [10, 30, 80],
    eduMix: [0.75, 0.2, 0.05],
    power: [4, 12, 30],
    water: [2, 6, 15],
    pollution: [3, 8, 18],
    buildDays: 4,
    landValueReq: [0, 0.5, 0.8],
    zoningCost: 500,
    needsUtilities: true,
    valueAddedPerJob: 1500,
    color: 0xffc107,
  },
  O: {
    id: 'O',
    name: 'Офисна',
    capacity: [10, 40, 120],
    eduMix: [0.1, 0.6, 0.3],
    power: [3, 10, 25],
    water: [1, 4, 10],
    pollution: [0, 0, 0.5],
    buildDays: 4,
    landValueReq: [0.5, 0.85, 1.25],
    zoningCost: 500,
    needsUtilities: true,
    valueAddedPerJob: 2600,
    color: 0x00bcd4,
  },
  A: {
    id: 'A',
    name: 'Земеделска',
    capacity: [4, 8, 12],
    eduMix: [0.9, 0.1, 0],
    power: [0, 1, 2],
    water: [3, 4, 5],
    pollution: [0.5, 1, 1.5],
    buildDays: 2,
    landValueReq: [0, 0, 0.6],
    zoningCost: 200,
    needsUtilities: false,
    valueAddedPerJob: 1100,
    color: 0x8bc34a,
  },
  L: {
    id: 'L',
    name: 'Логистична',
    capacity: [6, 18, 40],
    eduMix: [0.7, 0.3, 0],
    power: [2, 5, 10],
    water: [1, 2, 3],
    pollution: [1, 3, 5],
    buildDays: 3,
    landValueReq: [0, 0.5, 0.8],
    zoningCost: 500,
    needsUtilities: true,
    valueAddedPerJob: 1600,
    color: 0x9c27b0,
  },
  H: {
    id: 'H',
    name: 'Високотехнологична',
    capacity: [8, 30, 90],
    eduMix: [0, 0.3, 0.7],
    power: [4, 12, 30],
    water: [1, 4, 8],
    pollution: [0, 0.5, 1],
    buildDays: 5,
    landValueReq: [0.8, 1.05, 1.35],
    zoningCost: 800,
    needsUtilities: true,
    valueAddedPerJob: 4200,
    color: 0xe91e63,
  },
};

export const SERVICE_TYPES = [
  'power_coal',
  'power_wind',
  'water_pump',
  'sewage_plant',
  'landfill',
  'school',
  'university',
  'clinic',
  'fire_station',
  'police_station',
  'bus_depot',
  'park',
  'parking',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface ServiceDef {
  id: ServiceType;
  name: string;
  cost: number;
  upkeep: number;
  staff: EduMix;
  power: number;
  water: number;
  pollution: number;
  radius: number;
  /** Произвеждана електроенергия (единици/ден). */
  powerSupply?: number;
  /** Дневно потребление на въглища (горивото се купува по пазарна цена). */
  coalUse?: number;
  waterSupply?: number;
  sewageCapacity?: number;
  wasteCapacity?: number;
  /** Капацитет – ученици/студенти/пациенти/пътници. */
  capacity?: number;
  color: number;
}

export const SERVICES: Record<ServiceType, ServiceDef> = {
  power_coal: {
    id: 'power_coal',
    name: 'ТЕЦ на въглища',
    cost: 2_500_000,
    upkeep: 6_000,
    staff: [4, 1, 0],
    power: 0,
    water: 4,
    pollution: 12,
    radius: 0,
    powerSupply: 300,
    coalUse: 16,
    color: 0x5d4037,
  },
  power_wind: {
    id: 'power_wind',
    name: 'Вятърен парк',
    cost: 3_500_000,
    upkeep: 4_000,
    staff: [1, 1, 0],
    power: 0,
    water: 0,
    pollution: 0,
    radius: 0,
    powerSupply: 110,
    color: 0xeceff1,
  },
  water_pump: {
    id: 'water_pump',
    name: 'Помпена станция',
    cost: 600_000,
    upkeep: 2_000,
    staff: [2, 0, 0],
    power: 5,
    water: 0,
    pollution: 0,
    radius: 0,
    waterSupply: 400,
    color: 0x0288d1,
  },
  sewage_plant: {
    id: 'sewage_plant',
    name: 'Пречиствателна станция',
    cost: 1_000_000,
    upkeep: 3_000,
    staff: [2, 1, 0],
    power: 6,
    water: 0,
    pollution: 2,
    radius: 0,
    sewageCapacity: 600,
    color: 0x6d4c41,
  },
  landfill: {
    id: 'landfill',
    name: 'Депо за отпадъци',
    cost: 600_000,
    upkeep: 2_000,
    staff: [3, 0, 0],
    power: 1,
    water: 0,
    pollution: 4,
    radius: 0,
    wasteCapacity: 500,
    color: 0x795548,
  },
  school: {
    id: 'school',
    name: 'Училище',
    cost: 800_000,
    upkeep: 4_000,
    staff: [1, 4, 0],
    power: 3,
    water: 2,
    pollution: 0,
    radius: 12,
    capacity: 300,
    color: 0xff7043,
  },
  university: {
    id: 'university',
    name: 'Университет',
    cost: 6_000_000,
    upkeep: 15_000,
    staff: [2, 6, 8],
    power: 10,
    water: 6,
    pollution: 0,
    radius: 40,
    capacity: 400,
    color: 0xab47bc,
  },
  clinic: {
    id: 'clinic',
    name: 'Поликлиника',
    cost: 1_000_000,
    upkeep: 5_000,
    staff: [1, 3, 1],
    power: 4,
    water: 3,
    pollution: 0,
    radius: 12,
    capacity: 1500,
    color: 0xef5350,
  },
  fire_station: {
    id: 'fire_station',
    name: 'Пожарна',
    cost: 700_000,
    upkeep: 3_000,
    staff: [5, 1, 0],
    power: 2,
    water: 3,
    pollution: 0,
    radius: 12,
    color: 0xd32f2f,
  },
  police_station: {
    id: 'police_station',
    name: 'Полиция',
    cost: 700_000,
    upkeep: 3_000,
    staff: [4, 2, 0],
    power: 2,
    water: 1,
    pollution: 0,
    radius: 12,
    color: 0x1565c0,
  },
  bus_depot: {
    id: 'bus_depot',
    name: 'Автобусно депо',
    cost: 900_000,
    upkeep: 3_500,
    staff: [6, 1, 0],
    power: 3,
    water: 1,
    pollution: 1,
    radius: 14,
    capacity: 1200,
    color: 0xfdd835,
  },
  park: { id: 'park', name: 'Парк', cost: 150_000, upkeep: 500, staff: [1, 0, 0], power: 0, water: 1, pollution: -2, radius: 5, color: 0x66bb6a },
  /** Паркинг: магазините и офисите от ниво 3 искат паркинг наблизо; без него колите обикалят. */
  parking: { id: 'parking', name: 'Паркинг', cost: 60_000, upkeep: 200, staff: [0, 0, 0], power: 0, water: 0, pollution: 0, radius: 4, color: 0x78909c },
};

export const FACILITY_TYPES = [
  'farm',
  'lumber_camp',
  'iron_mine',
  'coal_mine',
  'steel_mill',
  'food_plant',
  'factory',
  'machinery_plant',
  'warehouse',
  'coal_power',
  'solar_farm',
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

export type PlacementRule = 'fertile' | 'forest' | 'iron' | 'coal' | 'any';

export interface Recipe {
  inputs: Partial<Record<GoodId, number>>;
  outputs: Partial<Record<GoodId, number>>;
  /** Максимален брой цикли на ден при пълен персонал и ток. */
  runsPerDay: number;
}

export interface FacilityDef {
  id: FacilityType;
  name: string;
  cost: number;
  upkeep: number;
  jobs: EduMix;
  power: number;
  water: number;
  pollution: number;
  placement: PlacementRule;
  recipe?: Recipe;
  /** Произвеждана енергия за продажба към градската мрежа (единици/ден). */
  powerOutput?: number;
  /** Входно гориво за енергийните мощности (въглища/ден). */
  coalUse?: number;
  storageBonus?: number;
  /** Сектор за технологични ефекти. */
  sector: 'agriculture' | 'extraction' | 'processing' | 'manufacturing' | 'logistics' | 'energy';
  color: number;
}

export const FACILITIES: Record<FacilityType, FacilityDef> = {
  farm: {
    id: 'farm',
    name: 'Ферма',
    cost: 800_000,
    upkeep: 1_000,
    jobs: [6, 0, 0],
    power: 1,
    water: 3,
    pollution: 0.5,
    placement: 'fertile',
    recipe: { inputs: {}, outputs: { grain: 1 }, runsPerDay: 80 },
    sector: 'agriculture',
    color: 0xcddc39,
  },
  lumber_camp: {
    id: 'lumber_camp',
    name: 'Дърводобив',
    cost: 1_000_000,
    upkeep: 1_500,
    jobs: [10, 0, 0],
    power: 1,
    water: 0,
    pollution: 1,
    placement: 'forest',
    recipe: { inputs: {}, outputs: { wood: 1 }, runsPerDay: 50 },
    sector: 'extraction',
    color: 0x6d4c41,
  },
  iron_mine: {
    id: 'iron_mine',
    name: 'Рудник за желязо',
    cost: 1_800_000,
    upkeep: 3_000,
    jobs: [12, 2, 0],
    power: 4,
    water: 1,
    pollution: 3,
    placement: 'iron',
    recipe: { inputs: {}, outputs: { iron_ore: 1 }, runsPerDay: 60 },
    sector: 'extraction',
    color: 0x8d6e63,
  },
  coal_mine: {
    id: 'coal_mine',
    name: 'Въглищна мина',
    cost: 1_400_000,
    upkeep: 2_500,
    jobs: [12, 1, 0],
    power: 3,
    water: 1,
    pollution: 4,
    placement: 'coal',
    recipe: { inputs: {}, outputs: { coal: 1 }, runsPerDay: 70 },
    sector: 'extraction',
    color: 0x424242,
  },
  steel_mill: {
    id: 'steel_mill',
    name: 'Стоманолеярна',
    cost: 2_200_000,
    upkeep: 3_000,
    jobs: [16, 6, 0],
    power: 10,
    water: 6,
    pollution: 8,
    placement: 'any',
    recipe: { inputs: { iron_ore: 2, coal: 1 }, outputs: { steel: 1 }, runsPerDay: 40 },
    sector: 'processing',
    color: 0x78909c,
  },
  food_plant: {
    id: 'food_plant',
    name: 'Хранителен завод',
    cost: 1_500_000,
    upkeep: 2_000,
    jobs: [10, 3, 0],
    power: 4,
    water: 4,
    pollution: 1,
    placement: 'any',
    recipe: { inputs: { grain: 3 }, outputs: { food: 2 }, runsPerDay: 30 },
    sector: 'processing',
    color: 0xffb74d,
  },
  factory: {
    id: 'factory',
    name: 'Фабрика за стоки',
    cost: 2_200_000,
    upkeep: 2_500,
    jobs: [14, 6, 0],
    power: 8,
    water: 3,
    pollution: 4,
    placement: 'any',
    recipe: { inputs: { steel: 1, wood: 2 }, outputs: { goods: 2 }, runsPerDay: 25 },
    sector: 'manufacturing',
    color: 0x90a4ae,
  },
  machinery_plant: {
    id: 'machinery_plant',
    name: 'Машиностроителен завод',
    cost: 3_000_000,
    upkeep: 3_000,
    jobs: [0, 8, 4],
    power: 10,
    water: 3,
    pollution: 3,
    placement: 'any',
    recipe: { inputs: { steel: 3, goods: 1 }, outputs: { machinery: 1 }, runsPerDay: 10 },
    sector: 'manufacturing',
    color: 0x607d8b,
  },
  warehouse: {
    id: 'warehouse',
    name: 'Склад',
    cost: 600_000,
    upkeep: 800,
    jobs: [4, 0, 0],
    power: 1,
    water: 0,
    pollution: 0,
    placement: 'any',
    storageBonus: 3000,
    sector: 'logistics',
    color: 0xa1887f,
  },
  coal_power: {
    id: 'coal_power',
    name: 'Частна ТЕЦ',
    cost: 1_800_000,
    upkeep: 2_000,
    jobs: [6, 2, 0],
    power: 0,
    water: 4,
    pollution: 10,
    placement: 'any',
    powerOutput: 160,
    coalUse: 8,
    sector: 'energy',
    color: 0x4e342e,
  },
  solar_farm: {
    id: 'solar_farm',
    name: 'Соларен парк',
    cost: 2_500_000,
    upkeep: 1_000,
    jobs: [2, 1, 0],
    power: 0,
    water: 0,
    pollution: 0,
    placement: 'any',
    powerOutput: 70,
    sector: 'energy',
    color: 0x283593,
  },
};

export const TECH_IDS = [
  'precision_farming',
  'mining_automation',
  'efficient_smelting',
  'lean_manufacturing',
  'industrial_robotics',
  'advanced_pv',
  'logistics_software',
  'clean_combustion',
] as const;
export type TechId = (typeof TECH_IDS)[number];

export interface TechDef {
  id: TechId;
  name: string;
  description: string;
  /** Изследователски дни при един изследователски екип. */
  days: number;
  /** Дневен разход за изследване (центове). */
  dailyCost: number;
  /** Ефекти: множител на производството по сектор, намаление на персонала, на входовете, на транспорта, на замърсяването. */
  effect: {
    sector?: FacilityDef['sector'];
    outputMult?: number;
    staffMult?: number;
    inputMult?: number;
    shippingMult?: number;
    pollutionMult?: number;
  };
  /** Технологии с подобен ефект (алтернативи – ограничават монопола). */
  alternatives: TechId[];
}

export const TECHS: Record<TechId, TechDef> = {
  precision_farming: {
    id: 'precision_farming',
    name: 'Прецизно земеделие',
    description: '+25% добив във фермите',
    days: 30,
    dailyCost: 20_000,
    effect: { sector: 'agriculture', outputMult: 1.25 },
    alternatives: [],
  },
  mining_automation: {
    id: 'mining_automation',
    name: 'Автоматизация на добива',
    description: '+20% добив и -20% персонал в добива',
    days: 40,
    dailyCost: 30_000,
    effect: { sector: 'extraction', outputMult: 1.2, staffMult: 0.8 },
    alternatives: [],
  },
  efficient_smelting: {
    id: 'efficient_smelting',
    name: 'Ефективно топене',
    description: '-15% суровини в преработката',
    days: 45,
    dailyCost: 35_000,
    effect: { sector: 'processing', inputMult: 0.85 },
    alternatives: [],
  },
  lean_manufacturing: {
    id: 'lean_manufacturing',
    name: 'Лийн производство',
    description: '+15% капацитет в производството',
    days: 40,
    dailyCost: 30_000,
    effect: { sector: 'manufacturing', outputMult: 1.15 },
    alternatives: ['industrial_robotics'],
  },
  industrial_robotics: {
    id: 'industrial_robotics',
    name: 'Индустриална роботика',
    description: '-35% персонал в производството',
    days: 55,
    dailyCost: 40_000,
    effect: { sector: 'manufacturing', staffMult: 0.65 },
    alternatives: ['lean_manufacturing'],
  },
  advanced_pv: {
    id: 'advanced_pv',
    name: 'Високоефективни фотоволтаици',
    description: '+50% производство на енергия',
    days: 50,
    dailyCost: 35_000,
    effect: { sector: 'energy', outputMult: 1.5 },
    alternatives: [],
  },
  logistics_software: {
    id: 'logistics_software',
    name: 'Логистичен софтуер',
    description: '-30% транспортни разходи',
    days: 30,
    dailyCost: 25_000,
    effect: { shippingMult: 0.7 },
    alternatives: [],
  },
  clean_combustion: {
    id: 'clean_combustion',
    name: 'Чисто горене',
    description: '-40% замърсяване от всички съоръжения',
    days: 45,
    dailyCost: 30_000,
    effect: { pollutionMult: 0.6 },
    alternatives: [],
  },
};

// ---------------------------------------------------------------- условия за надграждане на сгради
/**
 * Изисквания за надграждане (и за запазване на нивото). Сградата се надгражда сама, когато всички
 * условия за следващото ниво са изпълнени; ако изискванията на текущото ниво отпаднат (напр. затворена
 * болница), сградата постепенно губи състояние и слиза ниво.
 *  - road/power/water – достъп до път, захранване и водоснабдяване на плочката;
 *  - sidewalk – до сградата има тротоар или пешеходна алея (хората могат да стигнат пеша);
 *  - обществена сграда (school, clinic, …) – плочката е в обхвата на работеща сграда от този тип;
 *  - sewage/waste – градът има достатъчно капацитет за отпадни води и отпадъци;
 *  - clean_air – ниско замърсяване на плочката;
 *  - land_value – стойност на земята над прага за нивото;
 *  - occupancy – сградата е почти пълна (≥80%); demand – има търсене за зоната.
 */
export const UPGRADE_REQUIREMENT_IDS = [
  'road',
  'power',
  'water',
  'sidewalk',
  'school',
  'clinic',
  'police_station',
  'fire_station',
  'park',
  'parking',
  'bus_depot',
  'university',
  'sewage',
  'waste',
  'clean_air',
  'land_value',
  'occupancy',
  'demand',
  'no_issues',
] as const;
export type UpgradeRequirement = (typeof UPGRADE_REQUIREMENT_IDS)[number];

export const UPGRADE_REQUIREMENT_LABELS: Record<UpgradeRequirement, string> = {
  road: 'Път до сградата',
  power: 'Ток',
  water: 'Вода',
  sidewalk: 'Тротоар или алея до сградата',
  school: 'Училище в обхват',
  clinic: 'Болница в обхват',
  police_station: 'Полиция в обхват',
  fire_station: 'Пожарна в обхват',
  park: 'Парк в обхват',
  parking: 'Паркинг в обхват',
  bus_depot: 'Обществен транспорт в обхват',
  university: 'Университет в обхват',
  sewage: 'Пречиствателна станция (капацитет)',
  waste: 'Сметище (капацитет)',
  clean_air: 'Чист въздух (ниско замърсяване)',
  land_value: 'Достатъчна стойност на земята',
  occupancy: 'Сградата е почти пълна (≥70%)',
  demand: 'Търсене за зоната',
  no_issues: 'Без нерешени сигнали наблизо',
};

const BASE_UTIL: UpgradeRequirement[] = ['road', 'power', 'water'];
/** Изисквания за ниво 2 и ниво 3 по зона (без общите: заетост, търсене, стойност на земята). */
export const UPGRADE_REQUIREMENTS: Record<ZoneType, [UpgradeRequirement[], UpgradeRequirement[]]> = {
  R: [
    [...BASE_UTIL, 'sidewalk', 'school'],
    [...BASE_UTIL, 'sidewalk', 'school', 'clinic', 'police_station', 'fire_station', 'park', 'sewage', 'waste'],
  ],
  C: [
    [...BASE_UTIL, 'sidewalk', 'police_station'],
    [...BASE_UTIL, 'sidewalk', 'police_station', 'fire_station', 'park', 'parking', 'sewage', 'waste'],
  ],
  O: [
    [...BASE_UTIL, 'police_station'],
    [...BASE_UTIL, 'sidewalk', 'police_station', 'fire_station', 'bus_depot', 'park', 'parking', 'sewage', 'waste'],
  ],
  I: [[...BASE_UTIL], [...BASE_UTIL, 'fire_station', 'police_station', 'sewage', 'waste']],
  L: [[...BASE_UTIL], [...BASE_UTIL, 'fire_station', 'police_station', 'sewage', 'waste']],
  H: [
    [...BASE_UTIL, 'university', 'police_station'],
    [...BASE_UTIL, 'sidewalk', 'university', 'police_station', 'fire_station', 'park', 'clinic', 'bus_depot', 'sewage', 'waste', 'clean_air'],
  ],
  A: [
    ['road', 'water'],
    ['road', 'water', 'power', 'fire_station'],
  ],
};

// ---------------------------------------------------------------- сигнали от гражданите
/** Къде може да се появи проблемът. */
export type IssueSite = 'road' | 'building' | 'residential';

export interface IssueDef {
  id: string;
  name: string;
  icon: string;
  site: IssueSite;
  /** Базов дневен шанс на подходяща плочка (умножава се по фактори от града). */
  rate: number;
  /** Цена на ремонта за степен 1 (центове); умножава се по степента. */
  fixCost: number;
  /** Дни за ремонт след изпращане на екипа. */
  fixDays: number;
  /** След колко дни без ремонт проблемът се влошава (степен +1). 0 – не се влошава. */
  escalateDays: number;
  /** Отшумява сам след толкова дни (0 – никога). */
  autoResolveDays: number;
  /** Ефекти, докато е отворен (по степен): удовлетвореност (дял), стойност на земята наоколо, блокиран път, загуба на вода/ток, замърсяване. */
  effects: { happiness: number; landValue?: number; blocksRoad?: boolean; waterLoss?: number; powerLoss?: number; pollution?: number };
  /** Какво намалява вероятността (обществена сграда в обхват). */
  reducedBy?: string;
  messages: string[];
}

export const ISSUE_TYPES: Record<string, IssueDef> = {
  pothole: {
    id: 'pothole',
    name: 'Дупка на пътя',
    icon: '🕳️',
    site: 'road',
    rate: 0.0016,
    fixCost: 30_000,
    fixDays: 1,
    escalateDays: 8,
    autoResolveDays: 0,
    effects: { happiness: 0.006, landValue: 0.05, blocksRoad: false },
    messages: [
      'Има огромна дупка на пътя до нас – вече две коли спукаха гуми!',
      'Дупката на улицата расте всеки ден. Кога ще я запълните?',
      'Велосипедистите заобикалят дупка насред платното – опасно е!',
    ],
  },
  water_leak: {
    id: 'water_leak',
    name: 'Спукана водопроводна тръба',
    icon: '💦',
    site: 'road',
    rate: 0.0007,
    fixCost: 90_000,
    fixDays: 2,
    escalateDays: 5,
    autoResolveDays: 0,
    effects: { happiness: 0.008, waterLoss: 0.04, blocksRoad: true },
    messages: [
      'Водата блика от асфалта! Улицата се превърна в река.',
      'Нямаме вода от сутринта, а на кръстовището тече фонтан.',
      'Спукана тръба наводнява мазетата в квартала.',
    ],
  },
  power_outage: {
    id: 'power_outage',
    name: 'Авария в електрозахранването',
    icon: '⚡',
    site: 'building',
    rate: 0.0005,
    fixCost: 120_000,
    fixDays: 2,
    escalateDays: 6,
    autoResolveDays: 0,
    effects: { happiness: 0.01, powerLoss: 0.05 },
    messages: [
      'Токът спря в целия блок – хладилниците се размразяват!',
      'Трансформаторът пред нас пуши и бръмчи. Нямаме ток.',
      'Магазинът ни не работи – пак няма ток.',
    ],
  },
  garbage: {
    id: 'garbage',
    name: 'Неприбран боклук',
    icon: '🗑️',
    site: 'residential',
    rate: 0.0012,
    fixCost: 20_000,
    fixDays: 1,
    escalateDays: 4,
    autoResolveDays: 0,
    effects: { happiness: 0.007, landValue: 0.08, pollution: 2 },
    reducedBy: 'landfill',
    messages: [
      'Контейнерите преливат от седмица, мирише ужасно.',
      'Чували с боклук на тротоара – котките вече се настаниха.',
      'Някой изхвърли стари мебели до контейнера. Моля, приберете ги.',
    ],
  },
  graffiti: {
    id: 'graffiti',
    name: 'Вандализъм и графити',
    icon: '🎨',
    site: 'building',
    rate: 0.0006,
    fixCost: 15_000,
    fixDays: 1,
    escalateDays: 0,
    autoResolveDays: 0,
    effects: { happiness: 0.004, landValue: 0.06 },
    reducedBy: 'police_station',
    messages: ['Нощес изрисуваха цялата фасада на блока.', 'Счупени пейки и надраскани стени в квартала.', 'Вандали изпотрошиха спирката.'],
  },
  streetlight: {
    id: 'streetlight',
    name: 'Изгоряло улично осветление',
    icon: '💡',
    site: 'road',
    rate: 0.0009,
    fixCost: 10_000,
    fixDays: 1,
    escalateDays: 0,
    autoResolveDays: 0,
    effects: { happiness: 0.004 },
    messages: ['Улицата е тъмна от три нощи – страх ме е да се прибирам.', 'Лампата на ъгъла мига и угасва.', 'Цялата улица е без осветление.'],
  },
  accident: {
    id: 'accident',
    name: 'Пътна катастрофа',
    icon: '🚗',
    site: 'road',
    rate: 0.0004,
    fixCost: 25_000,
    fixDays: 1,
    escalateDays: 0,
    autoResolveDays: 3,
    effects: { happiness: 0.005, blocksRoad: true },
    reducedBy: 'police_station',
    messages: [
      'Две коли се удариха на кръстовището, движението е блокирано.',
      'Катастрофа! Пътят е затворен, има задръстване.',
      'Камион се обърна и разпиля товара си на пътя.',
    ],
  },
  fallen_tree: {
    id: 'fallen_tree',
    name: 'Паднало дърво',
    icon: '🌳',
    site: 'road',
    rate: 0.0003,
    fixCost: 20_000,
    fixDays: 1,
    escalateDays: 0,
    autoResolveDays: 0,
    effects: { happiness: 0.004, blocksRoad: true },
    messages: ['Буря събори голямо дърво през пътя.', 'Дърво падна върху паркирани коли.', 'Клоните на падналото дърво препречват улицата.'],
  },
  sewage: {
    id: 'sewage',
    name: 'Преливаща канализация',
    icon: '🦨',
    site: 'residential',
    rate: 0.0004,
    fixCost: 70_000,
    fixDays: 2,
    escalateDays: 5,
    autoResolveDays: 0,
    effects: { happiness: 0.01, landValue: 0.1, pollution: 3 },
    reducedBy: 'sewage_plant',
    messages: ['От шахтата излиза вода и вони на целия квартал.', 'Канализацията прелива в двора на детската градина!', 'Мазето ни е пълно с отпадни води.'],
  },
};
export const ISSUE_KINDS = Object.keys(ISSUE_TYPES);

/** Имена на гражданите, които подават сигнали. */
export const CITIZEN_FIRST = [
  'Иван',
  'Мария',
  'Георги',
  'Елена',
  'Петър',
  'Десислава',
  'Николай',
  'Радост',
  'Стоян',
  'Виктория',
  'Калин',
  'Яна',
  'Тодор',
  'Милена',
  'Борис',
  'Цвета',
  'Димитър',
  'Невена',
  'Асен',
  'Лора',
];
export const CITIZEN_LAST = ['Петров', 'Иванов', 'Георгиев', 'Димитров', 'Николов', 'Стоянов', 'Тодоров', 'Колев', 'Маринов', 'Христов', 'Илиев', 'Ангелов'];

// ---------------------------------------------------------------- мащаб: реални цени и население
// Таблиците по-горе са в „базови“ единици. Тук се прилага мащабът от scale.ts: хората, работните места,
// потреблението и производството ×POP; цените на стоките и добавената стойност ×PRICE; паричните потоци
// на компаниите ×ECON. Градската инфраструктура получава изрично реални цени в евро (с поддръжка на ден).

/** Реални цени на обществените сгради: [строителство, поддръжка на ден] (персоналът се плаща отделно). */
const REAL_SERVICE_PRICES: Record<ServiceType, [number, number]> = {
  power_coal: [eur(18_000_000), eur(5_000)],
  power_wind: [eur(2_000_000), eur(200)],
  water_pump: [eur(900_000), eur(150)],
  sewage_plant: [eur(4_000_000), eur(700)],
  landfill: [eur(1_500_000), eur(300)],
  school: [eur(2_500_000), eur(250)],
  university: [eur(20_000_000), eur(1_500)],
  clinic: [eur(4_000_000), eur(500)],
  fire_station: [eur(1_500_000), eur(150)],
  police_station: [eur(1_200_000), eur(120)],
  bus_depot: [eur(3_000_000), eur(400)],
  park: [eur(300_000), eur(40)],
  parking: [eur(200_000), eur(20)],
};
/** Зониране (план, разрешителни, техническа инфраструктура) за плочка. */
const REAL_ZONING: Record<ZoneType, number> = { R: eur(3_000), C: eur(3_000), I: eur(3_000), O: eur(3_000), A: eur(1_000), L: eur(3_000), H: eur(5_000) };

const times = <T extends number[]>(a: T, k: number) => a.map((v) => Math.round(v * k)) as T;
for (const g of Object.values(GOODS)) {
  g.basePrice = Math.round(g.basePrice * PRICE);
  g.worldVolume *= POP;
}
for (const z of Object.values(ZONES)) {
  z.capacity = times(z.capacity, POP);
  z.power = times(z.power, POP);
  z.water = times(z.water, POP);
  z.valueAddedPerJob = Math.round(z.valueAddedPerJob * PRICE);
  z.zoningCost = REAL_ZONING[z.id];
}
for (const s of Object.values(SERVICES)) {
  [s.cost, s.upkeep] = REAL_SERVICE_PRICES[s.id];
  s.staff = times(s.staff, POP);
  s.power *= POP;
  s.water *= POP;
  if (s.powerSupply) s.powerSupply *= POP;
  if (s.coalUse) s.coalUse *= POP;
  if (s.waterSupply) s.waterSupply *= POP;
  if (s.sewageCapacity) s.sewageCapacity *= POP;
  if (s.wasteCapacity) s.wasteCapacity *= POP;
  if (s.capacity) s.capacity *= POP;
}
for (const f of Object.values(FACILITIES)) {
  f.cost = Math.round(f.cost * ECON);
  f.upkeep = Math.round(f.upkeep * ECON);
  f.jobs = times(f.jobs, POP);
  f.power *= POP;
  f.water *= POP;
  if (f.recipe) f.recipe.runsPerDay *= POP;
  if (f.powerOutput) f.powerOutput *= POP;
  if (f.coalUse) f.coalUse *= POP;
  if (f.storageBonus) f.storageBonus *= POP;
}
for (const t of Object.values(TECHS)) t.dailyCost = Math.round(t.dailyCost * ECON);
// ремонтите по сигналите – реални цени на екип с техника; сигналите са по-редки (по-лесна игра)
for (const i of Object.values(ISSUE_TYPES)) {
  i.fixCost *= 20;
  i.rate *= 0.6;
}
