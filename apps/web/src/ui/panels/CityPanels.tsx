import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  BALANCE,
  FACILITIES,
  SERVICES,
  UPGRADE_REQUIREMENTS,
  UPGRADE_REQUIREMENT_LABELS,
  ZONES,
  ZONE_TYPES,
  tileKey,
  type CityDerived,
  type CityPolicy,
  type FacilityType,
  type TileMap,
  type UpgradeRequirement,
} from '@gce/shared';
import { getWorld } from '@gce/world-generation';
import { patch, post } from '../../api';
import { bumpData, refreshAll, refreshCity, setState, toast, useStore } from '../../store';
import { KIND_LABELS, money, num, pct, toCents } from '../../format';
import { AsyncButton, DemandBar, Field, Meter, Section, Stat, Table, useApi } from '../common';
import { describeTile } from '../../map/MapView';
import { REQ_ICON, reqTool, reqToolLabel } from '../needs';

const EDU = ['Основно (L0)', 'Средно (L1)', 'Висше (L2)'];

function FoundCity() {
  const [name, setName] = useState('');
  const cities = useStore((s) => s.cities);
  return (
    <Section title={cities.length ? 'Нов град' : 'Основете първия си град'}>
      <p className="muted">
        {cities.length
          ? `Допълнителен град струва ${money(BALANCE.start.additionalCityCost)} от личния портфейл и получава тази сума като начален бюджет.`
          : `Изберете сами къде в България да бъде градът. Получавате ${BALANCE.world.startParcels}×${BALANCE.world.startParcels} парцела земя и начален бюджет ${money(BALANCE.start.cityTreasury)}; после купувате съседна земя и растете.`}
      </p>
      <div className="row">
        <input placeholder="Име на града" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Име на града" />
        <button className="btn primary" disabled={name.trim().length < 2} onClick={() => setState({ tool: { kind: 'found', name: name.trim() } })}>
          📍 Избери място на картата
        </button>
      </div>
    </Section>
  );
}

export function CityPanel() {
  const city = useStore((s) => s.city);
  const cities = useStore((s) => s.cities);
  const events = useApi<{ id: string; tick: number; message: string }[]>(city ? `/cities/${city.id}/events` : null);
  if (!city)
    return (
      <>
        <FoundCity />
        <ResetGame />
      </>
    );
  const s = city.stats ?? {};
  const isNew = Object.keys(city.tiles).length === 0;
  return (
    <div>
      <h2>{city.name}</h2>
      {isNew && (
        <div className="callout">
          <b>Първи стъпки:</b> 1) инструмент „Път“ – влачете по територията (златистата рамка); 2) „Зони“ – жилищни, търговски и индустриални до пътя; 3)
          „Услуги“ – вятърна централа и помпена станция за ток и вода, после училище. Сградите ще се появят сами, ако има търсене.
        </div>
      )}
      <div className="grid2">
        <Stat label="Население" value={num(s.population ?? 0)} />
        <Stat label="Безработица" value={pct(s.unemploymentRate ?? 0)} tone={(s.unemploymentRate ?? 0) > 0.12 ? 'bad' : 'good'} />
        <Stat label="Удовлетвореност" value={pct(s.happiness ?? 0, 0)} tone={(s.happiness ?? 0) < 0.45 ? 'bad' : undefined} />
        <Stat label="Привлекателност" value={pct(s.attractiveness ?? 0, 0)} />
        <Stat label="Бюджет" value={money(city.treasury)} tone={(city.treasury ?? 0) < 0 ? 'bad' : undefined} />
        <Stat label="Нетно/ден" value={money(s.net ?? 0)} tone={(s.net ?? 0) < 0 ? 'bad' : 'good'} />
        <Stat label="БВП/ден" value={money(s.gdp ?? 0)} />
        <Stat label="Ср. стойност на земята" value={(s.landValueAvg ?? 0).toFixed(2)} />
      </div>
      <Section title="Търсене по зони">
        <div className="demands">
          {ZONE_TYPES.map((z) => (
            <DemandBar key={z} label={ZONES[z].name.slice(0, 5)} value={s.demand?.[z] ?? 0} color={`#${ZONES[z].color.toString(16).padStart(6, '0')}`} />
          ))}
        </div>
      </Section>
      <Section title="Сгради">
        <div className="chips">
          {ZONE_TYPES.map((z) => (
            <span key={z} className="chip">
              <i style={{ background: `#${ZONES[z].color.toString(16).padStart(6, '0')}` }} />
              {ZONES[z].name}: {s.buildings?.[z] ?? 0}
            </span>
          ))}
          <span className="chip">Изоставени: {s.abandoned ?? 0}</span>
        </div>
        <LevelChips tiles={city.tiles as TileMap} />
      </Section>
      <UpgradeBlockers blockers={s.upgradeBlockers} />
      <Section title="Обществени услуги">
        <Meter label="Образование" value={s.services?.education ?? 0} />
        <Meter label="Здравеопазване" value={s.services?.health ?? 0} color="#ef4444" />
        <Meter label="Сигурност" value={s.services?.safety ?? 0} color="#3b82f6" />
        <Meter label="Пожарна безопасност" value={s.services?.fire ?? 0} color="#f97316" />
        <Meter label="Обществен транспорт" value={s.services?.transit ?? 0} color="#eab308" />
      </Section>
      <Section title="Последни събития">
        <ul className="list">
          {(events.data ?? []).slice(0, 8).map((e) => (
            <li key={e.id}>
              <small>ден {e.tick}</small> {e.message}
            </li>
          ))}
          {!events.data?.length && <li className="muted">Няма събития</li>}
        </ul>
      </Section>
      {cities.length < 5 && <FoundCity />}
      <ResetGame />
    </div>
  );
}

/** „Започни отначало“: изтрива градовете и компаниите на играча и връща стартовия капитал. */
function ResetGame() {
  return (
    <Section title="Нова игра">
      <p className="small muted">
        Започнете отначало: градовете и компаниите ви се изтриват, а получавате отново {money(BALANCE.start.wallet)} в портфейла и{' '}
        {money(BALANCE.start.cityTreasury)} за нов град. Не може да се отмени.
      </p>
      <AsyncButton
        className="btn danger small"
        onClick={async () => {
          if (!window.confirm('Сигурни ли сте? Всичките ви градове и компании ще бъдат изтрити и започвате отначало.')) return;
          const r = await post<{ cities: number; companies: number }>('/auth/reset', {});
          toast(`Нова игра: изтрити ${r.cities} града и ${r.companies} компании. Изберете място за нов град.`, 'success');
          setState({ city: null, tool: { kind: 'found', name: '' }, tutorial: 0 });
          await refreshAll();
          bumpData();
        }}
      >
        ↺ Започни отначало
      </AsyncButton>
    </Section>
  );
}

export function PopulationPanel() {
  const city = useStore((s) => s.city);
  const hist = useApi<{ series: Record<string, unknown>[]; forecast: { population: { points: { step: number; value: number }[] } } }>(
    city ? `/cities/${city.id}/history?days=120` : null,
  );
  if (!city?.stats) return <p className="muted">Изберете град.</p>;
  const s = city.stats;
  const edu = s.edu ?? [0, 0, 0];
  const jobs = s.jobs ?? [0, 0, 0];
  const emp = s.employed ?? [0, 0, 0];
  const wages = s.wages ?? [0, 0, 0];
  const series = (hist.data?.series ?? []).map((r) => ({
    tick: r.tick as number,
    population: r.population as number,
    unemployment: Math.round(((r.unemploymentRate as number) ?? 0) * 1000) / 10,
  }));
  const last = series.at(-1)?.tick ?? 0;
  const fc = (hist.data?.forecast.population.points ?? []).map((p) => ({ tick: last + p.step, forecast: p.value }));
  return (
    <div>
      <h2>Население и трудов пазар</h2>
      <div className="grid2">
        <Stat label="Жители" value={num(s.population)} />
        <Stat label="Работна сила" value={num(s.workforce)} />
        <Stat label="Безработни" value={num(s.unemployed)} />
        <Stat label="Свободни позиции" value={num(s.vacancies)} />
      </div>
      <Table
        head={['Ниво', 'Жители', 'Работни места', 'Заети', 'Заплата/ден']}
        rows={[0, 1, 2].map((l) => [EDU[l], num(edu[l]), num(jobs[l]), num(emp[l]), money(wages[l])])}
      />
      <p className="muted small">
        По-образованите могат да заемат по-нископлатени позиции, но не обратно. Заплатите растат при недостиг на кадри и падат при безработица. Училищата и
        университетите повишават квалификацията с времето (≈{BALANCE.population.schoolDays} и {BALANCE.population.universityDays} дни).
      </p>
      <Section title="Динамика (последните 120 дни + прогноза 30 дни)">
        <div className="chart">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={[...series, ...fc]}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="tick" stroke="#94a3b8" fontSize={11} />
              <YAxis yAxisId="l" stroke="#94a3b8" fontSize={11} />
              <YAxis yAxisId="r" orientation="right" stroke="#94a3b8" fontSize={11} unit="%" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
              <Legend />
              <Line yAxisId="l" dataKey="population" name="Население" stroke="#22c55e" dot={false} />
              <Line yAxisId="l" dataKey="forecast" name="Прогноза" stroke="#22c55e" strokeDasharray="4 4" dot={false} />
              <Line yAxisId="r" dataKey="unemployment" name="Безработица %" stroke="#f97316" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>
    </div>
  );
}

export function FinancePanel() {
  const city = useStore((s) => s.city);
  const fin = useApi<{
    history: { id: string; kind: string; amount: number; tick: number }[];
    credit: { rating: string; annualRate: number; maxAmount: number };
  }>(city?.isOwner ? `/cities/${city.id}/finance` : null);
  const hist = useApi<{ series: { tick: number; treasury?: number; net?: number }[] }>(city ? `/cities/${city.id}/history?days=90` : null);
  const [p, setP] = useState<CityPolicy | null>(city?.policy ?? null);
  const [fund, setFund] = useState('');
  const [sanction, setSanction] = useState('');
  useEffect(() => setP(city?.policy ?? null), [city?.id, city?.policy]);
  if (!city?.isOwner || !p) return <p className="muted">Изберете свой град.</p>;
  const s = city.stats ?? {};
  const L = BALANCE.taxes.limits;
  const taxRow = (key: keyof CityPolicy['taxes'], label: string, max: number, isRate = true) => (
    <Field label={`${label}: ${isRate ? pct(p.taxes[key]) : money(p.taxes[key])}`}>
      <input
        type="range"
        min={0}
        max={max}
        step={isRate ? 0.005 : 10}
        value={p.taxes[key]}
        onChange={(e) => setP({ ...p, taxes: { ...p.taxes, [key]: Number(e.target.value) } })}
      />
    </Field>
  );
  return (
    <div>
      <h2>Финанси и политики</h2>
      <div className="grid2">
        <Stat label="Бюджет" value={money(city.treasury)} tone={(city.treasury ?? 0) < 0 ? 'bad' : undefined} />
        <Stat label="Нетно/ден" value={money(s.net ?? 0)} tone={(s.net ?? 0) < 0 ? 'bad' : 'good'} />
      </div>
      {city.receivership && <div className="callout bad">Градът е в режим на финансово оздравяване – бюджетът за услуги е ограничен до 50%.</div>}
      <div className="grid2">
        <Section title="Приходи/ден">
          <Table head={['', '']} rows={Object.entries(s.income ?? {}).map(([k, v]) => [KIND_LABELS[`CITY_${k.toUpperCase()}`] ?? k, money(v)])} />
        </Section>
        <Section title="Разходи/ден">
          <Table
            head={['', '']}
            rows={Object.entries(s.expenses ?? {}).map(([k, v]) => [
              KIND_LABELS[`CITY_${k.toUpperCase()}`] ?? (k === 'energy_purchases' ? 'Изкупена енергия' : k),
              money(v),
            ])}
          />
        </Section>
      </div>
      <Section title="Данъци и такси">
        {taxRow('income', 'Данък върху доходите', L.income[1])}
        {taxRow('property', 'Данък имоти (годишен)', L.property[1])}
        {taxRow('corporate', 'Корпоративен данък', L.corporate[1])}
        {taxRow('sales', 'Данък продажби', L.sales[1])}
        {taxRow('resource', 'Ресурсна такса (добив)', L.resource[1])}
        {taxRow('pollution', 'Екотакса за единица замърсяване', L.pollution[1], false)}
        <Field label={`Бюджет на услугите: ${pct(p.serviceBudget, 0)}`}>
          <input type="range" min={0.5} max={1.5} step={0.05} value={p.serviceBudget} onChange={(e) => setP({ ...p, serviceBudget: Number(e.target.value) })} />
        </Field>
        <Field label={`Тарифа ток: ${money(p.powerTariff)}/ед.`}>
          <input type="range" min={0} max={1000} step={10} value={p.powerTariff} onChange={(e) => setP({ ...p, powerTariff: Number(e.target.value) })} />
        </Field>
        <Field label={`Тарифа вода: ${money(p.waterTariff)}/ед.`}>
          <input type="range" min={0} max={300} step={5} value={p.waterTariff} onChange={(e) => setP({ ...p, waterTariff: Number(e.target.value) })} />
        </Field>
        <Field label={`Мито при внос от други градове: ${pct(p.importTariff)}`}>
          <input type="range" min={0} max={0.5} step={0.01} value={p.importTariff} onChange={(e) => setP({ ...p, importTariff: Number(e.target.value) })} />
        </Field>
        <Field label="Субсидии по зони (€ на заета сграда/ден)">
          <div className="row wrap">
            {ZONE_TYPES.map((z) => (
              <label key={z} className="mini">
                {z}
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={(p.subsidies[z] ?? 0) / 100}
                  onChange={(e) => setP({ ...p, subsidies: { ...p.subsidies, [z]: toCents(Math.max(0, Math.min(50, Number(e.target.value) || 0))) } })}
                />
              </label>
            ))}
          </div>
        </Field>
        <p className="muted small">
          Високите данъци носят приходи, но намаляват търсенето, инвестициите и удовлетвореността. Субсидиите стимулират съответната зона срещу ежедневен
          разход.
        </p>
        <AsyncButton
          className="btn primary"
          onClick={async () => {
            await patch(`/cities/${city.id}/policy`, {
              taxes: p.taxes,
              serviceBudget: p.serviceBudget,
              powerTariff: p.powerTariff,
              waterTariff: p.waterTariff,
              importTariff: p.importTariff,
              subsidies: p.subsidies,
            });
            toast('Политиките са записани', 'success');
            await refreshCity();
          }}
        >
          Запиши политиките
        </AsyncButton>
      </Section>
      <Section title="Санкции (забрана за търговия с играч)">
        <div className="chips">
          {p.sanctions.map((u) => (
            <span key={u} className="chip">
              {u.slice(0, 8)}…{' '}
              <button
                className="link"
                onClick={async () => {
                  await patch(`/cities/${city.id}/policy`, { sanctions: p.sanctions.filter((x) => x !== u) });
                  await refreshCity();
                }}
              >
                ✖
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <input placeholder="ID на потребител" value={sanction} onChange={(e) => setSanction(e.target.value)} aria-label="ID на потребител за санкция" />
          <AsyncButton
            onClick={async () => {
              await patch(`/cities/${city.id}/policy`, { sanctions: [...p.sanctions, sanction.trim()] });
              setSanction('');
              await refreshCity();
            }}
          >
            Наложи
          </AsyncButton>
        </div>
      </Section>
      <Section title="Финансиране от личния портфейл">
        <div className="row">
          <input type="number" min={1} placeholder="€" value={fund} onChange={(e) => setFund(e.target.value)} aria-label="Сума в €" />
          <AsyncButton
            onClick={async () => {
              await post(`/cities/${city.id}/funding`, { amount: toCents(Number(fund)) }, true);
              setFund('');
              await refreshAll();
            }}
          >
            Преведи
          </AsyncButton>
        </div>
        {fin.data && (
          <p className="muted small">
            Кредитен рейтинг на града: <b>{fin.data.credit.rating}</b> · лихва {pct(fin.data.credit.annualRate, 2)} · лимит {money(fin.data.credit.maxAmount)}{' '}
            (виж „Банка“)
          </p>
        )}
      </Section>
      <Section title="Бюджет (90 дни)">
        <div className="chart">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={(hist.data?.series ?? []).map((r) => ({ tick: r.tick, treasury: (r.treasury ?? 0) / 100, net: (r.net ?? 0) / 100 }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="tick" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
              <Area dataKey="treasury" name="Бюджет (€)" stroke="#38bdf8" fill="#38bdf833" />
              <Area dataKey="net" name="Нетно/ден (€)" stroke="#22c55e" fill="#22c55e22" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <Section title="Последни операции">
        <Table
          head={['Ден', 'Вид', 'Сума']}
          rows={(fin.data?.history ?? [])
            .slice(0, 25)
            .map((h) => [h.tick, KIND_LABELS[h.kind] ?? h.kind, <span className={h.amount < 0 ? 'bad' : 'good'}>{money(h.amount)}</span>])}
        />
      </Section>
    </div>
  );
}

export function InfraPanel() {
  const city = useStore((s) => s.city);
  if (!city?.stats) return <p className="muted">Изберете град.</p>;
  const s = city.stats;
  const svcCount: Record<string, number> = {};
  for (const t of Object.values(city.tiles)) if (t.t === 'service') svcCount[t.s] = (svcCount[t.s] ?? 0) + 1;
  const roads = Object.values(city.tiles).filter((t) => t.t === 'road').length;
  return (
    <div>
      <h2>Инфраструктура</h2>
      <Meter label="Електричество (покритие)" value={s.power?.ratio ?? 0} color="#facc15" text={`${num(s.power?.supply)} / ${num(s.power?.demand)} ед.`} />
      <Meter label="Вода (покритие)" value={s.water?.ratio ?? 0} color="#38bdf8" text={`${num(s.water?.supply)} / ${num(s.water?.demand)} ед.`} />
      <Meter
        label="Канализация (натоварване)"
        value={(s.sewage?.load ?? 0) / Math.max(1, s.sewage?.capacity ?? 1)}
        max={1.5}
        color="#a16207"
        text={`${num(s.sewage?.load)} / ${num(s.sewage?.capacity)}`}
      />
      <Meter
        label="Отпадъци (натоварване)"
        value={(s.waste?.load ?? 0) / Math.max(1, s.waste?.capacity ?? 1)}
        max={1.5}
        color="#78716c"
        text={`${num(s.waste?.load)} / ${num(s.waste?.capacity)}`}
      />
      <Meter
        label="Задръстване"
        value={s.traffic?.congestion ?? 0}
        max={2}
        color="#ef4444"
        text={`${(s.traffic?.congestion ?? 0).toFixed(2)} · пътуване ${s.traffic?.commuteMinutes ?? 0} мин`}
      />
      <div className="grid2">
        <Stat label="Пътни плочки" value={roads} />
        <Stat label="Изкупна цена енергия" value={`${money(s.power?.price ?? 0)}/ед.`} />
        <Stat label="Ср. замърсяване" value={(s.pollutionAvg ?? 0).toFixed(1)} tone={(s.pollutionAvg ?? 0) > 6 ? 'bad' : undefined} />
      </div>
      <Section title="Обществени сгради">
        <Table
          head={['Сграда', 'Брой', 'Поддръжка/ден', 'Капацитет']}
          rows={Object.entries(svcCount).map(([k, n]) => {
            const d = SERVICES[k as keyof typeof SERVICES];
            return [
              d.name,
              n,
              money(d.upkeep * n),
              d.powerSupply
                ? `${d.powerSupply} ток`
                : d.waterSupply
                  ? `${d.waterSupply} вода`
                  : d.capacity
                    ? `${d.capacity}`
                    : d.sewageCapacity
                      ? `${d.sewageCapacity}`
                      : d.wasteCapacity
                        ? `${d.wasteCapacity}`
                        : `радиус ${d.radius}`,
            ];
          })}
          empty="Няма построени услуги"
        />
      </Section>
      <Section title="Приоритет при недостиг на енергия">
        <PowerPriority />
      </Section>
      {city.isOwner && (
        <Section title="Магистрали до други градове">
          <CityLinks />
        </Section>
      )}
    </div>
  );
}

interface LinkView {
  id: string;
  a: { id: string; name: string };
  b: { id: string; name: string };
  length: number;
}

/** Магистрали: превозът на стоки до свързаните градове е наполовина по-евтин. */
function CityLinks() {
  const city = useStore((s) => s.city)!;
  const all = useApi<{ id: string; name: string; ownerName: string; originX: number; originY: number }[]>('/cities', [city.id]);
  const links = useApi<LinkView[]>('/world/links', [city.id]);
  const linked = new Set((links.data ?? []).flatMap((l) => (l.a.id === city.id ? [l.b.id] : l.b.id === city.id ? [l.a.id] : [])));
  const others = (all.data ?? [])
    .filter((c) => c.id !== city.id)
    .map((c) => ({ ...c, dist: Math.round(Math.hypot(c.originX - city.originX, c.originY - city.originY)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);
  const L = BALANCE.links;
  return (
    <div>
      <p className="small muted">
        Превозът на стоки до свързан град е с {Math.round((1 - L.shippingMult) * 100)}% по-евтин. Цена: {money(L.costPerTile)} за плочка (до {L.maxLength}{' '}
        плочки).
      </p>
      {!others.length && <p className="small muted">Още няма други градове.</p>}
      <ul className="list">
        {others.map((c) => (
          <li key={c.id}>
            🛣 {c.name}{' '}
            <span className="muted small">
              ({c.ownerName}, {c.dist} плочки)
            </span>{' '}
            {linked.has(c.id) ? (
              <span className="chip">✔ свързан</span>
            ) : c.dist > L.maxLength ? (
              <span className="muted small">твърде далеч</span>
            ) : (
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  const res = await post<{ cost: number }>(`/cities/${city.id}/links`, { toCityId: c.id }, true);
                  toast(`Магистралата е построена (${money(res.cost)})`, 'success');
                  links.reload();
                  await refreshCity();
                  bumpData();
                }}
              >
                Построй · {money(Math.round(Math.max(1, c.dist) * L.costPerTile))}
              </AsyncButton>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PowerPriority() {
  const city = useStore((s) => s.city)!;
  const order = city.policy?.powerPriority ?? ['services', 'facilities', 'zones'];
  const labels: Record<string, string> = { services: 'Обществени услуги', facilities: 'Предприятия', zones: 'Жилища и бизнес' };
  const move = async (i: number, d: number) => {
    const next = [...order];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    await patch(`/cities/${city.id}/policy`, { powerPriority: next });
    await refreshCity();
  };
  return (
    <ol className="list">
      {order.map((o, i) => (
        <li key={o}>
          {labels[o]}{' '}
          <button className="link" onClick={() => void move(i, -1)} aria-label="нагоре">
            ▲
          </button>
          <button className="link" onClick={() => void move(i, 1)} aria-label="надолу">
            ▼
          </button>
        </li>
      ))}
    </ol>
  );
}

function LevelChips({ tiles }: { tiles: TileMap }) {
  const n = [0, 0, 0];
  for (const t of Object.values(tiles)) if (t.t === 'zone' && t.lvl > 0 && !t.ab) n[t.lvl - 1]++;
  return (
    <div className="chips" style={{ marginTop: 6 }}>
      {n.map((c, i) => (
        <span key={i} className="chip">
          Ниво {i + 1}: {c}
        </span>
      ))}
    </div>
  );
}

/** Кои условия спират най-много сгради да се надградят – подсказка какво да построи играчът. */
function UpgradeBlockers({ blockers }: { blockers?: Partial<Record<UpgradeRequirement, number>> }) {
  const list = Object.entries(blockers ?? {})
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (!list.length) return null;
  return (
    <Section title="Какво спира надграждането">
      <p className="small muted">Сградите се надграждат сами, когато всички условия за следващото ниво са изпълнени. Брой сгради, на които липсва:</p>
      <ul className="small">
        {list.slice(0, 8).map(([k, v]) => (
          <li key={k}>
            {UPGRADE_REQUIREMENT_LABELS[k as UpgradeRequirement]}: <b>{v}</b>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Списък с условията за следващото ниво на сграда (✔ изпълнено / ✖ липсва). */
function UpgradeChecklist({ cityId, x, y }: { cityId: string; x: number; y: number }) {
  const city = useStore((s) => s.city);
  const layers = useApi<CityDerived>(city?.isOwner ? `/cities/${cityId}/layers` : null, [cityId]);
  const tile = city ? (city.tiles as TileMap)[tileKey(x, y)] : undefined;
  if (!tile || tile.t !== 'zone' || tile.lvl === 0 || tile.ab) return null;
  if (!city?.isOwner) return null;
  const info = layers.data?.levels?.[tileKey(x, y)];
  if (!info) return <p className="small muted">Условията ще се изчислят на следващия игрови ден.</p>;
  const nextLvl = tile.lvl + 1;
  const reqs: UpgradeRequirement[] = nextLvl <= 3 ? [...UPGRADE_REQUIREMENTS[tile.z][nextLvl - 2], 'land_value', 'occupancy', 'demand'] : [];
  return (
    <Section title={nextLvl <= 3 ? `Условия за ниво ${nextLvl}` : 'Максимално ниво'}>
      {nextLvl <= 3 ? (
        <ul className="checklist">
          {reqs.map((r) => {
            const ok = !info.next.includes(r);
            const fix = ok ? null : reqTool(r);
            return (
              <li key={r} className={ok ? 'ok' : 'miss'}>
                {ok ? '✔' : '✖'} {REQ_ICON[r]} {UPGRADE_REQUIREMENT_LABELS[r]}
                {fix && (
                  <button className="need-fix" onClick={() => setState({ tool: fix })} title="Изберете инструмента и строете на картата">
                    {reqToolLabel(r)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="small muted">Сградата е на най-високото ниво.</p>
      )}
      {info.next.length === 0 && nextLvl <= 3 && <p className="small">Всички условия са изпълнени – сградата ще се надгради в следващите дни.</p>}
      {info.keep.length > 0 && (
        <p className="small" style={{ color: '#f87171' }}>
          ⚠ Липсват условия за текущото ниво ({info.keep.map((k) => UPGRADE_REQUIREMENT_LABELS[k]).join(', ')}) – сградата губи състояние и ще слезе ниво.
        </p>
      )}
    </Section>
  );
}

export function InspectPanel() {
  const sel = useStore((s) => s.selected);
  const city = useStore((s) => s.city);
  const world = useStore((s) => s.world);
  const tile = sel && city ? (city.tiles as TileMap)[tileKey(sel.x, sel.y)] : undefined;
  const facilityId = tile?.t === 'facility' ? tile.facilityId : null;
  const company = useApi<{
    facilitiesDetail?: {
      id: string;
      type: string;
      staffing: number;
      power: number;
      lastRuns: number;
      limitedBy: string;
      condition: number;
      upgrades: number;
      lastEnergy: number;
    }[];
    name: string;
  }>(tile?.t === 'facility' ? `/companies/${tile.companyId}` : null, [facilityId]);
  if (!sel || !world) return <p className="muted">Кликнете върху плочка с инструмента „Избор“.</p>;
  const t = getWorld(world.seed).tileAt(sel.x, sel.y);
  const f = company.data?.facilitiesDetail?.find((x) => x.id === facilityId);
  const limited: Record<string, string> = {
    none: 'пълен капацитет',
    staff: 'недостиг на персонал',
    power: 'недостиг на ток',
    inputs: 'липсват суровини',
    storage: 'складът е пълен',
    idle: 'не работи',
  };
  return (
    <div>
      <h2>
        Плочка ({sel.x}, {sel.y})
      </h2>
      <div className="grid2">
        <Stat label="Плодородие" value={pct(t.fertility, 0)} />
        <Stat label="Надморска височина" value={t.elevation.toFixed(2)} />
        <Stat label="Находище" value={t.deposit === 'none' ? '—' : `${t.deposit === 'iron' ? 'Желязо' : 'Въглища'} (${pct(t.richness, 0)})`} />
        <Stat label="Риск от наводнение" value={pct(t.floodRisk, 0)} tone={t.floodRisk > 0.3 ? 'warn' : undefined} />
        <Stat label="Климат" value={t.climate === 'arid' ? 'сух' : t.climate === 'cold' ? 'студен' : 'умерен'} />
      </div>
      {tile ? (
        <p>
          <b>{describeTile(tile)}</b>
          {tile.t === 'zone' && tile.lvl > 0 ? ` · състояние ${pct(tile.hp, 0)}` : ''}
          {tile.t === 'service' ? ` · състояние ${pct(tile.cond, 0)}` : ''}
        </p>
      ) : (
        <p className="muted">Празна плочка</p>
      )}
      {city && <UpgradeChecklist cityId={city.id} x={sel.x} y={sel.y} />}
      {f && (
        <Section title={`${FACILITIES[f.type as FacilityType].name} – ${company.data?.name}`}>
          <Meter label="Персонал" value={f.staffing} />
          <Meter label="Ток" value={f.power} color="#facc15" />
          <Meter label="Състояние" value={f.condition} color="#22c55e" />
          <p className="small">
            Последен ден: {f.lastEnergy ? `${f.lastEnergy} ед. енергия` : `${f.lastRuns} цикъла`} · {limited[f.limitedBy] ?? f.limitedBy} · модернизации{' '}
            {f.upgrades}/{BALANCE.company.maxUpgrades}
          </p>
          <AsyncButton
            onClick={async () => {
              await post(`/companies/facilities/${f.id}/upgrade`);
              toast('Модернизирано (+25% капацитет)', 'success');
              company.reload();
            }}
          >
            Модернизирай с {BALANCE.company.machineryUpgradeUnits} машини
          </AsyncButton>
        </Section>
      )}
      <button
        className="btn"
        onClick={() => {
          setState({ panel: 'city' });
          bumpData();
        }}
      >
        Назад
      </button>
    </div>
  );
}
