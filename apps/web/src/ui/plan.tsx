/**
 * План за развитие: етапи от първия път до голям град. Всеки етап казва какво да се направи, защо е нужно
 * и има бутон, който избира точния инструмент. Проверките са върху плочките и статистиката на града.
 */
import { useState } from 'react';
import { hasSidewalk, type TileMap } from '@gce/shared';
import { getState, setState, useStore, type Tool } from '../store';
import { num } from '../format';

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
}

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
  },
  {
    id: 'power',
    icon: '⚡',
    title: 'Ток',
    why: 'Без ток сградите не се строят. Вятърната централа е евтина и чиста – сложете я до път.',
    done: (c) => svc(c, 'power_wind', 'power_coal') >= 1,
    tool: { kind: 'service', service: 'power_wind' },
    button: 'Вятърна централа',
  },
  {
    id: 'water',
    icon: '💧',
    title: 'Вода',
    why: 'Помпената станция дава вода. До река дава много повече – сложете я на брега.',
    done: (c) => svc(c, 'water_pump') >= 1,
    tool: { kind: 'service', service: 'water_pump' },
    button: 'Помпена станция',
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
  },
  {
    id: 'school',
    icon: '🏫',
    title: 'Училище',
    why: 'Образованите хора вземат по-добре платени работи (повече данъци), а къщите стават блокове.',
    done: (c) => svc(c, 'school') >= 1,
    tool: { kind: 'service', service: 'school' },
    button: 'Училище',
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
  },
  {
    id: 'health',
    icon: '🏥',
    title: 'Болница и парк',
    why: 'Здравите и доволни хора остават – а болницата е нужна, за да станат блоковете ниво 3.',
    done: (c) => svc(c, 'clinic') >= 1 && svc(c, 'park') >= 1,
    tool: { kind: 'service', service: 'clinic' },
    button: 'Болница',
  },
  {
    id: 'utilities',
    icon: '♻',
    title: 'Пречиствателна и сметище',
    why: 'Над няколко хиляди жители канализацията и боклукът преливат – сигналите се трупат и сградите не се надграждат.',
    done: (c) => svc(c, 'sewage_plant') >= 1 && svc(c, 'landfill') >= 1,
    tool: { kind: 'service', service: 'sewage_plant' },
    button: 'Пречиствателна',
  },
  {
    id: 'offices',
    icon: '🏢',
    title: 'Офиси',
    why: 'Офисите плащат най-високите заплати (и данъци). Искат образовани хора, полиция и тротоари.',
    done: (c) => built(c, 'O') >= 2,
    progress: (c) => ({ v: Math.min(1, built(c, 'O') / 2), label: `${built(c, 'O')} / 2 построени офиса` }),
    tool: { kind: 'zone', zone: 'O' },
    button: 'Офисна зона',
  },
  {
    id: 'transit',
    icon: '🚌',
    title: 'Автобуси',
    why: 'Депо и спирки разтоварват задръстванията – хората стигат по-бързо до работа.',
    done: (c) => svc(c, 'bus_depot') >= 1 && count(c, (t) => t.t === 'road' && !!t.st) >= 2,
    tool: { kind: 'service', service: 'bus_depot' },
    button: 'Автобусно депо',
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
  },
  {
    id: 'company',
    icon: '🏭',
    title: 'Собствена компания',
    why: 'С личния капитал основете компания (панел „Бизнес“) – ферма, мина или завод носят печалба и работа за града.',
    done: (_c, ctx) => ctx.companies > 0,
    run: () => setState({ panel: 'companies', panelOpen: true }),
    button: 'Към „Бизнес“',
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
