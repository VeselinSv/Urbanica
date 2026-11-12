// Проверка на баланса: типичен стартов град (пътища, зони, ток, вода, услуги) за N игрови дни.
// Показва цената на построяването спрямо стартовия бюджет и дневните приходи/разходи по време.
// Използване: node scripts/balance-sim.mjs [дни]   (нужен е билд: npx tsc -b packages/game-simulation)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BALANCE, SERVICES, ZONES, tileKey } = require('@gce/shared');
const { WorldGenerator } = require('@gce/world-generation');
const { stepCity } = require('@gce/game-simulation');

const DAYS = Number(process.argv[2] ?? 360);
const world = new WorldGenerator('balance-sim');
const eur = (c) => `${Math.round(c / 100).toLocaleString('bg-BG')} €`;

function findLand() {
  for (let y = 120; y < 420; y += 8)
    for (let x = 120; x < 420; x += 8) {
      let ok = true;
      for (let j = 0; j < 24 && ok; j++) for (let i = 0; i < 24 && ok; i++) if (!world.buildable(x + i, y + j)) ok = false;
      if (ok) return { ox: x, oy: y };
    }
  throw new Error('no land');
}

const { ox, oy } = findLand();
const tiles = {};
const territory = [];
for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) territory.push(tileKey(ox + i, oy + j));
let cost = 0;
const RC = BALANCE.construction.roadClasses;
const road = (x, y, c = 'street') => {
  tiles[tileKey(x, y)] = c === 'street' ? { t: 'road' } : { t: 'road', c };
  cost += BALANCE.construction.roadCost * RC[c].cost;
};
const zone = (x, y, z) => {
  if (tiles[tileKey(x, y)]) return;
  tiles[tileKey(x, y)] = { t: 'zone', z, lvl: 0, occ: 0, prog: 0, hp: 1 };
  cost += ZONES[z].zoningCost;
};
const svc = (x, y, s) => {
  tiles[tileKey(x, y)] = { t: 'service', s, cond: 1 };
  cost += SERVICES[s].cost;
};
// улична мрежа: 3 хоризонтални и 3 вертикални улици
for (const y of [4, 11, 18]) for (let i = 0; i < 24; i++) road(ox + i, oy + y);
for (const x of [4, 11, 18]) for (let j = 0; j < 24; j++) if (![4, 11, 18].includes(j)) road(ox + x, oy + j);
// зони покрай улиците
for (const y of [3, 5, 10]) for (let i = 0; i < 24; i++) zone(ox + i, oy + y, 'R');
for (let i = 0; i < 24; i++) zone(ox + i, oy + 12, 'C');
for (const y of [17, 19]) for (let i = 0; i < 24; i++) zone(ox + i, oy + y, i < 8 ? 'O' : 'I');
// ток, вода, основни услуги
svc(ox + 0, oy + 2, 'power_wind');
svc(ox + 1, oy + 2, 'power_wind');
svc(ox + 2, oy + 2, 'water_pump');
svc(ox + 6, oy + 8, 'school');
svc(ox + 14, oy + 8, 'clinic');
svc(ox + 8, oy + 14, 'police_station');
svc(ox + 15, oy + 14, 'fire_station');
svc(ox + 20, oy + 8, 'park');

const pop = { edu: [0, 0, 0], schoolProgress: 0, universityProgress: 0, wages: [...BALANCE.wages.base], happiness: 0.6 };
const policy = {
  taxes: { ...BALANCE.taxes.defaults },
  serviceBudget: 1,
  subsidies: {},
  powerTariff: BALANCE.utilities.defaultPowerTariff,
  waterTariff: BALANCE.utilities.defaultWaterTariff,
  importTariff: 0,
  sanctions: [],
  powerPriority: ['services', 'facilities', 'zones'],
};
let input = {
  cityId: 'balance-city',
  tick: 0,
  tiles,
  territory,
  pop,
  policy,
  facilities: [],
  world,
  ctx: { worldAttractiveness: 0.5, coalPrice: 500, foodPriceRatio: 1, priceIndex: 1, retailSatisfaction: 1, receivership: false },
};
const start = BALANCE.start.cityTreasury;
console.log(`Стартов бюджет: ${eur(start)} · строителство на типичния град: ${eur(cost)} (${Math.round((cost / start) * 100)}% от бюджета)`);
let treasury = start - cost;
let minTreasury = treasury;
for (let d = 0; d < DAYS; d++) {
  const r = stepCity({ ...input, tick: d });
  input = { ...input, tiles: r.tiles, pop: r.pop };
  const inc = Object.values(r.income).reduce((a, b) => a + b, 0);
  const exp = Object.values(r.expenses).reduce((a, b) => a + b, 0);
  treasury += inc - exp;
  minTreasury = Math.min(minTreasury, treasury);
  if ([0, 14, 29, 59, 89, 179, 269, 359, DAYS - 1].includes(d)) {
    const s = r.stats;
    console.log(
      `ден ${String(d + 1).padStart(3)}: жители ${String(s.population).padStart(5)} · сгради ${Object.values(s.buildings).reduce((a, b) => a + b, 0)} · приход ${eur(inc)}/ден · разход ${eur(exp)}/ден · нето ${eur(inc - exp)}/ден · бюджет ${eur(treasury)} · заплата L0 ${eur(r.pop.wages[0])}/ден · щастие ${Math.round(r.pop.happiness * 100)}%`,
    );
    if (d === DAYS - 1) {
      console.log(
        '  stats:',
        JSON.stringify({
          demand: r.stats.demand,
          power: r.stats.power,
          water: r.stats.water,
          blockers: r.stats.upgradeBlockers,
          happy: r.stats.happiness,
          unemp: r.stats.unemploymentRate,
          lv: [1, 2, 3].map((n) => Object.values(r.tiles).filter((t) => t.t === 'zone' && t.lvl === n).length),
        }),
      );
      console.log('  приходи:', Object.fromEntries(Object.entries(r.income).map(([k, v]) => [k, eur(v)])));
      console.log('  разходи:', Object.fromEntries(Object.entries(r.expenses).map(([k, v]) => [k, eur(v)])));
    }
  }
}
console.log(`Най-нисък бюджет: ${eur(minTreasury)}`);
