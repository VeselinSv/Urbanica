/**
 * „Това трябва → онова“: връзки между инструментите, сградите и условията им.
 * Използва се от картичките на инструментите, лентата с подсказка, списъка с условия на сградата,
 * съветника и значките над сградите на картата – всеки липсващ елемент има бутон, който избира
 * точно инструмента, с който се оправя.
 */
import {
  BALANCE,
  SERVICES,
  UPGRADE_REQUIREMENTS,
  UPGRADE_REQUIREMENT_LABELS,
  ZONES,
  type ServiceType,
  type TileMap,
  type UpgradeRequirement,
  type ZoneType,
} from '@gce/shared';
import type { CityDetail, Tool } from '../store';

export const REQ_ICON: Record<UpgradeRequirement, string> = {
  road: '🛣',
  power: '⚡',
  water: '💧',
  sidewalk: '🚶',
  school: '🏫',
  clinic: '🏥',
  police_station: '🚓',
  fire_station: '🚒',
  park: '🌳',
  parking: '🅿',
  bus_depot: '🚌',
  university: '🎓',
  sewage: '🚰',
  waste: '🗑',
  clean_air: '🌫',
  land_value: '💎',
  occupancy: '👥',
  demand: '📈',
  no_issues: '🚨',
};

/** Инструмент, с който се изпълнява условието (ако има такъв). */
export function reqTool(req: UpgradeRequirement): Tool | null {
  switch (req) {
    case 'road':
      return { kind: 'road', cls: 'street' };
    case 'power':
      return { kind: 'service', service: 'power_wind' };
    case 'water':
      return { kind: 'service', service: 'water_pump' };
    case 'sidewalk':
      return { kind: 'sidewalk' };
    case 'sewage':
      return { kind: 'service', service: 'sewage_plant' };
    case 'waste':
      return { kind: 'service', service: 'landfill' };
    case 'clean_air':
      return { kind: 'service', service: 'park' };
    case 'school':
    case 'clinic':
    case 'police_station':
    case 'fire_station':
    case 'park':
    case 'parking':
    case 'bus_depot':
    case 'university':
      return { kind: 'service', service: req };
    default:
      return null;
  }
}

/** Кратък надпис за бутона „оправи“. */
export function reqToolLabel(req: UpgradeRequirement): string {
  const t = reqTool(req);
  if (!t) return '';
  if (t.kind === 'road') return 'Строй път';
  if (t.kind === 'sidewalk') return 'Тротоар';
  if (t.kind === 'service') return SERVICES[t.service as ServiceType].name;
  return 'Строй';
}

/** Условия, които играчът може да изпълни директно (без заетост/търсене/стойност). */
export const ACTIONABLE: UpgradeRequirement[] = [
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
];

export interface NeedItem {
  label: string;
  ok: boolean | null;
  fix?: Tool | null;
  fixLabel?: string;
}

const svcCount = (tiles: TileMap, ...s: ServiceType[]) => Object.values(tiles).filter((t) => t.t === 'service' && s.includes(t.s)).length;

/** Какво е нужно за инструмента и има ли го вече градът. */
export function toolNeeds(tool: Tool, city: CityDetail | null): { needs: NeedItem[]; unlocks?: string } {
  const tiles = (city?.tiles ?? {}) as TileMap;
  const vals = Object.values(tiles);
  const hasRoad = vals.some((t) => t.t === 'road');
  const power = svcCount(tiles, 'power_coal', 'power_wind') > 0 || vals.some((t) => t.t === 'facility' && (t.f === 'coal_power' || t.f === 'solar_farm'));
  const water = svcCount(tiles, 'water_pump') > 0;
  const road: NeedItem = { label: 'Път (до 2 плочки)', ok: hasRoad, fix: { kind: 'road', cls: 'street' }, fixLabel: 'Строй път' };
  switch (tool.kind) {
    case 'road':
      return { needs: [], unlocks: 'Всичко се строи до път: зони и обществени сгради на до 2 плочки. Улиците и булевардите имат тротоари.' };
    case 'sidewalk':
      return {
        needs: [{ label: 'Път или празна земя', ok: hasRoad }],
        unlocks: 'Хората вървят само по тротоари и алеи. Блоковете и магазините от ниво 2 нагоре искат тротоар до тях.',
      };
    case 'busstop':
      return {
        needs: [{ label: 'Автобусно депо', ok: svcCount(tiles, 'bus_depot') > 0, fix: { kind: 'service', service: 'bus_depot' }, fixLabel: 'Депо' }],
        unlocks: `Всяка спирка дава обществен транспорт на ${BALANCE.construction.busStopRadius} плочки около себе си. Автобусите обикалят спирките.`,
      };
    case 'junction':
      return { needs: [{ label: 'Кръстовище с 3+ пътя', ok: null }], unlocks: 'Светофарите и кръговото движение увеличават капацитета и подреждат колите.' };
    case 'zone': {
      const z = tool.zone as ZoneType;
      const def = ZONES[z];
      const d = city?.stats?.demand?.[z];
      const needs: NeedItem[] = [road];
      if (def.needsUtilities) {
        needs.push({ label: 'Ток', ok: power, fix: { kind: 'service', service: 'power_wind' }, fixLabel: 'Централа' });
        needs.push({ label: 'Вода', ok: water, fix: { kind: 'service', service: 'water_pump' }, fixLabel: 'Помпа' });
      }
      needs.push({ label: 'Търсене', ok: d === undefined ? null : d > 0 });
      const lvl2 = UPGRADE_REQUIREMENTS[z][0].filter((r) => !['road', 'power', 'water'].includes(r));
      return { needs, unlocks: `За ниво 2: ${lvl2.map((r) => `${REQ_ICON[r]} ${UPGRADE_REQUIREMENT_LABELS[r]}`).join(', ')}` };
    }
    case 'service': {
      const s = tool.service as ServiceType;
      const def = SERVICES[s];
      const needs: NeedItem[] = [road];
      if (def.power > 0 && s !== 'power_coal' && s !== 'power_wind')
        needs.push({ label: 'Ток за сградата', ok: power, fix: { kind: 'service', service: 'power_wind' }, fixLabel: 'Централа' });
      if (s === 'water_pump') needs.push({ label: 'Близо до река или езеро (повече вода)', ok: null });
      const helps: Partial<Record<ServiceType, string>> = {
        power_wind: 'Ток за всички сгради',
        power_coal: 'Много ток, но замърсява',
        water_pump: 'Вода за всички сгради',
        school: 'Жилища ниво 2+, образовани работници',
        university: 'Технологична зона, жилища ниво 3',
        clinic: 'Жилища ниво 2+, офиси ниво 3',
        police_station: 'Жилища, магазини и офиси ниво 2+',
        fire_station: 'Почти всички сгради ниво 2+',
        park: 'Ниво 3 на жилища, магазини и офиси; чист въздух',
        parking: 'Ниво 3 на магазини и офиси; по-малко обикалящи коли',
        bus_depot: 'Ниво 3, по-малко трафик; автобуси по улиците',
        sewage_plant: 'Ниво 3 (канализация)',
        landfill: 'Ниво 3 (отпадъци)',
      };
      return { needs, unlocks: helps[s] ? `Отключва: ${helps[s]}` : undefined };
    }
    default:
      return { needs: [] };
  }
}

/** Кратък ред „нужно: …“ за картичките на инструментите. */
export function needsLine(tool: Tool): string | undefined {
  if (tool.kind === 'zone') return ZONES[tool.zone as ZoneType].needsUtilities ? 'нужни: 🛣 път · ⚡ ток · 💧 вода' : 'нужен: 🛣 път';
  if (tool.kind === 'service') {
    const s = tool.service as ServiceType;
    return SERVICES[s].power > 0 && s !== 'power_coal' && s !== 'power_wind' ? 'нужни: 🛣 път · ⚡ ток' : 'нужен: 🛣 път';
  }
  return undefined;
}
