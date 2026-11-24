/**
 * „От какво се нуждае градът сега“ – подредени по спешност нужди, всяка с причина и бутон, който
 * директно избира правилния инструмент/слой/панел. Смята се само от данните на града в браузъра.
 */
import { SERVICES, ZONES, zonesServedBy, type MoodFactor, type TileMap, type ZoneType } from '@gce/shared';
import { setState, useStore, type CityDetail, type CoverageOf, type Layer, type Tool } from '../store';
import { CORE_KINDS, COVERAGE_ICON, coverageView } from '../map/coverage';
import { money, num, pct } from '../format';
import { Section } from './common';

interface Need {
  /** 3 – спешно, 2 – важно, 1 – добре е */
  level: 1 | 2 | 3;
  icon: string;
  text: string;
  why: string;
  button?: string;
  tool?: Tool;
  layer?: Layer;
  coverageOf?: CoverageOf;
  panel?: string;
}

type S = {
  population?: number;
  unemploymentRate?: number;
  net?: number;
  demand?: Partial<Record<ZoneType, number>>;
  power?: { supply: number; demand: number; ratio: number };
  water?: { supply: number; demand: number; ratio: number };
  sewage?: { capacity: number; load: number };
  waste?: { capacity: number; load: number };
  traffic?: { congestion: number; commuteMinutes: number };
  pollutionAvg?: number;
  mood?: Partial<Record<MoodFactor, number>>;
  abandoned?: number;
};

const ZONE_ICON: Record<ZoneType, string> = { R: '🏠', C: '🛍', I: '🏭', O: '🏢', A: '🌾', L: '📦', H: '🔬' };
/** За кои зони е нужна услугата – с малки букви, напр. „жилищна, търговска, офисна“. */
const servedText = (service: string) =>
  zonesServedBy(service)
    .map((z) => ZONES[z].name.toLowerCase())
    .join(', ');

export function cityNeeds(
  city: { tiles: unknown; parcels: { px: number; py: number }[]; stats?: unknown; treasury?: number; border?: CityDetail['border'] },
  openIssues: number,
): Need[] {
  const s = (city.stats ?? {}) as S;
  const tiles = city.tiles as TileMap;
  const out: Need[] = [];
  const bd = city.border;
  if (bd?.blocked) {
    const names = bd.neighbors.filter((n) => !bd.linked.includes(n.id)).map((n) => `„${n.name}“`);
    return [
      {
        level: 3,
        icon: '🛣',
        text: `Магистрала до ${names.join(', ')}`,
        why: `Градът опря до съседен град. Градовете се свързват само с градска магистрала от поне ${bd.min} плочки до границата – дотогава не може да се строи нищо друго (сега: ${bd.longest}).`,
        button: '🚀 Магистрала',
        tool: { kind: 'road', cls: 'highway' },
      },
    ];
  }
  const pop = s.population ?? 0;
  const hasRoad = Object.values(tiles).some((t) => t.t === 'road');
  if (!hasRoad) return [{ level: 3, icon: '🛣', text: 'Първа улица', why: 'Всичко в града се строи до път.', button: 'Строй улица', tool: { kind: 'road', cls: 'street' } }];

  // мрежи – без тях нищо не расте
  const pw = s.power;
  if (pw && pw.demand > 0 && pw.supply < pw.demand)
    out.push({
      level: 3,
      icon: '⚡',
      text: `Недостиг на ток: ${num(pw.demand - pw.supply)} ед.`,
      why: `Произвеждат се ${num(pw.supply)} от нужните ${num(pw.demand)} – сградите без ток не растат и хората са недоволни.`,
      button: '+ Централа',
      tool: { kind: 'service', service: 'power_wind' },
      layer: 'power',
    });
  const wt = s.water;
  if (wt && wt.demand > 0 && wt.supply < wt.demand)
    out.push({
      level: 3,
      icon: '💧',
      text: `Недостиг на вода: ${num(wt.demand - wt.supply)} ед.`,
      why: `Подават се ${num(wt.supply)} от нужните ${num(wt.demand)}. Помпа до река дава най-много.`,
      button: '+ Помпена станция',
      tool: { kind: 'service', service: 'water_pump' },
      layer: 'water',
    });
  if (s.sewage && s.sewage.load > s.sewage.capacity && pop > 0)
    out.push({
      level: 2,
      icon: '🚽',
      text: 'Канализацията е претоварена',
      why: `Товар ${num(s.sewage.load)} при капацитет ${num(s.sewage.capacity)} – замърсява и сваля стойността на земята.`,
      button: '+ Пречиствателна',
      tool: { kind: 'service', service: 'sewage_plant' },
    });
  if (s.waste && s.waste.load > s.waste.capacity && pop > 0)
    out.push({
      level: 2,
      icon: '🗑',
      text: 'Боклукът не се събира',
      why: `Отпадъци ${num(s.waste.load)} при капацитет ${num(s.waste.capacity)}.`,
      button: '+ Сметище',
      tool: { kind: 'service', service: 'landfill' },
    });

  // работа
  const u = s.unemploymentRate ?? 0;
  if (pop > 0 && u > 0.1) {
    const d = s.demand ?? {};
    const z = (['I', 'C', 'O'] as ZoneType[]).sort((a, b) => (d[b] ?? 0) - (d[a] ?? 0))[0];
    out.push({
      level: u > 0.2 ? 3 : 2,
      icon: '💼',
      text: `Безработица ${pct(u, 0)}`,
      why: `Безработните не плащат данъци и са недоволни. Най-търсена зона за работа: ${ZONES[z].name.toLowerCase()}.`,
      button: `${ZONE_ICON[z]} ${ZONES[z].name}`,
      tool: { kind: 'zone', zone: z },
    });
  }

  // обхват на основните услуги
  if (pop > 0)
    for (const k of CORE_KINDS) {
      const v = coverageView(tiles, city.parcels, k);
      if (v.uncovered > 0)
        out.push({
          level: v.sources === 0 && pop > 300 ? 3 : 2,
          icon: COVERAGE_ICON[k],
          text: v.sources === 0 ? `Няма ${SERVICES[k].name.toLowerCase()}` : `${v.uncovered} сгради без ${SERVICES[k].name.toLowerCase()}`,
          why:
            v.sources === 0
              ? 'Сградите не стигат следващото ниво без тази услуга, а хората са по-недоволни.'
              : `Покрити са ${v.covered} от ${v.covered + v.uncovered} сгради, които имат нужда (${servedText(k)}). Вижте червените плочки на слоя „Обхват“.`,
          button: `+ ${SERVICES[k].name}`,
          tool: { kind: 'service', service: k },
          layer: 'coverage',
          coverageOf: k,
        });
    }
  const hasDepot = Object.values(tiles).some((t) => t.t === 'service' && t.s === 'bus_depot');
  if (pop > 2000 && !hasDepot)
    out.push({
      level: 1,
      icon: '🚌',
      text: 'Няма обществен транспорт',
      why: 'Автобусно депо + спирки намаляват задръстванията и времето до работа.',
      button: '+ Автобусно депо',
      tool: { kind: 'service', service: 'bus_depot' },
      layer: 'coverage',
      coverageOf: 'bus_depot',
    });

  // търсене на зони
  const d = s.demand ?? {};
  for (const z of ['R', 'C', 'I', 'O'] as ZoneType[]) {
    const v = d[z] ?? 0;
    if (v > 0.45)
      out.push({
        level: 1,
        icon: ZONE_ICON[z],
        text: `Търсят се ${ZONES[z].name.toLowerCase()} (${pct(v, 0)})`,
        why: 'Зонирайте още до път с ток и вода – сградите идват сами.',
        button: `${ZONE_ICON[z]} Зонирай`,
        tool: { kind: 'zone', zone: z },
      });
  }

  // трафик
  if ((s.traffic?.congestion ?? 0) > 1)
    out.push({
      level: 2,
      icon: '🚦',
      text: `Задръствания (${Math.round((s.traffic?.congestion ?? 0) * 100)}% натоварване)`,
      why: `Пътят до работа е ${s.traffic?.commuteMinutes ?? 0} мин. Булеварди, кръгови и автобуси помагат.`,
      button: '🛤 Булевард',
      tool: { kind: 'road', cls: 'avenue' },
      layer: 'traffic',
    });

  // пари
  if ((s.net ?? 0) < 0)
    out.push({
      level: (city.treasury ?? 0) < 0 ? 3 : 2,
      icon: '💶',
      text: `Бюджетът губи ${money(-(s.net ?? 0))} на ден`,
      why: 'Вижте разходите и данъците. Повече работещи жители = повече данъци.',
      button: 'Финанси',
      panel: 'finance',
    });
  if (openIssues > 0)
    out.push({
      level: openIssues > 3 ? 2 : 1,
      icon: '📣',
      text: `${openIssues} нерешени сигнала`,
      why: 'Дупки, аварии и боклук дразнят хората и пречат на движението.',
      button: 'Сигнали',
      panel: 'issues',
    });
  if ((s.abandoned ?? 0) > 0)
    out.push({
      level: 1,
      icon: '🏚',
      text: `${s.abandoned} изоставени сгради`,
      why: 'Обикновено заради липса на ток/вода, работници или клиенти. Посочете ги на картата за подробности.',
    });

  // най-тежкият фактор за удовлетвореността
  const worst = Object.entries(s.mood ?? {}).sort((a, b) => a[1] - b[1])[0];
  if (worst && worst[1] < -0.05 && !['utilities', 'jobs', 'issues'].includes(worst[0]))
    out.push({
      level: 2,
      icon: '😟',
      text: 'Хората са недоволни',
      why: `Най-много ги дразни: ${MOOD_SHORT[worst[0] as MoodFactor] ?? worst[0]} (−${Math.round(-worst[1] * 100)}).`,
      button: 'Подробно',
      panel: 'city',
    });
  return out.sort((a, b) => b.level - a.level);
}

const MOOD_SHORT: Partial<Record<MoodFactor, string>> = {
  wages: 'ниски заплати спрямо цените',
  prices: 'скъпа храна или празни магазини',
  rent: 'високи наеми или препълнени жилища',
  services: 'липсващи услуги',
  budget: 'орязан бюджет на услугите',
  taxes: 'високи данъци',
  commute: 'дълъг път до работа',
  pollution: 'замърсяване',
};

export function CityNeeds() {
  const city = useStore((s) => s.city);
  const issues = useStore((s) => s.issues);
  if (!city?.isOwner) return null;
  const needs = cityNeeds(city, issues.length).slice(0, 6);
  return (
    <Section title="От какво се нуждае градът сега">
      {needs.length === 0 ? (
        <p className="small good">✓ Нищо спешно – градът е добре. Разширявайте зоните според търсенето.</p>
      ) : (
        <ul className="needs-list">
          {needs.map((n, i) => (
            <li key={i} className={`need-${n.level}`}>
              <span className="need-icon">{n.icon}</span>
              <span className="need-text">
                <b>{n.text}</b>
                <small>{n.why}</small>
              </span>
              {n.button && (
                <button
                  className={`btn small ${n.level === 3 ? 'primary' : ''}`}
                  onClick={() =>
                    setState({
                      ...(n.tool ? { tool: n.tool } : {}),
                      ...(n.layer ? { layer: n.layer } : {}),
                      ...(n.coverageOf ? { coverageOf: n.coverageOf } : {}),
                      ...(n.panel ? { panel: n.panel, panelOpen: true } : {}),
                    })
                  }
                >
                  {n.button}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
