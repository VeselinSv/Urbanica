/**
 * План за развитие: етапи от първия път до голям град. Всеки етап казва какво да се направи, защо е нужно
 * и има бутон, който избира точния инструмент. Проверките са върху плочките и статистиката на града.
 */
import { useState } from 'react';
import { BALANCE, SERVICES, UPGRADE_REQUIREMENTS, UPGRADE_REQUIREMENT_LABELS, ZONES, hasSidewalk, type ServiceType, type TileMap, type ZoneType } from '@gce/shared';
import { getState, setState, useStore, type Tool } from '../store';
import { money, num } from '../format';

type CityLike = NonNullable<ReturnType<typeof getState>['city']>;

export interface Goal {
  id: string;
  icon: string;
  title: string;
  /** Защо е нужно – с прости думи. */
  why: string;
  done: (c: CityLike, ctx: { companies: number }) => boolean;
  /** Прогрес 0..1 (по желание) и текст към него. */
  progress?: (c: CityLike) => { v: number; label: string };
  tool?: Tool;
  /** Инструмент и надпис според състоянието на града (по-точни от tool/button). */
  pick?: (c: CityLike) => { tool: Tool; button: string };
  /** Действие вместо инструмент (напр. отваряне на панел). */
  run?: () => void;
  button?: string;
  /** Подробни стъпки: какво точно да се направи, къде, колко струва и какво ще стане. */
  steps?: (c: CityLike) => string[];
}

const price = (s: ServiceType) => money(SERVICES[s].cost);
const SKIP_REQ = new Set(['road', 'power', 'water']);
/** Какво иска зоната за ниво 2 и за ниво 3 (без път, ток и вода) – с думи. */
export function zoneNeedsText(z: ZoneType): string {
  const [l2, l3] = UPGRADE_REQUIREMENTS[z];
  const name = (r: string) => UPGRADE_REQUIREMENT_LABELS[r as keyof typeof UPGRADE_REQUIREMENT_LABELS].replace(' в обхват', '').toLowerCase();
  const a = l2.filter((r) => !SKIP_REQ.has(r)).map(name);
  const b = l3.filter((r) => !SKIP_REQ.has(r) && !l2.includes(r)).map(name);
  return `за ниво 2: ${a.length ? a.join(', ') : 'само път, ток и вода'}; за ниво 3 още: ${b.join(', ')}`;
}
const zonePrice = (z: keyof typeof ZONES) => money(ZONES[z].zoningCost);
const streetPrice = () => money(Math.round(BALANCE.construction.roadCost * BALANCE.construction.roadClasses.street.cost));
type Stats = {
  population?: number;
  unemploymentRate?: number;
  workforce?: number;
  vacancies?: number;
  power?: { supply?: number; demand?: number };
  water?: { supply?: number; demand?: number };
  demand?: Record<string, number>;
};
export const statsOf = (c: CityLike) => (c.stats ?? {}) as Stats;

const tilesOf = (c: CityLike) => Object.values(c.tiles as TileMap);
const count = (c: CityLike, f: (t: TileMap[string]) => boolean) => tilesOf(c).filter(f).length;
const svc = (c: CityLike, ...s: string[]) => count(c, (t) => t.t === 'service' && s.includes(t.s));
const zones = (c: CityLike, z: string) => count(c, (t) => t.t === 'zone' && t.z === z);
/** Построени сгради (не само зонирани парцели). */
const built = (c: CityLike, z: string) => count(c, (t) => t.t === 'zone' && t.z === z && t.lvl > 0 && !t.ab);
const pop = (c: CityLike) => (c.stats as { population?: number } | undefined)?.population ?? 0;
const popGoal = (n: number) => (c: CityLike) => ({ v: Math.min(1, pop(c) / n), label: `${num(pop(c))} / ${num(n)} жители` });

export const GOALS: Goal[] = [
  {
    id: 'road',
    icon: '🛣',
    title: 'Първата улица',
    why: 'Всичко в града се строи до път – без улица няма къщи, магазини и услуги. Влачете по територията (златистата рамка).',
    done: (c) => count(c, (t) => t.t === 'road') >= 6,
    progress: (c) => ({ v: Math.min(1, count(c, (t) => t.t === 'road') / 6), label: `${count(c, (t) => t.t === 'road')} / 6 плочки път` }),
    tool: { kind: 'road', cls: 'street' },
    button: 'Строй улица',
    steps: () => [
      `Отляво натиснете „Пътища“ → „Улица“ (${streetPrice()} на плочка; мост над река струва ×4).`,
      'Натиснете върху плочка в златистата рамка на града и влачете – пътят върви по права линия или с един завой. Пуснете, за да го построите.',
      'Направете поне 6 плочки. Оставете празна земя от двете страни: всяка сграда трябва да е точно до пътя (на 1 плочка).',
      'Удобно е улиците да са успоредни през 2–3 плочки – между тях се побират къщи от двете страни.',
    ],
  },
  {
    id: 'homes',
    icon: '🏠',
    title: 'Жилища',
    why: 'Хората идват сами, ако има къде да живеят. Оградете правоъгълник до пътя с „Жилищна зона“.',
    done: (c) => zones(c, 'R') >= 8,
    progress: (c) => ({ v: Math.min(1, zones(c, 'R') / 8), label: `${zones(c, 'R')} / 8 жилищни парцела` }),
    tool: { kind: 'zone', zone: 'R' },
    button: 'Жилищна зона',
    steps: (c) => [
      `Отляво „Зони“ → „Жилищна“ (${zonePrice('R')} на парцел).`,
      'Влачете правоъгълник от плочки точно до пътя – само плочките, които докосват пътя, ще получат къщи.',
      `Трябват поне 8 парцела (сега: ${zones(c, 'R')}). Не зонирайте върху реката – там може да мине само път (мост).`,
      'Къщите се строят сами за ~3 дни, но само ако има ток и вода (следващите етапи).',
    ],
  },
  {
    id: 'power',
    icon: '⚡',
    title: 'Ток',
    why: 'Без ток сградите не се строят. Вятърната централа е евтина и чиста – сложете я до път.',
    done: (c) => svc(c, 'power_wind', 'power_coal') >= 1,
    tool: { kind: 'service', service: 'power_wind' },
    button: 'Вятърна централа',
    steps: (c) => [
      `Отляво „Услуги“ → „${SERVICES.power_wind.name}“ (${price('power_wind')}, дава ${SERVICES.power_wind.powerSupply} MW, без замърсяване) или „${SERVICES.power_coal.name}“ (${price('power_coal')}, ${SERVICES.power_coal.powerSupply} MW, но замърсява и гори въглища).`,
      'Щракнете върху празна плочка точно до път. Сложете централата далеч от къщите – тя не трябва да е в центъра.',
      `Нужно е повече ток, отколкото се потребява: сега ${num(statsOf(c).power?.supply ?? 0)} / ${num(statsOf(c).power?.demand ?? 0)} MW (дадено / нужно). Лентата „Ток“ горе трябва да е синя, не червена.`,
    ],
  },
  {
    id: 'water',
    icon: '💧',
    title: 'Вода',
    why: 'Помпената станция дава вода. До река дава много повече – сложете я на брега.',
    done: (c) => svc(c, 'water_pump') >= 1,
    tool: { kind: 'service', service: 'water_pump' },
    button: 'Помпена станция',
    steps: (c) => [
      `Отляво „Услуги“ → „${SERVICES.water_pump.name}“ (${price('water_pump')}, до ${SERVICES.water_pump.waterSupply} м³ на ден).`,
      'Сложете я на суша точно до път и до река или езеро – там дава най-много вода. Върху самата река не може.',
      'Помпата иска малко ток – първо трябва да има централа.',
      `Сега: ${num(statsOf(c).water?.supply ?? 0)} / ${num(statsOf(c).water?.demand ?? 0)} м³ (дадено / нужно). Ако лентата „Вода“ стане червена, постройте още една помпа.`,
    ],
  },
  {
    id: 'jobs',
    icon: '💼',
    title: 'Работни места',
    why: 'Жителите плащат данъци само ако работят. Търговията и индустрията дават работа – иначе безработицата расте и хората си тръгват.',
    done: (c) => built(c, 'C') >= 3 && built(c, 'I') >= 3,
    progress: (c) => ({
      v: Math.min(1, (Math.min(3, built(c, 'C')) + Math.min(3, built(c, 'I'))) / 6),
      label: `построени: търговия ${built(c, 'C')}/3 · индустрия ${built(c, 'I')}/3`,
    }),
    tool: { kind: 'zone', zone: 'C' },
    button: 'Търговска зона',
    // зоната, която липсва; ако и двете ги има, но не се строят – тази с най-голямо търсене
    pick: (c) => {
      const z = zones(c, 'I') === 0 ? 'I' : zones(c, 'C') === 0 ? 'C' : bestJobZone(c).zone;
      return { tool: { kind: 'zone', zone: z }, button: z === 'I' ? 'Индустриална зона' : z === 'C' ? 'Търговска зона' : 'Офисна зона' };
    },
    steps: (c) => jobSteps(c),
  },
  {
    id: 'school',
    icon: '🏫',
    title: 'Училище',
    why: 'Образованите хора вземат по-добре платени работи (повече данъци), а къщите стават блокове.',
    done: (c) => svc(c, 'school') >= 1,
    tool: { kind: 'service', service: 'school' },
    button: 'Училище',
    steps: () => [
      `Отляво „Услуги“ → „${SERVICES.school.name}“ (${price('school')}, ${SERVICES.school.capacity} ученици).`,
      `Обслужва къщите в радиус ${SERVICES.school.radius} плочки – сложете го в средата на жилищния квартал, до път.`,
      'С „Слоеве“ → „Обхват на услугите“ виждате кои къщи са извън обхвата. За по-голям град трябват няколко училища.',
    ],
  },
  {
    id: 'sidewalks',
    icon: '🚶',
    title: 'Тротоари',
    why: 'Блоковете и магазините от ниво 2 искат тротоари – хората ходят пеша до работа и магазин.',
    done: (c) => count(c, (t) => t.t === 'road' && hasSidewalk(t)) >= 10,
    progress: (c) => {
      const n = count(c, (t) => t.t === 'road' && hasSidewalk(t));
      return { v: Math.min(1, n / 10), label: `${n} / 10 улици с тротоар` };
    },
    tool: { kind: 'sidewalk' },
    button: 'Тротоари',
    steps: (c) => [
      `Отляво „Пътища“ → „Тротоар / алея“ (${money(BALANCE.construction.sidewalkCost)} на плочка).`,
      'Влачете по съществуващите улици между жилищата и магазините – тротоарът се добавя към пътя, не заема място.',
      `Нужни са поне 10 улици с тротоар (сега: ${count(c, (t) => t.t === 'road' && hasSidewalk(t))}). Магистралите нямат тротоари.`,
    ],
  },
  {
    id: 'safety',
    icon: '🚓',
    title: 'Полиция и пожарна',
    why: 'Без тях градът е опасен: привлекателността пада, а магазините и офисите не растат.',
    done: (c) => svc(c, 'police_station') >= 1 && svc(c, 'fire_station') >= 1,
    tool: { kind: 'service', service: 'police_station' },
    button: 'Полиция',
    run: undefined,
    steps: () => [
      `„Услуги“ → „${SERVICES.police_station.name}“ (${price('police_station')}) и „${SERVICES.fire_station.name}“ (${price('fire_station')}).`,
      `Всяка обслужва радиус ${SERVICES.police_station.radius} плочки – сложете ги между жилищата и магазините, до път.`,
      'Проверете със „Слоеве“ → „Обхват на услугите“, че целият град е оцветен; ако не е – добавете още една на непокритото място.',
    ],
  },
  {
    id: 'pop1000',
    icon: '👥',
    title: '1 000 жители',
    why: 'Повече жилища и работа. Гледайте лентите „Търсене по зони“ в панела „Град“ – зонирайте това, което е зелено.',
    done: (c) => pop(c) >= 1000,
    progress: popGoal(1000),
    tool: { kind: 'zone', zone: 'R' },
    button: 'Още жилища',
    steps: (c) => [
      `Сега: ${num(pop(c))} жители. Отворете панела „Град“ вдясно и вижте лентите „Търсене по зони“.`,
      'Зонирайте това, което има най-голямо търсене (най-дългата лента): жилища, търговия, индустрия или офиси.',
      'Пазете баланс: на 2 жилищни парцела – около 1 парцел работа (търговия/индустрия), иначе расте безработицата.',
      'Следете тока и водата горе – новите сгради не се строят, ако лентите са червени.',
    ],
  },
  {
    id: 'health',
    icon: '🏥',
    title: 'Болница и парк',
    why: 'Здравите и доволни хора остават – а болницата е нужна, за да станат блоковете ниво 3.',
    done: (c) => svc(c, 'clinic') >= 1 && svc(c, 'park') >= 1,
    tool: { kind: 'service', service: 'clinic' },
    button: 'Болница',
    steps: () => [
      `„Услуги“ → „${SERVICES.clinic.name}“ (${price('clinic')}, за ${num(SERVICES.clinic.capacity ?? 0)} души, радиус ${SERVICES.clinic.radius}).`,
      `„Услуги“ → „${SERVICES.park.name}“ (${price('park')}) – сложете го между къщите; съседните паркове се сливат в един голям.`,
      'Паркът намалява замърсяването и вдига цената на земята около себе си.',
    ],
  },
  {
    id: 'utilities',
    icon: '♻',
    title: 'Пречиствателна и сметище',
    why: 'Над няколко хиляди жители канализацията и боклукът преливат – сигналите се трупат и сградите не се надграждат.',
    done: (c) => svc(c, 'sewage_plant') >= 1 && svc(c, 'landfill') >= 1,
    tool: { kind: 'service', service: 'sewage_plant' },
    button: 'Пречиствателна',
    steps: () => [
      `„Услуги“ → „${SERVICES.sewage_plant.name}“ (${price('sewage_plant')}) и „${SERVICES.landfill.name}“ (${price('landfill')}).`,
      'И двете миришат и замърсяват – сложете ги в края на града, до индустрията и далеч от жилищата, но до път.',
      'След това сигналите „канализация“ и „боклук“ спират да се появяват.',
    ],
  },
  {
    id: 'offices',
    icon: '🏢',
    title: 'Офиси',
    why: 'Офисите плащат най-високите заплати (и данъци). Искат полиция, пожарна, обществен транспорт, паркове и хора с висше образование.',
    done: (c) => built(c, 'O') >= 2,
    progress: (c) => ({ v: Math.min(1, built(c, 'O') / 2), label: `${built(c, 'O')} / 2 построени офиса` }),
    tool: { kind: 'zone', zone: 'O' },
    button: 'Офисна зона',
    steps: (c) => [
      `„Зони“ → „Офисна“ (${zonePrice('O')} на парцел), до път с ток и вода.`,
      `Офисите се строят само при достатъчно висока цена на земята (поне ${Math.round(ZONES.O.landValueReq[0] * 100)}%): сложете ги в центъра, до парк, далеч от индустрията.`,
      `Какво искат в обхват – ${zoneNeedsText('O')}.`,
      `Искат образовани работници – ${Math.round(ZONES.O.eduMix[1] * 100)}% със средно и ${Math.round(ZONES.O.eduMix[2] * 100)}% с висше образование. Хората се учат в училищата и университета в жилищните квартали.`,
      `Сега има ${built(c, 'O')} построени офиса от 2. Ако парцелите стоят празни – „Слоеве“ → „Стойност на земята“ показва къде става.`,
    ],
  },
  {
    id: 'transit',
    icon: '🚌',
    title: 'Автобуси',
    why: 'Депо и спирки разтоварват задръстванията – хората стигат по-бързо до работа.',
    done: (c) => svc(c, 'bus_depot') >= 1 && count(c, (t) => t.t === 'road' && !!t.st) >= 2,
    tool: { kind: 'service', service: 'bus_depot' },
    button: 'Автобусно депо',
    steps: () => [
      `„Услуги“ → „${SERVICES.bus_depot.name}“ (${price('bus_depot')}), до път.`,
      `„Пътища“ → „Автобусна спирка“ (${money(BALANCE.construction.busStopCost)}): щракнете върху улица – поне 2 спирки, в жилищния квартал и при работните места.`,
      `Всяка спирка обслужва радиус ${BALANCE.construction.busStopRadius} плочки около себе си.`,
    ],
  },
  {
    id: 'pop5000',
    icon: '🌆',
    title: '5 000 жители',
    why: 'Купете съседна земя („Земя“) и разширете кварталите. Следете безработицата да е под 10%.',
    done: (c) => pop(c) >= 5000,
    progress: popGoal(5000),
    tool: { kind: 'parcel' },
    button: 'Купи земя',
    steps: (c) => [
      `Сега: ${num(pop(c))} жители, безработица ${Math.round((statsOf(c).unemploymentRate ?? 0) * 100)}%.`,
      'Отляво „Земя“ → щракнете върху парцел до вашата територия, за да го купите.',
      'Продължете улиците в новия парцел и зонирайте по търсенето – новите квартали също искат училище, полиция и пожарна в обхват.',
    ],
  },
  {
    id: 'company',
    icon: '🏭',
    title: 'Собствена компания',
    why: 'С личния капитал основете компания (панел „Бизнес“) – ферма, мина или завод носят печалба и работа за града.',
    done: (_c, ctx) => ctx.companies > 0,
    run: () => setState({ panel: 'companies', panelOpen: true }),
    button: 'Към „Бизнес“',
    steps: () => [
      'Вдясно „Бизнес“ → бутона „Основи“: изберете име, град и капитал (взима се от личните ви пари, не от бюджета на града).',
      'Първото предприятие: ферма (на плодородна земя) или дърводобив (до гора) – суровините се продават веднага на световния пазар.',
      'Предприятието трябва да е точно до път. В панела на компанията „Развитие“ показва печалбата и следващата стъпка.',
    ],
  },
  {
    id: 'pop10000',
    icon: '🏙',
    title: '10 000 жители и университет',
    why: 'Голям град с висше образование: университетът дава специалисти за високотехнологичните зони.',
    done: (c) => pop(c) >= 10000 && svc(c, 'university') >= 1,
    progress: popGoal(10000),
    tool: { kind: 'service', service: 'university' },
    button: 'Университет',
    steps: (c) => [
      `Сега: ${num(pop(c))} от 10 000 жители.`,
      `„Услуги“ → „${SERVICES.university.name}“ (${price('university')}, радиус ${SERVICES.university.radius} плочки – един стига за целия град).`,
      'Университетът дава хора с висше образование – те работят в офисите и високите технологии и плащат най-много данъци.',
    ],
  },
];

/** Надписът на бутона на етапа за текущия град. */
export function goalButton(g: Goal, c: CityLike): string | undefined {
  return g.pick ? g.pick(c).button : g.button;
}

const JOB_ZONES = [
  { zone: 'I' as const, label: 'Индустриална зона', name: 'индустрия' },
  { zone: 'C' as const, label: 'Търговска зона', name: 'търговия' },
  { zone: 'O' as const, label: 'Офисна зона', name: 'офиси' },
];

/** Зоната за работни места с най-голямо търсене (лентите „Търсене по зони“) – там новите сгради ще се построят. */
export function bestJobZone(c: CityLike) {
  const d = ((c.stats as { demand?: Record<string, number> } | undefined)?.demand ?? {}) as Record<string, number>;
  const best = [...JOB_ZONES].sort((a, b) => (d[b.zone] ?? 0) - (d[a.zone] ?? 0))[0];
  const v = d[best.zone] ?? 0;
  const why =
    v > 0.05
      ? `Най-голямо е търсенето на ${best.name} (${Math.round(v * 100)}%) – зонирайте ${best.name} до път с ток и вода.`
      : `Зонирайте ${best.name} до път с ток и вода – свободните работници привличат бизнес и търсенето ще расте.`;
  return { ...best, why };
}

/** Подробни стъпки срещу безработицата / за работни места – с числата на града. */
export function jobSteps(c: CityLike): string[] {
  const S = statsOf(c);
  const job = bestJobZone(c);
  const unemployed = Math.round((S.workforce ?? 0) * (S.unemploymentRate ?? 0));
  const z = ZONES[job.zone];
  const perLot = z.capacity[0];
  const lots = Math.max(1, Math.ceil(unemployed / perLot));
  const edu = z.eduMix;
  const out = [
    unemployed > 0
      ? `Без работа са около ${num(unemployed)} души. Един нов парцел „${z.name}“ дава ~${perLot} работни места (ниво 1), значи трябват около ${num(lots)} парцела.`
      : `Един парцел „${z.name}“ дава ~${perLot} работни места на ниво 1 и до ${z.capacity[2]} на ниво 3.`,
    `Отляво „Зони“ → „${z.name}“ (${money(z.zoningCost)} на парцел) и влачете по плочките точно до път (на 1 плочка от него).`,
    'Парцелите трябва да имат ток и вода – лентите горе да не са червени, иначе сградите не се строят.',
  ];
  if (job.zone === 'I')
    out.push('Индустрията замърсява – сложете я в края на града, далеч от къщите. Не ѝ трябват училища и паркове, а пожарна (заводите горят най-често).');
  if (job.zone === 'C') out.push('Магазините растат най-добре между жилищата – хората пазаруват близо до дома.');
  if (job.zone === 'O')
    out.push(
      `Офисите искат цена на земята поне ${Math.round(z.landValueReq[0] * 100)}% (до парк, далеч от индустрия) и образовани хора (${Math.round(edu[1] * 100)}% средно, ${Math.round(edu[2] * 100)}% висше).`,
    );
  out.push(`За да растат, сградите искат в обхват – ${zoneNeedsText(job.zone)}.`);
  out.push('Сградата се строи за няколко дни; после безработицата пада и данъците растат (вижте „Пари“).');
  return out;
}

export function planState(c: CityLike) {
  const ctx = { companies: getState().companies.filter((x) => x.roles.length).length };
  const done = GOALS.map((g) => g.done(c, ctx));
  const next = GOALS.findIndex((_g, i) => !done[i]);
  return { done, next, total: GOALS.length, finished: done.filter(Boolean).length };
}

export function runGoal(g: Goal) {
  const c = getState().city;
  const p = c && g.pick ? g.pick(c) : null;
  if (p) setState({ tool: p.tool });
  else if (g.run) g.run();
  else if (g.tool) setState({ tool: g.tool });
}

/** Карта с плана: текущият етап отгоре (с обяснение и бутон), под нея – всички етапи. */
export function DevPlan() {
  const city = useStore((s) => s.city);
  useStore((s) => s.companies);
  const [all, setAll] = useState(false);
  if (!city?.isOwner) return null;
  const st = planState(city);
  const cur = st.next >= 0 ? GOALS[st.next] : null;
  const p = cur?.progress?.(city);
  return (
    <div className="plan">
      <div className="plan-head">
        <b>🎯 План за развитие</b>
        <span className="muted small">
          {st.finished} / {st.total}
        </span>
      </div>
      <div className="plan-bar">
        <i style={{ width: `${(st.finished / st.total) * 100}%` }} />
      </div>
      {cur ? (
        <div className="plan-cur">
          <div className="plan-title">
            <span>{cur.icon}</span> {cur.title}
          </div>
          <p className="small">{cur.why}</p>
          {p && (
            <div className="plan-prog small muted">
              <div className="plan-bar thin">
                <i style={{ width: `${p.v * 100}%` }} />
              </div>
              {p.label}
            </div>
          )}
          {cur.steps && (
            <ol className="adv-steps plan-steps">
              {cur.steps(city).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
          )}
          {goalButton(cur, city) && (
            <button className="btn primary small" onClick={() => runGoal(cur)}>
              {goalButton(cur, city)}
            </button>
          )}
        </div>
      ) : (
        <p className="small">Всички етапи са изпълнени – градът е голям и печеливш. Продължавайте да го разширявате!</p>
      )}
      <button className="link small" onClick={() => setAll(!all)}>
        {all ? '▾ Скрий етапите' : '▸ Всички етапи'}
      </button>
      {all && (
        <ol className="plan-list">
          {GOALS.map((g, i) => (
            <li key={g.id} className={st.done[i] ? 'done' : i === st.next ? 'cur' : ''}>
              <span>{st.done[i] ? '✓' : g.icon}</span> {g.title}
              {!st.done[i] && goalButton(g, city) && (
                <button className="link small" onClick={() => runGoal(g)}>
                  {goalButton(g, city)}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
