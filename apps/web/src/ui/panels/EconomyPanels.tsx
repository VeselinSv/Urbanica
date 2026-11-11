import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart } from 'recharts';
import { BALANCE, FACILITIES, FACILITY_TYPES, GOODS, GOOD_IDS, TECHS, type FacilityType, type GoodId } from '@gce/shared';
import { del, post } from '../../api';
import { bumpData, refreshAll, refreshCompanies, setState, toast, useStore } from '../../store';
import { KIND_LABELS, RATING_COLOR, money, num, pct, toCents } from '../../format';
import { AsyncButton, Field, Meter, Section, Stat, Table, useApi } from '../common';

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
  return (
    <div>
      <h2>Пазар и търговия</h2>
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
        <div className="row wrap">
          <select value={side} onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')} aria-label="Посока">
            <option value="SELL">Продава</option>
            <option value="BUY">Купува</option>
          </select>
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
        {isGood && (
          <p className="muted small">
            Търгува активната компания ({companies.find((c) => c.id === activeCompanyId)?.name ?? 'няма'}). Продажбата резервира стоката от склада в избрания
            град; покупката резервира пари в ескроу. Доставката между градове отнема време и струва транспорт.
          </p>
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
