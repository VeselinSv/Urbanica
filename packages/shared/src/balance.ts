/**
 * Балансови параметри на икономиката. Всички важни константи са тук, а не разпръснати в кода.
 * Паричните стойности са в центове. "Ден" = един игрови тик.
 */
export const BALANCE = {
  world: {
    size: 512, // плочки по всяка ос
    chunkSize: 32,
    parcelSize: 8, // парцел = 8x8 плочки – неделима единица собственост
    startParcels: 3, // начална територия 3x3 парцела
    maxCityParcels: 64,
  },
  start: {
    cityTreasury: 20_000_000, // 200 000 €
    wallet: 5_000_000, // 50 000 €
    additionalCityCost: 10_000_000, // основаване на втори град (плаща се от портфейла)
    minDistanceBetweenCities: 24, // плочки
  },
  land: {
    parcelBasePrice: 500_000,
    /** Множител на цената за всеки парцел, който градът вече притежава (растяща цена на експанзията). */
    parcelGrowthFactor: 0.04,
    resourcePremium: 0.5,
  },
  construction: {
    roadCost: 2_000,
    bulldozeCost: 200,
    terrainCostMult: { plains: 1, forest: 1.3, hills: 1.6, mountains: 3, beach: 1.2, water: Infinity, deep_water: Infinity } as Record<string, number>,
    roadUpkeep: 20,
    /** Тротоари към съществуващ път (за плочка) и пешеходна алея (за плочка). */
    sidewalkCost: 800,
    /** Автобусна спирка (навес и табела) и обхватът ѝ при наличие на автобусно депо. */
    busStopCost: 3_000,
    busStopRadius: 4,
    pathCost: 1_000,
    /** Категории пътища: множител на цената, капацитет (спрямо улица) и поддръжка. */
    roadClasses: {
      street: { cost: 1, capacity: 1, upkeep: 1 },
      avenue: { cost: 3, capacity: 2.4, upkeep: 2.5 },
      highway: { cost: 6, capacity: 4, upkeep: 4 },
      rural: { cost: 0.5, capacity: 0.6, upkeep: 0.5 },
      industrial: { cost: 1.6, capacity: 1.5, upkeep: 1.4 },
    } as Record<string, { cost: number; capacity: number; upkeep: number }>,
    /** Управление на кръстовища: еднократна цена и допълнителен капацитет (пътувания). */
    junctions: {
      roundabout: { cost: 40_000, capacity: 260, upkeep: 30 },
      signals: { cost: 15_000, capacity: 150, upkeep: 15 },
    } as Record<string, { cost: number; capacity: number; upkeep: number }>,
  },
  population: {
    workforceShare: 0.6,
    maxDailyGrowthShare: 0.06, // максимум 6% от свободния жилищен капацитет на ден
    minDailyMigrants: 4,
    emigrationShare: 0.03,
    initialEduMix: [0.7, 0.25, 0.05] as [number, number, number],
    schoolDays: 60, // нужни учебни дни за L0 -> L1
    universityDays: 120, // L1 -> L2
    /** Дял от безработните, който напуска града на ден, ако привлекателността е ниска. */
    unemployedExodus: 0.02,
  },
  wages: {
    base: [1_000, 1_600, 2_800] as [number, number, number], // центове/ден за L0, L1, L2
    min: [600, 900, 1_500] as [number, number, number],
    max: [3_000, 5_000, 9_000] as [number, number, number],
    adjustSpeed: 0.03,
  },
  consumption: {
    /** Дял от дохода на домакинствата, похарчен в местната търговия. */
    retailSpendShare: 0.35,
    /** Наем като дял от стойността на земята / 365. */
    rentYield: 0.06,
  },
  taxes: {
    defaults: { income: 0.12, property: 0.02, corporate: 0.15, sales: 0.02, resource: 0.05, pollution: 50 },
    limits: { income: [0, 0.4], property: [0, 0.1], corporate: [0, 0.5], sales: [0, 0.2], resource: [0, 0.3], pollution: [0, 1000] },
    /** Еластичност на търсенето спрямо данъка (отклонение от стойността по подразбиране). */
    demandElasticity: { income: 2.5, property: 4, corporate: 1.6 },
  },
  utilities: {
    defaultPowerTariff: 200, // центове за единица енергия
    defaultWaterTariff: 50,
    tariffLimits: { power: [0, 2_000], water: [0, 500] },
    /** Изкупна цена на енергия от частни централи: базова, коригирана от недостига. */
    energyBuyBase: 160,
    energyScarcityElasticity: 1.2,
    sewagePerResident: 0.1,
    sewagePerJob: 0.05,
    wastePerResident: 0.08,
    wastePerJob: 0.06,
  },
  landValue: {
    base: 1_000_000, // базова стойност на плочка (центове) = 10 000 €
  },
  /** Самостоятелно надграждане на сградите (условията по зони са в UPGRADE_REQUIREMENTS). */
  upgrade: {
    coverageMin: 0.25, // минимално покритие от обществена сграда, за да се счита „в обхват“
    maxPollution: 4, // „чист въздух“
    minOccupancy: 0.8,
    waterRatioMin: 0.9, // водата се счита за осигурена при ≥90% покрито търсене
    chanceBase: 0.05, // дневен шанс за надграждане при изпълнени условия
    chancePerDemand: 0.12,
    declinePerDay: 0.02, // загуба на състояние, ако изискванията на текущото ниво не са изпълнени
    downgradeBelowHp: 0.4, // под това състояние сградата слиза едно ниво (вместо да се изостави)
  },
  /** Магистрали между градовете. */
  links: {
    costPerTile: 15_000, // 150 € за плочка разстояние
    maxLength: 160,
    /** Множител на цената и времето за превоз между свързани градове. */
    shippingMult: 0.5,
  },
  traffic: {
    roadCapacity: 120, // пътувания на пътна плочка
    busShare: 0.35, // дял пътувания, поети от автобуси в обхват
  },
  pollution: {
    radius: 4,
    decayPerTile: 0.35,
    healthImpact: 0.004,
  },
  company: {
    baseStorage: 1_000,
    minFoundingCapital: 1_000_000,
    defaultShares: 10_000,
    shippingCostPerUnitPerTile: 1, // центове за единица стока на плочка разстояние
    shippingBaseDays: 1,
    tilesPerShippingDay: 60,
    machineryUpgradeUnits: 5,
    machineryUpgradeBonus: 0.25,
    maxUpgrades: 2,
    facilityResaleShare: 0.3,
  },
  market: {
    tradeFee: 0.01, // такса към системата за всяка сделка
    retailMaxPremium: 1.3, // градското потребление купува до 130% от референтната цена
    exportFloor: 0.8, // световният пазар изкупува до 80% от реф. цена
    importPremium: 1.25, // световният пазар продава от 125% от реф. цена
    priceAdjust: 0.04,
    costPushWeight: 0.05,
    meanReversion: 0.01,
    minPriceShare: 0.2,
    maxPriceShare: 6,
    orderMaxQty: 1_000_000,
  },
  banking: {
    neutralRate: 0.05, // годишна
    inflationTarget: 0.02,
    rateInflationWeight: 1.5,
    rateCreditWeight: 0.5,
    minRate: 0.005,
    maxRate: 0.25,
    paymentIntervalDays: 30,
    maxMissedBeforeDefault: 3,
    latePenaltyShare: 0.05,
    bankInitialCapital: 50_000_000_000,
    /** Спред по кредитен рейтинг (годишен). */
    spreads: { AAA: 0.005, AA: 0.01, A: 0.02, BBB: 0.035, BB: 0.06, B: 0.09, CCC: 0.14, D: 1 } as Record<string, number>,
    /** Максимален дълг като дял от активите по рейтинг. */
    maxLeverage: { AAA: 0.8, AA: 0.7, A: 0.6, BBB: 0.5, BB: 0.35, B: 0.2, CCC: 0.05, D: 0 } as Record<string, number>,
    cityBorrowingAssetsPerResident: 30_000,
    recoveryShare: 0.6,
  },
  research: {
    patentDays: 365,
    universitySpeedup: 0.5,
    publicResearchCostMult: 1.5,
  },
  events: {
    floodBaseChance: 0.002,
    fireBaseChance: 0.0008,
  },
  chat: {
    maxLength: 500,
    rateWindowMs: 10_000,
    rateMax: 6,
    retentionDays: 30,
  },
  sim: {
    /** Брой тикове, обработвани наведнъж за неактивен град (обобщена симулация). */
    inactiveBatch: 5,
    /** Играч се счита за активен N реални минути след последна заявка. */
    activeWindowMinutes: 15,
    statsEvery: 1,
    maxCatchUpTicks: 50,
  },
} as const;

export const DAYS_PER_YEAR = 360;
export const DAYS_PER_MONTH = 30;
