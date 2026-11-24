import { useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart } from 'recharts';
import {
  BALANCE,
  COMPANY_POLICY_LIMITS,
  FACILITIES,
  FACILITY_TYPES,
  GOODS,
  GOOD_IDS,
  TECHS,
  companyPolicyEffects,
  type CompanyPolicy,
  type FacilityType,
  type GoodId,
} from '@gce/shared';
import { del, patch, post } from '../../api';
import { bumpData, errorToast, refreshAll, refreshCompanies, setState, toast, useStore } from '../../store';
import { KIND_LABELS, RATING_COLOR, money, num, pct, toCents } from '../../format';
import { AsyncButton, FeatureGuide, Field, Meter, Section, Stat, Table, useApi } from '../common';

interface CompanyFull {
  id: string;
  name: string;
  status: string;
  rating: string;
  hqCityId: string;
  totalShares: number;
  cash?: number;
  insider?: boolean;
  myRoles: string[];
  valuation: { assets: number; debt: number; equity: number; bookPerShare: number; lastSharePrice: number | null };
  facilitiesDetail?: {
    id: string;
    type: string;
    cityId: string;
    x: number;
    y: number;
    staffing: number;
    power: number;
    lastRuns: number;
    lastEnergy: number;
    limitedBy: string;
    condition: number;
    upgrades: number;
  }[];
  inventory?: { cityId: string; good: string; quantity: number; reserved: number; avgCost: number }[];
  research?: { id: string; techId: string; progress: number; requiredDays: number; status: string }[];
  shipments?: { id: string; good: string; quantity: number; toCityId: string; arriveTick: number }[];
  stats?: { tick: number; revenue: number; costs: number; profit: number; cash: number }[];
  publicReport: { revenue: number; costs: number; profit: number; days: number };
  policy?: CompanyPolicy;
  orders?: { side: string; instrument: string }[];
  advice?: { level: 1 | 2 | 3; text: string }[];
}

/** Етапи на развитие по активите на компанията (пари + съоръжения + стоки), в евро. */
const STAGES = [
  { name: 'Стартъп', min: 0 },
  { name: 'Малък бизнес', min: 2_000_000 },
  { name: 'Средно предприятие', min: 10_000_000 },
  { name: 'Голяма компания', min: 50_000_000 },
  { name: 'Корпорация', min: 250_000_000 },
];

/** Следващата стъпка във веригата: какво да построи компанията от това, което вече произвежда. */
function nextStep(types: string[]): string {
  if (!types.length) return 'Постройте първото съоръжение („Индустрия“): ферма на плодородна земя, мина върху находище или дъскорезница в гора – точно до път.';
  const made = new Set<string>();
  for (const t of types) for (const g of Object.keys(FACILITIES[t as FacilityType]?.recipe?.outputs ?? {})) made.add(g);
  for (const f of FACILITY_TYPES) {
    if (types.includes(f)) continue;
    const ins = Object.keys(FACILITIES[f].recipe?.inputs ?? {});
    if (ins.length && ins.every((g) => made.has(g)))
      return `Преработвайте собствената си продукция: „${FACILITIES[f].name}“ ползва ${ins.map((g) => GOODS[g as GoodId].name.toLowerCase()).join(' и ')}, която вече произвеждате – готовата стока струва повече.`;
  }
  if (types.length < 3) return 'Постройте още едно съоръжение от същия вид или модернизирайте (машини) съществуващото – повече продукция при същите разходи за склад.';
  return 'Изследвайте технологии („Технологии“) за по-висока производителност и по-малко замърсяване; помислете за договори с постоянни купувачи.';
}

/** Развитие на компанията: етап, напредък към следващия, пари и печалба във времето, следваща стъпка. */
function CompanyGrowth({ d }: { d: CompanyFull }) {
  const assets = d.valuation.assets / 100;
  const i = STAGES.reduce((a, s, k) => (assets >= s.min ? k : a), 0);
  const cur = STAGES[i];
  const next = STAGES[i + 1];
  const progress = next ? (assets - cur.min) / (next.min - cur.min) : 1;
  const series = (d.stats ?? []).slice(-60).map((s) => ({ tick: s.tick, cash: s.cash / 100, profit: s.profit / 100 }));
  const week = (d.stats ?? []).slice(-7);
  const avg = week.length ? week.reduce((a, s) => a + s.profit, 0) / week.length : 0;
  return (
    <Section title="Развитие на компанията">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>
          {i + 1}/{STAGES.length} · {cur.name}
        </b>
        <span className={avg >= 0 ? 'good small' : 'bad small'}>{avg >= 0 ? '▲' : '▼'} {money(Math.round(avg))}/ден (7 дни)</span>
      </div>
      {next ? (
        <Meter label={`Към „${next.name}“ (активи ${money(next.min * 100)})`} value={Math.max(0, Math.min(1, progress))} text={`${money(d.valuation.assets)}`} />
      ) : (
        <p className="small good">Най-високият етап.</p>
      )}
      {series.length > 1 && (
        <div className="chart">
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="tick" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
              <Line dataKey="cash" name="Пари" stroke="#38bdf8" dot={false} />
              <Line dataKey="profit" name="Печалба/ден" stroke="#22c55e" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="small">
        <b>Следваща стъпка:</b> {nextStep((d.facilitiesDetail ?? []).map((f) => f.type))}
      </p>
      <p className="small muted">
        Как печели компанията: съоръженията произвеждат всеки ден; продукцията се продава на борсата (автоматично или ръчно) – на жителите (храна, стоки), на
        други играчи и на световния пазар (до {pct(BALANCE.market.exportFloor, 0)} от пазарната цена). Разходите са заплати, поддръжка, ток и вода, такси
        за замърсяване и ресурси. Печалбата се трупа като пари; от тях строите нови съоръжения и растете.
      </p>
    </Section>
  );
}

/** Средни заплати на ден за последните дни (за прогнозата на решенията). */
function wagesPerDay(d: CompanyFull): number {
  const s = (d.stats ?? []).slice(-7) as unknown as { costs: number }[];
  return s.length ? s.reduce((a, x) => a + (x.costs ?? 0), 0) / s.length : 0;
}

/**
 * Решенията на ръководството – заплати, поддръжка, автоматични продажби. Записват се автоматично;
 * до всеки плъзгач е обяснено какво ще стане (по същите формули като в симулацията).
 */
function CompanyDecisions({ companyId, policy, wagesPerDay: costs, onSaved }: { companyId: string; policy: CompanyPolicy; wagesPerDay: number; onSaved: () => void }) {
  const [p, setP] = useState<CompanyPolicy>(policy);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setStateS] = useState<'idle' | 'pending' | 'saving'>('idle');
  useEffect(() => {
    if (!dirty.current) setP(policy);
  }, [policy]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const edit = (next: CompanyPolicy) => {
    dirty.current = true;
    setP(next);
    setStateS('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStateS('saving');
      try {
        await patch(`/companies/${companyId}/policy`, next);
        onSaved();
      } catch (e) {
        errorToast(e);
        setP(policy);
      }
      dirty.current = false;
      setStateS('idle');
    }, 700);
  };
  const fx = companyPolicyEffects(p);
  const L = COMPANY_POLICY_LIMITS;
  return (
    <Section title="Решения на ръководството">
      <p className="small muted">От тях зависи дали компанията ще потръгне. Промените важат от следващия игрови ден.</p>
      <Field label={`Заплати: ${pct(p.wageLevel, 0)} от пазарните`}>
        <input type="range" min={L.wageLevel[0]} max={L.wageLevel[1]} step={0.05} value={p.wageLevel} onChange={(e) => edit({ ...p, wageLevel: Number(e.target.value) })} />
      </Field>
      <p className="small decision-fx">
        {p.wageLevel < 1 ? (
          <span className="bad">
            Хората напускат: персонал до {pct(fx.staffMult, 0)} → по-малко продукция, но по-евтини заплати.
          </span>
        ) : p.wageLevel > 1 ? (
          <span className="good">
            Мотивирани служители: +{pct(fx.productivity - 1, 0)} продукция; заплатите струват {pct(p.wageLevel - 1, 0)} повече.
          </span>
        ) : (
          <span className="muted">Пазарни заплати – нормален персонал и продуктивност.</span>
        )}
      </p>
      <Field label={`Поддръжка: ${pct(p.maintenance, 0)} от нормалния бюджет`}>
        <input type="range" min={L.maintenance[0]} max={L.maintenance[1]} step={0.1} value={p.maintenance} onChange={(e) => edit({ ...p, maintenance: Number(e.target.value) })} />
      </Field>
      <p className="small decision-fx">
        {fx.wear > 0 ? (
          <span className={p.maintenance < 1 ? 'bad' : 'muted'}>
            Съоръженията се износват с {(fx.wear * 100).toFixed(2)}% на ден ({Math.round(0.3 / fx.wear)} дни до 70%) – износените произвеждат по-малко.
          </span>
        ) : (
          <span className="good">Съоръженията се ремонтират с {(-fx.wear * 100).toFixed(2)}% на ден; поддръжката струва {pct(p.maintenance - 1, 0)} повече.</span>
        )}
      </p>
      <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={p.autoSell} onChange={(e) => edit({ ...p, autoSell: e.target.checked })} />
        <b>Автоматично продавай продукцията</b>
      </label>
      {p.autoSell ? (
        <>
          <Field label={`Цена: ${pct(p.sellPrice, 0)} от пазарната`}>
            <input type="range" min={L.sellPrice[0]} max={L.sellPrice[1]} step={0.05} value={p.sellPrice} onChange={(e) => edit({ ...p, sellPrice: Number(e.target.value) })} />
          </Field>
          <p className="small decision-fx">
            {p.sellPrice <= BALANCE.market.exportFloor ? (
              <span className="good">
                До {pct(BALANCE.market.exportFloor, 0)} – световният пазар изкупува всеки ден (износ), така че и суровините (зърно, дърва, руда, въглища) се
                продават сигурно.
              </span>
            ) : p.sellPrice > 1.1 ? (
              <span className="bad">Скъпо – повече пари на брой, но стоката може да остане в склада (жителите купуват до {pct(BALANCE.market.retailMaxPremium, 0)}).</span>
            ) : (
              <span className="muted">
                Над {pct(BALANCE.market.exportFloor, 0)} купуват само жителите (храна, стоки) и други играчи – суровините може да останат в склада.
              </span>
            )}{' '}
            Суровините за собствените ви съоръжения не се продават.
          </p>
          <Field label="Пази в склада (бр. от всяка стока)">
            <input type="number" min={0} step={10} value={p.keepStock} onChange={(e) => edit({ ...p, keepStock: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} style={{ width: 100 }} />
          </Field>
        </>
      ) : (
        <p className="small muted decision-fx">Продукцията остава в склада – продавате ръчно в „Пазар“ или чрез договори.</p>
      )}
      {costs > 0 && <p className="small muted">Разходи за последните дни: ≈ {money(costs)} на ден.</p>}
      <p className="small muted" aria-live="polite">
        {state === 'pending' ? '● промени – записват се…' : state === 'saving' ? 'записване…' : '✓ записано'}
      </p>
    </Section>
  );
}

const LIMITED: Record<string, string> = { none: 'пълен капацитет', staff: 'персонал', power: 'ток', inputs: 'суровини', storage: 'склад', idle: 'престой' };

function FoundCompany() {
  const city = useStore((s) => s.city);
  const me = useStore((s) => s.me);
  const [name, setName] = useState('');
  const [capital, setCapital] = useState('30000');
  return (
    <Section title="Основаване на компания">
      <p className="muted small">
        Капиталът се превежда от личния портфейл ({money(me?.wallet)}); получавате {num(BALANCE.company.defaultShares)} акции и ролите CEO и борд.
      </p>
      <div className="row wrap">
        <input placeholder="Име на компанията" value={name} onChange={(e) => setName(e.target.value)} aria-label="Име на компанията" />
        <input type="number" min={10000} value={capital} onChange={(e) => setCapital(e.target.value)} aria-label="Капитал в €" style={{ width: 110 }} />
        <AsyncButton
          className="btn primary"
          disabled={!city || name.trim().length < 2}
          onClick={async () => {
            const c = await post<{ id: string }>('/companies', { name: name.trim(), hqCityId: city!.id, capital: toCents(Number(capital)) }, true);
            await refreshCompanies();
            setState({ activeCompanyId: c.id });
            await refreshAll();
            toast('Компанията е основана. Изберете „Индустрия“ от инструментите, за да построите съоръжение.', 'success');
          }}
        >
          Основи
        </AsyncButton>
      </div>
    </Section>
  );
}

export function CompanyPanel() {
  const companies = useStore((s) => s.companies);
  const activeId = useStore((s) => s.activeCompanyId);
  const city = useStore((s) => s.city);
  const c = useApi<CompanyFull>(activeId ? `/companies/${activeId}` : null);
  const [invType, setInvType] = useState<FacilityType>('farm');
  const sim = useApi<{
    dailyRevenue: number;
    dailyInputs: number;
    dailyWages: number;
    dailyFees: number;
    dailyProfit: number;
    paybackDays: number | null;
    staffingAssumed: number;
  }>(city ? `/analytics/invest?cityId=${city.id}&type=${invType}` : null, [invType]);
  const d = c.data;
  return (
    <div>
      <h2>Компании и производство</h2>
      <FeatureGuide
        title="Компания – стъпка по стъпка"
        done="Компанията работи и печели. Растете: още съоръжения, преработка, модернизация, изследвания."
        steps={[
          {
            label: 'Основете компания',
            done: companies.some((x) => x.roles.length > 0),
            hint: 'дайте име и капитал от личния портфейл (долу в този панел). С тези пари строите съоръжения.',
          },
          {
            label: 'Постройте съоръжение',
            done: (d?.facilitiesDetail ?? []).length > 0,
            hint: 'изберете „Индустрия“ вляво и кликнете на плочка точно до път: ферма на плодородна земя, мина на находище, дъскорезница в гора.',
            action: { label: '🏭 Индустрия', run: () => setState({ tool: { kind: 'facility', facility: 'farm' } }) },
          },
          {
            label: 'Персонал и ток',
            done: (d?.facilitiesDetail ?? []).some((f) => f.staffing > 0.3 && f.power > 0.3),
            hint: 'съоръжението взема работници и ток от града – нужни са жилища (безработни) и централа. Изчакайте няколко дни.',
          },
          {
            label: 'Продавайте продукцията',
            done: !!d?.policy?.autoSell || (d?.orders ?? []).some((o) => o.side === 'SELL'),
            hint: 'включете „Автоматично продавай продукцията“ (до 92% от цената купува и световният пазар) или продайте ръчно в „Пазар“.',
          },
          {
            label: 'Първа печалба',
            done: (d?.stats ?? []).slice(-7).reduce((a, x) => a + x.profit, 0) > 0,
            hint: 'следете „Как върви компанията“ – там пише какво пречи (персонал, ток, суровини, склад, цена).',
          },
          {
            label: 'Второ съоръжение или преработка',
            done: (d?.facilitiesDetail ?? []).length >= 2,
            hint: 'преработката на собствената ви суровина (зърно → храна, руда + въглища → стомана) носи повече.',
            action: { label: '🏭 Индустрия', run: () => setState({ tool: { kind: 'facility', facility: 'food_plant' } }) },
          },
        ]}
      />
      {companies.length > 0 && (
        <Field label="Активна компания">
          <select value={activeId ?? ''} onChange={(e) => setState({ activeCompanyId: e.target.value })}>
            {companies.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} {x.roles.length ? `(${x.roles.join(', ')})` : '(акционер)'}
              </option>
            ))}
          </select>
        </Field>
      )}
      {d && (
        <>
          <div className="grid2">
            <Stat label="Парични средства" value={money(d.cash)} />
            <Stat label="Рейтинг" value={<span style={{ color: RATING_COLOR[d.rating] }}>{d.rating}</span>} />
            <Stat label="Активи" value={money(d.valuation.assets)} />
            <Stat label="Дълг" value={money(d.valuation.debt)} />
            <Stat label="Печалба (30 дни, паричен поток)" value={money(d.publicReport.profit)} tone={d.publicReport.profit < 0 ? 'bad' : 'good'} />
            <Stat label="Статус" value={d.status} />
          </div>
          <CompanyGrowth d={d} />
          {d.advice && d.advice.length > 0 && (
            <Section title="Как върви компанията">
              <ul className="needs-list">
                {d.advice.map((a, i) => (
                  <li key={i} className={`need-${a.level}`}>
                    <span className="need-icon">{a.level === 3 ? '⚠' : a.level === 2 ? '●' : '💡'}</span>
                    <span className="need-text">
                      <small style={{ color: 'var(--text)', fontSize: 12 }}>{a.text}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {d.policy && d.myRoles.some((r) => r === 'CEO' || r === 'MANAGER') && (
            <CompanyDecisions companyId={d.id} policy={d.policy} wagesPerDay={wagesPerDay(d)} onSaved={() => c.reload()} />
          )}
          <Section title="Съоръжения">
            <Table
              head={['Тип', 'Персонал', 'Ток', 'Произв.', 'Ограничение', 'Състояние']}
              rows={(d.facilitiesDetail ?? []).map((f) => [
                <button className="link" onClick={() => setState({ selected: { x: f.x, y: f.y }, panel: 'inspect', focus: { x: f.x, y: f.y, n: Date.now() } })}>
                  {FACILITIES[f.type as FacilityType].name}
                </button>,
                pct(f.staffing, 0),
                pct(f.power, 0),
                f.lastEnergy ? `${f.lastEnergy} енерг.` : f.lastRuns,
                LIMITED[f.limitedBy] ?? f.limitedBy,
                pct(f.condition, 0),
              ])}
              empty="Няма съоръжения – изберете „Индустрия“ в лентата с инструменти и кликнете върху плочка в града."
            />
          </Section>
          <Section title="Складови наличности">
            <Table
              head={['Стока', 'Свободни', 'Резервирани', 'Ср. себестойност']}
              rows={(d.inventory ?? [])
                .filter((i) => i.quantity + i.reserved > 0)
                .map((i) => [GOODS[i.good as GoodId]?.name ?? i.good, num(i.quantity), num(i.reserved), money(i.avgCost)])}
              empty="Складът е празен"
            />
            {(d.shipments ?? []).length > 0 && (
              <p className="small">В транзит: {d.shipments!.map((s) => `${s.quantity} ${GOODS[s.good as GoodId]?.name} (ден ${s.arriveTick})`).join(', ')}</p>
            )}
          </Section>
          <Section title="Изследвания">
            {(d.research ?? []).map((r) => (
              <Meter
                key={r.id}
                label={`${TECHS[r.techId as keyof typeof TECHS]?.name} (${r.status})`}
                value={r.progress}
                max={r.requiredDays}
                text={`${Math.floor(r.progress)}/${r.requiredDays} дни`}
              />
            ))}
            <p className="muted small">Започнете ново изследване от панела „Технологии“.</p>
          </Section>
          {d.stats && d.stats.length > 1 && (
            <Section title="Приходи и разходи (дневно)">
              <div className="chart">
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart data={d.stats.slice(-30).map((s) => ({ tick: s.tick, revenue: s.revenue / 100, costs: -s.costs / 100 }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="tick" stroke="#94a3b8" fontSize={11} />
                    <YAxis stroke="#94a3b8" fontSize={11} />
                    <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                    <Bar dataKey="revenue" name="Приходи" fill="#22c55e" />
                    <Bar dataKey="costs" name="Разходи" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Section>
          )}
        </>
      )}
      <Section title="Инвестиционен симулатор">
        <div className="row">
          <select value={invType} onChange={(e) => setInvType(e.target.value as FacilityType)} aria-label="Тип съоръжение">
            {FACILITY_TYPES.map((f) => (
              <option key={f} value={f}>
                {FACILITIES[f].name}
              </option>
            ))}
          </select>
        </div>
        {sim.data && (
          <p className="small">
            При текущите цени и заплати в {city?.name}: приходи {money(sim.data.dailyRevenue)}, суровини {money(sim.data.dailyInputs)}, заплати{' '}
            {money(sim.data.dailyWages)}, такси {money(sim.data.dailyFees)} →{' '}
            <b className={sim.data.dailyProfit < 0 ? 'bad' : 'good'}>{money(sim.data.dailyProfit)}/ден</b>
            {sim.data.paybackDays ? `, изплащане ≈ ${sim.data.paybackDays} дни` : ', не се изплаща'} (предполагаем персонал {pct(sim.data.staffingAssumed, 0)}).
          </p>
        )}
      </Section>
      <FoundCompany />
    </div>
  );
}

interface Book {
  bids: { price: number; quantity: number; orders: number }[];
  asks: { price: number; quantity: number; orders: number }[];
  trades: { id: string; price: number; quantity: number; kind: string; tick: number }[];
  refPrice: number | null;
  lastPrice: number | null;
  history: { tick: number; ref: number; last: number | null; volume: number; unmet: number }[];
}

export function MarketPanel() {
  const summary =
    useApi<{ good: GoodId; name: string; refPrice: number; lastPrice: number | null; change30d: number; unmetDemand: number }[]>('/market/summary');
  const [inst, setInst] = useState('GOOD:food');
  const book = useApi<Book>(`/market/book/${inst}`, [inst]);
  const orders = useApi<{ id: string; instrument: string; side: string; price: number; remaining: number; quantity: number }[]>('/market/orders');
  const companies = useStore((s) => s.companies);
  const activeCompanyId = useStore((s) => s.activeCompanyId);
  const cities = useStore((s) => s.cities);
  const activeCityId = useStore((s) => s.activeCityId);
  const [side, setSide] = useState<'BUY' | 'SELL'>('SELL');
  const [qty, setQty] = useState('10');
  const [price, setPrice] = useState('');
  const [cityId, setCityId] = useState<string>('');
  const isGood = inst.startsWith('GOOD:');
  const ref = book.data?.refPrice ?? 0;
  const good = isGood ? (inst.slice(5) as GoodId) : null;
  const myCo = useApi<CompanyFull>(activeCompanyId ? `/companies/${activeCompanyId}` : null);
  const tradeCity = cityId || activeCityId || '';
  const stock = good ? (myCo.data?.inventory ?? []).find((i) => i.good === good && i.cityId === tradeCity)?.quantity ?? 0 : 0;
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  const unit = price ? toCents(Number(price)) : ref;
  const total = q * unit;
  const coName = companies.find((c) => c.id === activeCompanyId)?.name;
  const cityName = cities.find((c) => c.id === tradeCity)?.name ?? '—';
  const bestBid = book.data?.bids[0]?.price;
  const bestAsk = book.data?.asks[0]?.price;
  const myGoods = (myCo.data?.inventory ?? []).filter((i) => i.quantity > 0);
  return (
    <div>
      <h2>Пазар и търговия</h2>
      <FeatureGuide
        title="Търговия – стъпка по стъпка"
        done="Търгувате. Следете цените (графиката) и неудовлетвореното търсене – там е печалбата."
        steps={[
          { label: 'Имате компания', done: !!activeCompanyId, hint: 'на борсата търгуват компании – основете една в панела „Бизнес“.', action: { label: 'Бизнес', run: () => setState({ panel: 'companies' }) } },
          { label: 'Стока в склада', done: (myCo.data?.inventory ?? []).some((i) => i.quantity + i.reserved > 0) || (myCo.data?.stats ?? []).some((x) => x.revenue > 0), hint: 'произведете стока със съоръжение или купете суровина тук („Купувам“).' },
          { label: 'Пуснете поръчка', done: (orders.data ?? []).length > 0 || !!myCo.data?.policy?.autoSell, hint: 'изберете стока, „Продавам“, количество и цена – или включете автоматичните продажби на компанията.' },
          { label: 'Първа продажба', done: (myCo.data?.stats ?? []).some((x) => x.revenue > 0), hint: 'изчакайте няколко дни – жителите и световният пазар купуват всеки ден от най-евтините поръчки.' },
        ]}
      />
      <details className="callout help">
        <summary>
          <b>Как се търгува?</b> (кликнете)
        </summary>
        <ol className="small">
          <li>
            <b>Произвеждате</b> стока със съоръжение на компанията (ферма → зърно, мелница → храна…). Тя влиза в склада на компанията в града, където е
            съоръжението.
          </li>
          <li>
            <b>Продавате</b>: изберете стоката, „Продавам“, количество и цена. Ако някой вече купува на тази или по-висока цена – сделката е веднага. Иначе
            поръчката чака в книгата; всеки ден жителите и световният пазар купуват от най-евтините.
          </li>
          <li>
            <b>Купувате</b> суровини за преработка: „Купувам“ – парите се заделят, докато някой продаде. Стоката от друг град пристига след няколко дни.
          </li>
          <li>
            <b>Договор</b> („Договори“) – редовни доставки с друга компания на фиксирана цена; изгодно, когато имате постоянен купувач или доставчик.
          </li>
        </ol>
      </details>
      {myGoods.length > 0 && (
        <Section title={`Стоки на ${coName ?? 'компанията'} за продажба`}>
          <div className="row wrap">
            {myGoods.map((i) => (
              <button
                key={`${i.good}:${i.cityId}`}
                className="btn small"
                title="Попълва поръчка за продажба на цялото количество малко под референтната цена"
                onClick={() => {
                  setInst(`GOOD:${i.good}`);
                  setSide('SELL');
                  setQty(String(i.quantity));
                  setPrice('');
                  setCityId(i.cityId);
                }}
              >
                Продай {num(i.quantity)} {GOODS[i.good as GoodId]?.name} · {cities.find((c) => c.id === i.cityId)?.name ?? ''}
              </button>
            ))}
          </div>
        </Section>
      )}
      <Table
        head={['Стока', 'Реф. цена', 'Последна', '30 дни', 'Неуд. търсене']}
        rows={(summary.data ?? []).map((g) => [
          <button className={`link ${inst === `GOOD:${g.good}` ? 'bold' : ''}`} onClick={() => setInst(`GOOD:${g.good}`)}>
            {g.name}
          </button>,
          money(g.refPrice),
          money(g.lastPrice),
          <span className={g.change30d >= 0 ? 'good' : 'bad'}>{pct(g.change30d)}</span>,
          num(g.unmetDemand),
        ])}
      />
      <Section title={`Книга на поръчките: ${isGood ? GOODS[inst.slice(5) as GoodId]?.name : 'акции'}`}>
        {good && <GoodInfo good={good} />}
        <div className="grid2">
          <Table
            head={['Купува', 'Кол.']}
            rows={(book.data?.bids ?? []).map((b) => [<span className="good">{money(b.price)}</span>, num(b.quantity)])}
            empty="Няма купувачи"
          />
          <Table
            head={['Продава', 'Кол.']}
            rows={(book.data?.asks ?? []).map((a) => [<span className="bad">{money(a.price)}</span>, num(a.quantity)])}
            empty="Няма продавачи"
          />
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={(book.data?.history ?? []).map((h) => ({ tick: h.tick, ref: h.ref / 100, last: h.last !== null ? h.last / 100 : null }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="tick" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
              <Line dataKey="ref" name="Реф. цена" stroke="#38bdf8" dot={false} />
              <Line dataKey="last" name="Последна сделка" stroke="#f59e0b" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="muted small">
          Световният пазар купува под {pct(BALANCE.market.exportFloor, 0)} и продава над {pct(BALANCE.market.importPremium, 0)} от реф. цена в ограничен обем;
          градското потребление купува храни и стоки до {pct(BALANCE.market.retailMaxPremium, 0)}. Цените следват неудовлетвореното търсене и себестойността.
        </p>
      </Section>
      <Section title="Нова поръчка">
        <div className="row seg">
          <button className={`btn small ${side === 'SELL' ? 'primary' : ''}`} onClick={() => setSide('SELL')}>
            Продавам
          </button>
          <button className={`btn small ${side === 'BUY' ? 'primary' : ''}`} onClick={() => setSide('BUY')}>
            Купувам
          </button>
        </div>
        <div className="row wrap">
          <input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Количество" style={{ width: 80 }} />
          <input
            type="number"
            min={0.01}
            step={0.01}
            placeholder={ref ? (ref / 100).toFixed(2) : 'цена €'}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label="Цена в €"
            style={{ width: 90 }}
          />
          {isGood && (
            <select value={cityId || activeCityId || ''} onChange={(e) => setCityId(e.target.value)} aria-label="Град (склад/дестинация)">
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <AsyncButton
            className="btn primary"
            disabled={isGood && !activeCompanyId}
            onClick={async () => {
              const p = toCents(Number(price || ref / 100));
              const r = await post<{ fills: { quantity: number; price: number }[] }>(
                '/market/orders',
                {
                  instrument: inst,
                  side,
                  quantity: Number(qty),
                  price: p,
                  companyId: isGood ? activeCompanyId : undefined,
                  cityId: isGood ? cityId || activeCityId : undefined,
                },
                true,
              );
              const filled = r.fills.reduce((a, f) => a + f.quantity, 0);
              toast(filled ? `Изпълнени веднага: ${filled} бр.` : 'Поръчката е в книгата', 'success');
              bumpData();
            }}
          >
            Изпрати
          </AsyncButton>
        </div>
        {isGood && !activeCompanyId && <p className="small bad">Нужна е компания – основете я в панела „Бизнес“.</p>}
        {isGood && activeCompanyId && good && (
          <div className="callout small">
            {side === 'SELL' ? (
              <>
                <b>{coName}</b> продава <b>{num(q)}</b> {GOODS[good].name} по <b>{money(unit)}</b> = <b>{money(total)}</b> от склада в {cityName}.{' '}
                {stock < q ? (
                  <span className="bad">В склада има само {num(stock)} – първо ги произведете или намалете количеството.</span>
                ) : (
                  <span className="good">В склада има {num(stock)}.</span>
                )}{' '}
                {bestBid !== undefined && unit <= bestBid
                  ? `Има купувач на ${money(bestBid)} – ще се продаде веднага.`
                  : `Ще чака купувач${bestBid !== undefined ? ` (сега най-високата оферта е ${money(bestBid)})` : ''}; жителите и износът купуват всеки ден.`}
              </>
            ) : (
              <>
                <b>{coName}</b> купува <b>{num(q)}</b> {GOODS[good].name} по до <b>{money(unit)}</b> = <b>{money(total)}</b> за склада в {cityName}. Парите се
                заделят (ескроу) до сделката.{' '}
                {myCo.data?.cash !== undefined && myCo.data.cash < total && <span className="bad">Компанията има само {money(myCo.data.cash)}. </span>}
                {bestAsk !== undefined && unit >= bestAsk
                  ? `Има продавач на ${money(bestAsk)} – ще се купи веднага.`
                  : `Ще чака продавач${bestAsk !== undefined ? ` (сега най-евтиният е ${money(bestAsk)})` : ''}.`}
              </>
            )}
          </div>
        )}
      </Section>
      <Section title="Моите отворени поръчки">
        <Table
          head={['Инструмент', 'Посока', 'Цена', 'Остатък', '']}
          rows={(orders.data ?? []).map((o) => [
            o.instrument.replace('GOOD:', ''),
            o.side === 'BUY' ? 'купува' : 'продава',
            money(o.price),
            `${o.remaining}/${o.quantity}`,
            <AsyncButton
              className="btn small"
              onClick={async () => {
                await del(`/market/orders/${o.id}`);
                bumpData();
              }}
            >
              Отмени
            </AsyncButton>,
          ])}
          empty="Няма отворени поръчки"
        />
      </Section>
      <Section title="Последни сделки">
        <Table
          head={['Ден', 'Цена', 'Кол.', 'Вид']}
          rows={(book.data?.trades ?? [])
            .slice(0, 12)
            .map((t) => [
              t.tick,
              money(t.price),
              t.quantity,
              t.kind === 'BOOK' ? 'между играчи' : t.kind === 'RETAIL' ? 'потребление' : t.kind === 'EXPORT' ? 'износ' : 'внос',
            ])}
        />
      </Section>
    </div>
  );
}

/** Кой произвежда стоката и за какво се използва – за да е ясно кое за какво е. */
function GoodInfo({ good }: { good: GoodId }) {
  const makers = FACILITY_TYPES.filter((f) => FACILITIES[f].recipe?.outputs[good]);
  const users = FACILITY_TYPES.filter((f) => FACILITIES[f].recipe?.inputs[good] || (good === 'coal' && FACILITIES[f].coalUse));
  const g = GOODS[good];
  return (
    <p className="small good-info">
      <b>{g.raw ? 'Суровина' : 'Преработена стока'}.</b> Произвежда се от: {makers.length ? makers.map((f) => FACILITIES[f].name).join(', ') : '—'}.{' '}
      {users.length > 0 && <>Нужна е за: {users.map((f) => FACILITIES[f].name).join(', ')}. </>}
      {g.retailPerCapita > 0 && <>Жителите на градовете я купуват всеки ден (до {pct(BALANCE.market.retailMaxPremium, 0)} от реф. цена). </>}
      Световният пазар изкупува под {pct(BALANCE.market.exportFloor, 0)} от реф. цена.
    </p>
  );
}

export function ContractsPanel() {
  const list = useApi<
    {
      id: string;
      sellerName: string;
      buyerName: string;
      good: string;
      quantityPerDelivery: number;
      pricePerUnit: number;
      intervalDays: number;
      deliveriesDone: number;
      deliveriesTotal: number;
      misses: number;
      status: string;
      proposedBySide: string;
      mySide: string;
      penaltyPerMiss: number;
    }[]
  >('/contracts');
  const allCompanies = useApi<{ id: string; name: string; hqCityId: string }[]>('/companies');
  const activeCompanyId = useStore((s) => s.activeCompanyId);
  const cities = useStore((s) => s.cities);
  const activeCityId = useStore((s) => s.activeCityId);
  const [f, setF] = useState({ other: '', role: 'SELLER', good: 'food', qty: '20', price: '12', interval: '5', deliveries: '6', penalty: '50', otherCity: '' });
  const STATUS: Record<string, string> = {
    PROPOSED: 'предложен',
    ACTIVE: 'активен',
    COMPLETED: 'изпълнен',
    BREACHED: 'нарушен',
    REJECTED: 'отхвърлен',
    CANCELLED: 'оттеглен',
    TERMINATED: 'прекратен',
  };
  const others = (allCompanies.data ?? []).filter((c) => c.id !== activeCompanyId);
  return (
    <div>
      <h2>Договори за доставка</h2>
      <FeatureGuide
        title="Договор – стъпка по стъпка"
        done="Имате работещ договор. Доставките стават автоматично – пазете стока в склада, за да няма неустойки."
        steps={[
          { label: 'Имате компания', done: !!activeCompanyId, hint: 'договорите се сключват между компании.', action: { label: 'Бизнес', run: () => setState({ panel: 'companies' }) } },
          { label: 'Има с кого', done: others.length > 0, hint: 'нужна е поне още една компания (на друг играч или ваша втора).' },
          { label: 'Изпратете оферта', done: (list.data ?? []).length > 0, hint: 'попълнете ролята, насрещната компания, стока, количество, цена и неустойка долу и изпратете.' },
          { label: 'Активен договор', done: (list.data ?? []).some((c) => c.status === 'ACTIVE' || c.status === 'COMPLETED'), hint: 'другата страна трябва да приеме офертата (бутон „Приеми“ в нейния списък).' },
        ]}
      />
      <p className="small muted">
        Договорът е споразумение между две компании: продавачът доставя всеки N дни определено количество на фиксирана цена, а купувачът плаща при всяка
        доставка. Ако продавачът няма стоката в склада, плаща неустойка. Другата страна трябва да приеме офертата.
      </p>
      <Table
        head={['Продавач → купувач', 'Условия', 'Изпълнение', 'Статус', '']}
        rows={(list.data ?? []).map((c) => [
          `${c.sellerName} → ${c.buyerName}`,
          `${c.quantityPerDelivery} ${GOODS[c.good as GoodId]?.name} × ${money(c.pricePerUnit)} / ${c.intervalDays} дни`,
          `${c.deliveriesDone}/${c.deliveriesTotal} (пропуски ${c.misses})`,
          STATUS[c.status] ?? c.status,
          <span className="row">
            {c.status === 'PROPOSED' && c.proposedBySide !== c.mySide && (
              <>
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/contracts/${c.id}/accept`);
                    list.reload();
                  }}
                >
                  Приеми
                </AsyncButton>
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/contracts/${c.id}/reject`);
                    list.reload();
                  }}
                >
                  Откажи
                </AsyncButton>
              </>
            )}
            {c.status === 'PROPOSED' && c.proposedBySide === c.mySide && (
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  await post(`/contracts/${c.id}/cancel`);
                  list.reload();
                }}
              >
                Оттегли
              </AsyncButton>
            )}
            {c.status === 'ACTIVE' && (
              <AsyncButton
                className="btn small"
                title={`Неустойка до 3 × ${money(c.penaltyPerMiss)}`}
                onClick={async () => {
                  await post(`/contracts/${c.id}/terminate`);
                  list.reload();
                }}
              >
                Прекрати
              </AsyncButton>
            )}
          </span>,
        ])}
        empty="Няма договори"
      />
      <Section title="Предложи договор (от активната компания)">
        <div className="form-grid">
          <Field label="Моята роля">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="SELLER">Продавач</option>
              <option value="BUYER">Купувач</option>
            </select>
          </Field>
          <Field label="Насрещна компания">
            <select
              value={f.other}
              onChange={(e) => setF({ ...f, other: e.target.value, otherCity: others.find((o) => o.id === e.target.value)?.hqCityId ?? '' })}
            >
              <option value="">—</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Стока">
            <select value={f.good} onChange={(e) => setF({ ...f, good: e.target.value })}>
              {GOOD_IDS.map((g) => (
                <option key={g} value={g}>
                  {GOODS[g].name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Количество/доставка">
            <input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
          </Field>
          <Field label="Цена/ед. (€)">
            <input type="number" step={0.01} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          </Field>
          <Field label="През (дни)">
            <input type="number" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} />
          </Field>
          <Field label="Брой доставки">
            <input type="number" value={f.deliveries} onChange={(e) => setF({ ...f, deliveries: e.target.value })} />
          </Field>
          <Field label="Неустойка/пропуск (€)">
            <input type="number" value={f.penalty} onChange={(e) => setF({ ...f, penalty: e.target.value })} />
          </Field>
        </div>
        {activeCompanyId && f.other && (
          <div className="callout small">
            {(() => {
              const me = allCompanies.data?.find((c) => c.id === activeCompanyId)?.name ?? 'Вашата компания';
              const other = others.find((o) => o.id === f.other)?.name ?? '';
              const [seller, buyer] = f.role === 'SELLER' ? [me, other] : [other, me];
              const n = Number(f.deliveries) || 0;
              const per = (Number(f.qty) || 0) * (Number(f.price) || 0);
              return (
                <>
                  <b>{seller}</b> доставя на <b>{buyer}</b> по {num(Number(f.qty) || 0)} {GOODS[f.good as GoodId]?.name} на всеки {f.interval} дни, {n} пъти.
                  Купувачът плаща {money(toCents(per))} при всяка доставка (общо {money(toCents(per * n))}). При липса на стока продавачът плаща{' '}
                  {money(toCents(Number(f.penalty) || 0))}.
                </>
              );
            })()}
          </div>
        )}
        <AsyncButton
          className="btn primary"
          disabled={!activeCompanyId || !f.other}
          onClick={async () => {
            const mine = activeCompanyId!;
            const myCity = activeCityId ?? cities[0]?.id;
            await post('/contracts', {
              sellerCompanyId: f.role === 'SELLER' ? mine : f.other,
              buyerCompanyId: f.role === 'SELLER' ? f.other : mine,
              good: f.good,
              quantityPerDelivery: Number(f.qty),
              pricePerUnit: toCents(Number(f.price)),
              intervalDays: Number(f.interval),
              deliveries: Number(f.deliveries),
              penaltyPerMiss: toCents(Number(f.penalty)),
              fromCityId: f.role === 'SELLER' ? myCity : f.otherCity,
              toCityId: f.role === 'SELLER' ? f.otherCity : myCity,
            });
            toast('Офертата е изпратена', 'success');
            list.reload();
          }}
        >
          Изпрати оферта
        </AsyncButton>
      </Section>
    </div>
  );
}

export function BankPanel() {
  const loans = useApi<
    {
      id: string;
      borrowerName: string;
      borrowerType: string;
      principal: number;
      outstanding: number;
      annualRate: number;
      payment: number;
      nextDueTick: number;
      missed: number;
      status: string;
      restructured: boolean;
    }[]
  >('/bank/loans');
  const city = useStore((s) => s.city);
  const activeCompanyId = useStore((s) => s.activeCompanyId);
  const companies = useStore((s) => s.companies);
  const [who, setWho] = useState<'CITY' | 'COMPANY'>('COMPANY');
  const borrowerId = who === 'CITY' ? city?.id : activeCompanyId;
  const offer = useApi<{ rating: string; score: number; annualRate: number; maxAmount: number; baseRate: number; assets: number; debt: number }>(
    borrowerId ? `/bank/offer?type=${who}&id=${borrowerId}` : null,
    [who, borrowerId],
  );
  const [amount, setAmount] = useState('10000');
  const [term, setTerm] = useState('360');
  const [repay, setRepay] = useState<Record<string, string>>({});
  const STATUS: Record<string, string> = {
    ACTIVE: 'активен',
    PAID: 'изплатен',
    DEFAULTED: 'в неизпълнение',
    RESTRUCTURED: 'преструктуриран',
    WRITTEN_OFF: 'отписан',
  };
  return (
    <div>
      <h2>Банка и кредити</h2>
      <FeatureGuide
        title="Кредит – стъпка по стъпка"
        done="Кредитът се изплаща на вноски на всеки 30 дни. Плащайте навреме – рейтингът и лихвата зависят от това."
        steps={[
          { label: 'Изберете кредитополучател', done: !!borrowerId, hint: 'кредит може да вземе компанията ви или градът (бюджетът).' },
          { label: 'Вижте офертата', done: !!offer.data, hint: 'банката дава рейтинг (A–D), лихва и максимална сума според активите и дълговете.' },
          { label: 'Изтеглете кредит', done: (loans.data ?? []).length > 0, hint: 'въведете сума (до максимума) и срок в дни – парите идват веднага.' },
          { label: 'Плащайте навреме', done: (loans.data ?? []).length > 0 && (loans.data ?? []).every((l) => l.missed === 0), hint: 'вноската се взима сама; ако няма пари – пропуск, а след 3 – неизпълнение.' },
        ]}
      />
      <Field label="Кредитополучател">
        <select value={who} onChange={(e) => setWho(e.target.value as 'CITY' | 'COMPANY')}>
          <option value="COMPANY">Компания: {companies.find((c) => c.id === activeCompanyId)?.name ?? '—'}</option>
          <option value="CITY">Град: {city?.name ?? '—'}</option>
        </select>
      </Field>
      {offer.data && (
        <div className="grid2">
          <Stat
            label="Кредитен рейтинг"
            value={
              <span style={{ color: RATING_COLOR[offer.data.rating] }}>
                {offer.data.rating} ({offer.data.score})
              </span>
            }
          />
          <Stat label="Годишна лихва" value={pct(offer.data.annualRate, 2)} />
          <Stat label="Базова лихва (ЦБ)" value={pct(offer.data.baseRate, 2)} />
          <Stat label="Максимален кредит" value={money(offer.data.maxAmount)} />
        </div>
      )}
      <div className="row wrap">
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Сума €" style={{ width: 110 }} />
        <select value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Срок">
          {[90, 180, 360, 720, 1080].map((d) => (
            <option key={d} value={d}>
              {d} дни
            </option>
          ))}
        </select>
        <AsyncButton
          className="btn primary"
          disabled={!borrowerId}
          onClick={async () => {
            await post('/bank/loans', { borrowerType: who, borrowerId, amount: toCents(Number(amount)), termDays: Number(term) }, true);
            toast('Кредитът е отпуснат', 'success');
            await refreshAll();
            loans.reload();
            offer.reload();
          }}
        >
          Изтегли кредит
        </AsyncButton>
      </div>
      <p className="muted small">
        Вноските са на всеки {BALANCE.banking.paymentIntervalDays} дни (анюитет). Пропусната вноска → наказателна лихва и по-нисък рейтинг; след{' '}
        {BALANCE.banking.maxMissedBeforeDefault} пропуска – неизпълнение. Можете веднъж да поискате преструктуриране (по-дълъг срок, +2% лихва). Без
        преструктуриране следва несъстоятелност (компания) или принудително оздравяване (град).
      </p>
      <Section title="Кредити">
        <Table
          head={['Длъжник', 'Остатък', 'Лихва', 'Вноска', 'Падеж', 'Статус', '']}
          rows={(loans.data ?? []).map((l) => [
            l.borrowerName,
            money(l.outstanding),
            pct(l.annualRate, 2),
            money(l.payment),
            `ден ${l.nextDueTick}`,
            `${STATUS[l.status] ?? l.status}${l.missed ? ` (${l.missed} пропуска)` : ''}`,
            ['ACTIVE', 'RESTRUCTURED', 'DEFAULTED'].includes(l.status) ? (
              <span className="row">
                <input
                  type="number"
                  placeholder="€"
                  value={repay[l.id] ?? ''}
                  onChange={(e) => setRepay({ ...repay, [l.id]: e.target.value })}
                  style={{ width: 70 }}
                  aria-label="Сума за погасяване"
                />
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/bank/loans/${l.id}/repay`, { amount: toCents(Number(repay[l.id] || 0)) }, true);
                    loans.reload();
                    await refreshAll();
                  }}
                >
                  Погаси
                </AsyncButton>
                {!l.restructured && (l.missed > 0 || l.status === 'DEFAULTED') && (
                  <AsyncButton
                    className="btn small"
                    onClick={async () => {
                      await post(`/bank/loans/${l.id}/restructure`);
                      loans.reload();
                    }}
                  >
                    Преструктурирай
                  </AsyncButton>
                )}
              </span>
            ) : (
              ''
            ),
          ])}
          empty="Нямате кредити"
        />
      </Section>
      <Wallet />
    </div>
  );
}

function Wallet() {
  const w = useApi<{ balance: number; history: { id: string; kind: string; amount: number; tick: number }[] }>('/wallet');
  return (
    <Section title={`Личен портфейл: ${money(w.data?.balance)}`}>
      <Table
        head={['Ден', 'Операция', 'Сума']}
        rows={(w.data?.history ?? [])
          .slice(0, 15)
          .map((h) => [h.tick, KIND_LABELS[h.kind] ?? h.kind, <span className={h.amount < 0 ? 'bad' : 'good'}>{money(h.amount)}</span>])}
      />
    </Section>
  );
}
