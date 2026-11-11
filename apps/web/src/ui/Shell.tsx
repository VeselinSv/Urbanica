import { useEffect, useState } from 'react';
import {
  BALANCE,
  FACILITIES,
  FACILITY_TYPES,
  ISSUE_TYPES,
  SERVICES,
  SERVICE_TYPES,
  UPGRADE_REQUIREMENT_LABELS,
  ZONES,
  ZONE_TYPES,
  type ServiceType,
  type TileMap,
  type UpgradeRequirement,
  type ZoneType,
} from '@gce/shared';
import { MapView, undoLast } from '../map/MapView';
import { Tutorial } from './Tutorial';
import { getState, setState, useStore, type Layer, type Tool } from '../store';
import { dateLabel, money, num, pct } from '../format';
import { Panels, PANEL_GROUPS, groupOf } from './panels/Panels';
import { IssueCard, initials } from './panels/IssuesPanel';
import { BRAND, BrandLockup } from './Brand';
import { REQ_ICON, needsLine, reqTool, reqToolLabel, toolNeeds } from './needs';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

// ------------------------------------------------------------------ пулс на града (горна лента)
function mood(h: number) {
  return h >= 0.75 ? '😄' : h >= 0.6 ? '🙂' : h >= 0.45 ? '😐' : h >= 0.3 ? '🙁' : '😠';
}

function Gauge({ value, color }: { value: number; color: string }) {
  return (
    <span className="gauge" aria-hidden>
      <i style={{ width: `${Math.max(4, Math.min(100, value * 100))}%`, background: color }} />
    </span>
  );
}

function TopBar() {
  const me = useStore((s) => s.me);
  const city = useStore((s) => s.city);
  const tick = useStore((s) => s.tick);
  const cities = useStore((s) => s.cities);
  const activeCityId = useStore((s) => s.activeCityId);
  const issues = useStore((s) => s.issues);
  const s = city?.stats;
  const openIssues = issues.filter((i) => i.status === 'OPEN').length;
  const powerR = s?.power ? (s.power.demand > 0 ? s.power.supply / s.power.demand : 1) : 0;
  const waterR = s?.water ? (s.water.demand > 0 ? s.water.supply / s.water.demand : 1) : 0;
  return (
    <header className="topbar glass">
      <div className="brand" title={`${BRAND.name} – игра на ${BRAND.author}`}>
        <BrandLockup size={38} author />
      </div>
      <select
        className="city-select"
        aria-label="Активен град"
        value={activeCityId ?? ''}
        onChange={(e) => {
          const c = cities.find((x) => x.id === e.target.value);
          setState({ activeCityId: e.target.value, city: null, focus: c ? { x: c.originX, y: c.originY, n: Date.now() } : null });
          void import('../store').then((m) => m.refreshCity());
        }}
      >
        {cities.length === 0 && <option value="">— няма град —</option>}
        {cities.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="kpis">
        <span className="pill" title="Бюджет на града и нетен резултат на ден">
          <em>Бюджет</em>
          <b className={(city?.treasury ?? 0) < 0 ? 'bad' : ''}>{money(city?.treasury)}</b>
          <small className={(s?.net ?? 0) >= 0 ? 'good' : 'bad'}>
            {(s?.net ?? 0) >= 0 ? '▲' : '▼'} {money(Math.abs(s?.net ?? 0))}/ден
          </small>
        </span>
        <span className="pill" title="Население">
          <em>Жители</em>
          <b>{num(s?.population ?? 0)}</b>
          <small>{pct(1 - (s?.unemploymentRate ?? 0), 0)} заети</small>
        </span>
        <span className="pill mood" title="Удовлетвореност на гражданите">
          <span className="emoji">{mood(s?.happiness ?? 0.5)}</span>
          <span>
            <em>Настроение</em>
            <b>{pct(s?.happiness ?? 0, 0)}</b>
          </span>
        </span>
        <span className="pill" title="Ток: произведен / нужен">
          <em>⚡ Ток</em>
          <Gauge value={powerR} color={powerR >= 1 ? '#facc15' : '#ef4444'} />
        </span>
        <span className="pill" title="Вода: подадена / нужна">
          <em>💧 Вода</em>
          <Gauge value={waterR} color={waterR >= 1 ? '#38bdf8' : '#ef4444'} />
        </span>
        <span className="pill rci-pill" title="Търсене: жилища / търговия / индустрия">
          <em>Търсене</em>
          <span className="rci">
            {(['R', 'C', 'I'] as ZoneType[]).map((z) => (
              <i key={z} style={{ background: hex(ZONES[z].color), height: `${Math.max(3, ((s?.demand?.[z] ?? 0) + 1) * 10)}px` }} />
            ))}
          </span>
        </span>
        <span className="pill" title="Игрово време">
          <em>Дата</em>
          <b>{dateLabel(tick)}</b>
        </span>
      </div>
      <button
        className={`bell ${openIssues ? 'ring' : ''}`}
        onClick={() => setState({ panel: 'issues', panelOpen: true })}
        title="Сигнали от гражданите"
        aria-label={`Сигнали от гражданите: ${openIssues}`}
      >
        🚨{openIssues > 0 && <em>{openIssues}</em>}
      </button>
      <div className="user">
        <span className="wallet" title="Личен портфейл">
          👛 {money(me?.wallet)}
        </span>
        <span className="avatar" title={me?.user.username}>
          {initials(me?.user.username ?? '?')}
        </span>
        <span className="player-name">{me?.user.username}</span>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ инструменти (док)
const LAYERS: { id: Layer; label: string; icon: string }[] = [
  { id: 'none', label: 'Нормален изглед', icon: '🌍' },
  { id: 'zoning', label: 'Зониране', icon: '▦' },
  { id: 'ownership', label: 'Собственост', icon: '🗺' },
  { id: 'resources', label: 'Ресурси', icon: '⛏' },
  { id: 'landValue', label: 'Стойност на земята', icon: '💎' },
  { id: 'traffic', label: 'Трафик', icon: '🚦' },
  { id: 'power', label: 'Електричество', icon: '⚡' },
  { id: 'water', label: 'Вода', icon: '💧' },
  { id: 'pollution', label: 'Замърсяване', icon: '🏭' },
  { id: 'activity', label: 'Икон. активност', icon: '📈' },
];

const ROAD_TOOLS = [
  { cls: 'street', label: 'Улица', hint: 'евтина, за кварталите', icon: '🛣' },
  { cls: 'avenue', label: 'Булевард', hint: '4 ленти, 2.4× капацитет', icon: '🛤' },
  { cls: 'highway', label: 'Градска магистрала', hint: '4× капацитет, скъпа', icon: '🚀' },
  { cls: 'industrial', label: 'Индустриален път', hint: 'за заводи и складове', icon: '🚚' },
  { cls: 'rural', label: 'Селски път', hint: 'най-евтин, малък капацитет', icon: '🌾' },
] as const;

const ZONE_ICON: Record<ZoneType, string> = { R: '🏠', C: '🛍', I: '🏭', O: '🏢', A: '🌾', L: '📦', H: '🔬' };
const ZONE_HINT: Record<ZoneType, string> = {
  R: 'къщи и блокове – жители',
  C: 'магазини – работа и данъци',
  I: 'фабрики – много работа, замърсяване',
  O: 'офиси – за образовани',
  A: 'ферми – храна',
  L: 'складове – логистика',
  H: 'технологии – нужен университет',
};
const SERVICE_ICON: Record<ServiceType, string> = {
  power_coal: '🏭',
  power_wind: '🌬',
  water_pump: '💧',
  sewage_plant: '🚰',
  landfill: '🗑',
  school: '🏫',
  university: '🎓',
  clinic: '🏥',
  fire_station: '🚒',
  police_station: '🚓',
  bus_depot: '🚌',
  park: '🌳',
  parking: '🅿',
};

type Group = 'roads' | 'zones' | 'services' | 'facilities' | 'layers' | null;

function Flyout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flyout glass" role="menu">
      <div className="flyout-title">{title}</div>
      <div className="flyout-grid">{children}</div>
    </div>
  );
}

function ToolCard({
  icon,
  label,
  hint,
  price,
  color,
  needs,
  onClick,
}: {
  icon: string;
  label: string;
  hint?: string;
  price?: string;
  color?: string;
  needs?: string;
  onClick: () => void;
}) {
  return (
    <button className="tool-card" onClick={onClick} role="menuitem">
      <span className="tc-icon" style={color ? { boxShadow: `inset 0 -3px 0 ${color}` } : undefined}>
        {icon}
      </span>
      <span className="tc-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
        {needs && <small className="tc-needs">{needs}</small>}
      </span>
      {price && <span className="tc-price">{price}</span>}
    </button>
  );
}

function Toolbar() {
  const tool = useStore((s) => s.tool);
  const layer = useStore((s) => s.layer);
  const [group, setGroup] = useState<Group>(null);
  const is = (t: Tool) => JSON.stringify(t) === JSON.stringify(tool);
  const pick = (t: Tool) => {
    setState({ tool: t });
    setGroup(null);
  };
  const toggle = (g: Group) => setGroup(group === g ? null : g);
  const DockBtn = ({ active, icon, label, onClick, hint }: { active: boolean; icon: string; label: string; onClick: () => void; hint: string }) => (
    <button className={`dock-btn ${active ? 'active' : ''}`} onClick={onClick} title={hint} aria-pressed={active}>
      <span className="ico">{icon}</span>
      <span>{label}</span>
    </button>
  );
  return (
    <nav className="toolbar dock glass" aria-label="Инструменти">
      <DockBtn active={is({ kind: 'select' })} icon="👆" label="Избор" hint="Избор, информация и придвижване" onClick={() => pick({ kind: 'select' })} />
      <div className="tool-group">
        <DockBtn
          active={tool.kind === 'road' || tool.kind === 'junction' || tool.kind === 'sidewalk' || tool.kind === 'busstop'}
          icon="🛣"
          label="Пътища"
          hint="Пътища, тротоари и кръстовища"
          onClick={() => toggle('roads')}
        />
        {group === 'roads' && (
          <Flyout title="Пътища – влачете по картата">
            {ROAD_TOOLS.map((r) => (
              <ToolCard
                key={r.cls}
                icon={r.icon}
                label={r.label}
                hint={r.hint}
                price={`${money(Math.round(BALANCE.construction.roadCost * BALANCE.construction.roadClasses[r.cls].cost))}`}
                onClick={() => pick({ kind: 'road', cls: r.cls })}
              />
            ))}
            <ToolCard
              icon="⟳"
              label="Кръгово движение"
              hint="на кръстовище с 3+ пътя"
              price={money(BALANCE.construction.junctions.roundabout.cost)}
              onClick={() => pick({ kind: 'junction', control: 'roundabout' })}
            />
            <ToolCard
              icon="🚦"
              label="Светофари"
              hint="по-добър поток"
              price={money(BALANCE.construction.junctions.signals.cost)}
              onClick={() => pick({ kind: 'junction', control: 'signals' })}
            />
            <ToolCard icon="✖" label="Обикновено кръстовище" hint="премахва управлението" onClick={() => pick({ kind: 'junction', control: 'none' })} />
            <ToolCard
              icon="🚶"
              label="Тротоар / алея"
              hint="върху път – тротоари; на празна земя – пешеходна алея"
              needs="нужно за блокове и магазини ниво 2+"
              price={`${money(BALANCE.construction.sidewalkCost)}–${money(BALANCE.construction.pathCost)}`}
              onClick={() => pick({ kind: 'sidewalk' })}
            />
            <ToolCard icon="✂" label="Махни тротоар" hint="тротоарите от пътя или алеята" onClick={() => pick({ kind: 'sidewalk', remove: true })} />
            <ToolCard
              icon="🚏"
              label="Автобусна спирка"
              hint="автобусите обикалят всички спирки"
              needs="нужно: 🚌 автобусно депо"
              price={money(BALANCE.construction.busStopCost)}
              onClick={() => pick({ kind: 'busstop' })}
            />
            <ToolCard icon="✂" label="Махни спирка" hint="щракнете върху спирка" onClick={() => pick({ kind: 'busstop', remove: true })} />
          </Flyout>
        )}
      </div>
      <div className="tool-group">
        <DockBtn
          active={tool.kind === 'zone' || tool.kind === 'dezone'}
          icon="🏘"
          label="Зони"
          hint="Зониране – сградите се строят сами"
          onClick={() => toggle('zones')}
        />
        {group === 'zones' && (
          <Flyout title="Зони – оградете правоъгълник до път">
            {ZONE_TYPES.map((z) => (
              <ToolCard
                key={z}
                icon={ZONE_ICON[z]}
                label={ZONES[z].name}
                hint={ZONE_HINT[z]}
                color={hex(ZONES[z].color)}
                needs={needsLine({ kind: 'zone', zone: z })}
                price={`${money(ZONES[z].zoningCost)}`}
                onClick={() => pick({ kind: 'zone', zone: z })}
              />
            ))}
            <ToolCard icon="✖" label="Премахни зона" hint="само празни зони" onClick={() => pick({ kind: 'dezone' })} />
          </Flyout>
        )}
      </div>
      <div className="tool-group">
        <DockBtn active={tool.kind === 'service'} icon="🏛" label="Услуги" hint="Ток, вода, училища, болници…" onClick={() => toggle('services')} />
        {group === 'services' && (
          <Flyout title="Обществени сгради – щракнете върху плочка">
            {SERVICE_TYPES.map((sv) => (
              <ToolCard
                key={sv}
                icon={SERVICE_ICON[sv]}
                label={SERVICES[sv].name}
                hint={SERVICES[sv].radius ? `обхват ${SERVICES[sv].radius} плочки` : undefined}
                needs={needsLine({ kind: 'service', service: sv })}
                price={money(SERVICES[sv].cost)}
                onClick={() => pick({ kind: 'service', service: sv })}
              />
            ))}
          </Flyout>
        )}
      </div>
      <div className="tool-group">
        <DockBtn active={tool.kind === 'facility'} icon="🏭" label="Индустрия" hint="Предприятия на вашата компания" onClick={() => toggle('facilities')} />
        {group === 'facilities' && (
          <Flyout title="Предприятия на компанията">
            {FACILITY_TYPES.map((f) => (
              <ToolCard
                key={f}
                icon="⚙"
                label={FACILITIES[f].name}
                color={hex(FACILITIES[f].color)}
                price={money(FACILITIES[f].cost)}
                onClick={() => pick({ kind: 'facility', facility: f })}
              />
            ))}
          </Flyout>
        )}
      </div>
      <DockBtn active={is({ kind: 'bulldoze' })} icon="🧨" label="Събори" hint="Събаряне" onClick={() => pick({ kind: 'bulldoze' })} />
      <DockBtn active={is({ kind: 'parcel' })} icon="🗺" label="Земя" hint="Купуване на съседен парцел" onClick={() => pick({ kind: 'parcel' })} />
      <div className="tool-group">
        <DockBtn
          active={layer !== 'none'}
          icon={LAYERS.find((l) => l.id === layer)?.icon ?? '🌍'}
          label="Слоеве"
          hint="Аналитични слоеве на картата"
          onClick={() => toggle('layers')}
        />
        {group === 'layers' && (
          <Flyout title="Изглед на картата">
            {LAYERS.map((l) => (
              <ToolCard
                key={l.id}
                icon={l.icon}
                label={l.label}
                onClick={() => {
                  setState({ layer: l.id });
                  setGroup(null);
                }}
              />
            ))}
          </Flyout>
        )}
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ съветник „следваща стъпка“
interface Advice {
  icon: string;
  text: string;
  action?: { label: string; run: () => void };
}

function advice(): Advice | null {
  const st = getState();
  const city = st.city;
  if (!st.cities.length)
    return {
      icon: '🌱',
      text: 'Добре дошли, кмете! Изберете на картата на България къде да бъде вашият град – получавате земя и стартов капитал.',
      action: { label: 'Избери място', run: () => setState({ tool: { kind: 'found', name: '' } }) },
    };
  if (!city || !city.isOwner) return null;
  const tiles = city.tiles as TileMap;
  const vals = Object.values(tiles);
  const has = (f: (t: TileMap[string]) => boolean) => vals.some(f);
  if (!has((t) => t.t === 'road'))
    return {
      icon: '🛣',
      text: 'Започнете с път – всичко в града се строи до пътища.',
      action: { label: 'Строй път', run: () => setState({ tool: { kind: 'road', cls: 'street' } }) },
    };
  if (!has((t) => t.t === 'zone' && t.z === 'R'))
    return {
      icon: '🏠',
      text: 'Зонирайте жилища до пътя – хората ще дойдат сами.',
      action: { label: 'Жилищна зона', run: () => setState({ tool: { kind: 'zone', zone: 'R' } }) },
    };
  if (!has((t) => t.t === 'service' && (t.s === 'power_coal' || t.s === 'power_wind')))
    return {
      icon: '⚡',
      text: 'Без ток сградите не растат. Постройте централа.',
      action: { label: 'Централа', run: () => setState({ tool: { kind: 'service', service: 'power_wind' } }) },
    };
  if (!has((t) => t.t === 'service' && t.s === 'water_pump'))
    return {
      icon: '💧',
      text: 'Нужна е вода – помпена станция до река или езеро.',
      action: { label: 'Помпа', run: () => setState({ tool: { kind: 'service', service: 'water_pump' } }) },
    };
  const open = st.issues.filter((i) => i.status === 'OPEN');
  const critical = open.find((i) => i.severity >= 2);
  if (critical)
    return {
      icon: ISSUE_TYPES[critical.kind]?.icon ?? '🚨',
      text: `${critical.reporter}: „${critical.message}“`,
      action: {
        label: 'Към сигнала',
        run: () => setState({ panel: 'issues', panelOpen: true, selectedIssue: critical.id, focus: { x: critical.x, y: critical.y, n: Date.now() } }),
      },
    };
  // празни зони, които не се застрояват – обяснява защо
  const waitingZones = vals.filter((t) => t.t === 'zone' && t.lvl === 0 && t.prog === 0 && !t.ab).length;
  if (waitingZones >= 4 && (city.stats?.power?.supply ?? 1) <= 0)
    return {
      icon: '⚡',
      text: `${waitingZones} празни парцела чакат ток – без ток не се строи.`,
      action: { label: 'Централа', run: () => setState({ tool: { kind: 'service', service: 'power_wind' } }) },
    };
  if (waitingZones >= 4 && (city.stats?.water?.supply ?? 1) <= 0)
    return {
      icon: '💧',
      text: `${waitingZones} празни парцела чакат вода – постройте помпена станция.`,
      action: { label: 'Помпа', run: () => setState({ tool: { kind: 'service', service: 'water_pump' } }) },
    };
  const blockers = Object.entries(city.stats?.upgradeBlockers ?? {})
    .filter(([k]) => !['occupancy', 'demand', 'land_value'].includes(k))
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (blockers.length) {
    const [k, n] = blockers[0];
    const req = k as UpgradeRequirement;
    const fix = reqTool(req);
    return {
      icon: REQ_ICON[req] ?? '⬆',
      text: `${n} сгради не могат да се надградят: липсва „${UPGRADE_REQUIREMENT_LABELS[req]}“.`,
      action: fix ? { label: reqToolLabel(req), run: () => setState({ tool: fix }) } : undefined,
    };
  }
  if (open.length)
    return {
      icon: '🚨',
      text: `${open.length} нерешени сигнала от граждани.`,
      action: { label: 'Виж', run: () => setState({ panel: 'issues', panelOpen: true }) },
    };
  return { icon: '✨', text: 'Градът работи добре. Разширете го с нова земя или основете компания.' };
}

function Advisor() {
  useStore((s) => s.city);
  useStore((s) => s.issues);
  useStore((s) => s.cities);
  const [hidden, setHidden] = useState(false);
  const a = advice();
  if (!a || hidden) return null;
  return (
    <div className="advisor glass" role="status">
      <span className="adv-icon">{a.icon}</span>
      <span className="adv-text">
        <em>Следваща стъпка</em>
        {a.text}
      </span>
      {a.action && (
        <button className="btn primary small" onClick={a.action.run}>
          {a.action.label}
        </button>
      )}
      <button className="adv-close" onClick={() => setHidden(true)} aria-label="Скрий съвета">
        ×
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ „гласът на града“
function CityVoice() {
  const issues = useStore((s) => s.issues);
  const city = useStore((s) => s.city);
  const [open, setOpen] = useState(true);
  if (!city?.isOwner) return null;
  const list = issues.filter((i) => i.status === 'OPEN').slice(0, 3);
  return (
    <section className={`voice glass ${open ? '' : 'collapsed'}`} aria-label="Гласът на града">
      <header onClick={() => setOpen(!open)}>
        <span>🗣 Гласът на града</span>
        <b>{issues.filter((i) => i.status === 'OPEN').length || '✓'}</b>
      </header>
      {open &&
        (list.length ? (
          list.map((i) => <IssueCard key={i.id} issue={i} />)
        ) : (
          <p className="small muted voice-calm">Всичко е спокойно – няма нови сигнали от гражданите.</p>
        ))}
    </section>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const TOOL_HINTS: Record<string, string> = {
  select: 'Щракнете върху сграда или сигнал за информация · влачете за придвижване · колелцето – мащаб',
  road: 'Влачете от точка до точка, за да построите път (Г-образно) · пътищата свързват всичко',
  junction: 'Щракнете върху кръстовище с поне 3 пътя',
  zone: 'Оградете правоъгълник до път – сградите се строят сами, ако има ток и вода',
  dezone: 'Оградете празни зони, които да премахнете',
  service: 'Щракнете върху свободна плочка до път',
  facility: 'Щракнете върху подходяща плочка (ферма – плодородна земя, мина – находище)',
  bulldoze: 'Оградете какво да бъде съборено',
  parcel: 'Щракнете върху парцел до територията си, за да го купите',
  sidewalk: 'Влачете по път, за да добавите тротоари, или по празна земя за пешеходна алея',
  busstop: 'Щракнете върху улица (не кръстовище), за да поставите спирка',
};

/** Лента с подсказка за активния инструмент – какво се прави и как се отказва (Esc). */
function ToolHint() {
  const tool = useStore((s) => s.tool);
  const city = useStore((s) => s.city);
  if (tool.kind === 'select') return null;
  const info = toolNeeds(tool, city?.isOwner ? city : null);
  const cancel = () => setState({ tool: { kind: 'select' } });
  return (
    <div className="tool-hint glass" role="status">
      {tool.kind === 'found' ? (
        <>
          <span className="th-icon">📍</span>
          <span className="th-text">
            <b>Нов град:</b> напишете име и щракнете върху картата на България. Зеленото поле показва подходящо място.
          </span>
          <input
            autoFocus
            className="th-input"
            placeholder="Име на града"
            maxLength={40}
            value={tool.name}
            onChange={(e) => setState({ tool: { kind: 'found', name: e.target.value } })}
            aria-label="Име на новия град"
          />
        </>
      ) : (
        <>
          <span className="th-icon">💡</span>
          <span className="th-text">
            {tool.kind === 'sidewalk' && tool.remove ? 'Влачете по пътища или алеи, от които да махнете тротоарите' : (TOOL_HINTS[tool.kind] ?? '')}
            {(info.needs.length > 0 || info.unlocks) && (
              <span className="th-needs">
                {info.needs.map((n) => (
                  <span key={n.label} className={`need ${n.ok === true ? 'ok' : n.ok === false ? 'miss' : ''}`}>
                    {n.ok === true ? '✔' : n.ok === false ? '✖' : '•'} {n.label}
                    {n.ok === false && n.fix && (
                      <button className="need-fix" onClick={() => setState({ tool: n.fix! })}>
                        {n.fixLabel ?? 'Строй'}
                      </button>
                    )}
                  </span>
                ))}
                {info.unlocks && <span className="need unlock">{info.unlocks}</span>}
              </span>
            )}
          </span>
        </>
      )}
      <button className="btn small ghost" onClick={cancel} title="Отказ (Esc)">
        ✕ Отказ <kbd>Esc</kbd>
      </button>
    </div>
  );
}

export function Shell() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState({ tool: { kind: 'select' } });
      const typing = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        void undoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const panel = useStore((s) => s.panel);
  const open = useStore((s) => s.panelOpen);
  const unread = useStore((s) => s.unread);
  const issues = useStore((s) => s.issues);
  const openIssues = issues.filter((i) => i.status === 'OPEN').length;
  return (
    <div className="shell">
      <div className="main">
        <MapView />
        <TopBar />
        <Toolbar />
        <Advisor />
        <CityVoice />
        <ToolHint />
        <Tutorial />
        <aside className={`side glass ${open ? 'open' : 'closed'}`} aria-label="Управленски панели">
          <div className="side-tabs" role="tablist">
            {PANEL_GROUPS.map((g) => {
              const active = groupOf(panel).id === g.id;
              return (
                <button
                  key={g.id}
                  role="tab"
                  aria-selected={active}
                  className={active ? 'active' : ''}
                  onClick={() =>
                    setState({ panel: active ? panel : g.tabs[0], panelOpen: active ? !open : true, ...(g.id === 'g-events' ? { unread: 0 } : {}) })
                  }
                  title={g.label}
                >
                  <span className="ico">{g.icon}</span>
                  <span className="lbl">{g.label}</span>
                  {g.id === 'g-events' && unread > 0 && <em className="badge">{unread}</em>}
                  {g.id === 'g-issues' && openIssues > 0 && <em className="badge">{openIssues}</em>}
                </button>
              );
            })}
          </div>
          <div className="side-body">
            <button className="side-toggle" onClick={() => setState({ panelOpen: !open })} aria-label="Покажи/скрий панела">
              {open ? '▾' : '▴'}
            </button>
            <Panels />
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  );
}
