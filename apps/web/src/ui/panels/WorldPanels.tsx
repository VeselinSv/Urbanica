import { useEffect, useRef, useState } from 'react';
import { TECHS, TECH_IDS, type TechId } from '@gce/shared';
import { get, post } from '../../api';
import { bumpData, refreshAll, refreshCompanies, setState, toast, useStore } from '../../store';
import { joinChannel, onChat, type ChatMsg } from '../../socket';
import { RATING_COLOR, money, num, pct, toCents } from '../../format';
import { AsyncButton, Field, Section, Stat, Table, useApi } from '../common';

interface CompanyPublic {
  id: string;
  name: string;
  status: string;
  rating: string;
  totalShares: number;
  parentCompanyId: string | null;
  shareholders: { holderType: string; holderId: string; name?: string; shares: number; pct: number }[];
  roles: { userId: string; username?: string; role: string }[];
  valuation: { assets: number; debt: number; equity: number; bookPerShare: number; lastSharePrice: number | null };
  publicReport: { revenue: number; costs: number; profit: number; days: number };
  myRoles: string[];
  myShares: number;
}

interface Proposal {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  result: string | null;
  expiresTick: number;
  votes: { voterId: string; approve: boolean; weight: number }[];
}

const KINDS: Record<string, string> = {
  ISSUE_SHARES: 'Емисия на акции',
  PAY_DIVIDEND: 'Дивидент',
  APPOINT_ROLE: 'Назначаване',
  REMOVE_ROLE: 'Освобождаване',
  MERGE_INTO: 'Сливане',
  SELL_FACILITY: 'Продажба на актив',
  ALLIANCE_KICK: 'Изключване от съюза',
  ALLIANCE_SANCTION: 'Санкции на съюза',
};
const PSTATUS: Record<string, string> = {
  OPEN: 'гласуване',
  PASSED: 'прието',
  EXECUTED: 'изпълнено',
  REJECTED: 'отхвърлено',
  EXPIRED: 'изтекло',
  FAILED: 'неуспешно',
};

function Proposals({ scopeType, scopeId, totalWeight }: { scopeType: 'COMPANY' | 'ALLIANCE'; scopeId: string; totalWeight: number }) {
  const list = useApi<Proposal[]>(`/proposals?scopeType=${scopeType}&scopeId=${scopeId}`, [scopeId]);
  return (
    <Table
      head={['Предложение', 'За/против', 'Статус', '']}
      rows={(list.data ?? []).map((p) => {
        const yes = p.votes.filter((v) => v.approve).reduce((a, v) => a + v.weight, 0);
        const no = p.votes.filter((v) => !v.approve).reduce((a, v) => a + v.weight, 0);
        return [
          `${KINDS[p.kind] ?? p.kind}: ${JSON.stringify(p.payload).slice(0, 60)}`,
          `${pct(yes / Math.max(1, totalWeight), 0)} / ${pct(no / Math.max(1, totalWeight), 0)}`,
          `${PSTATUS[p.status] ?? p.status}${p.result ? ` – ${p.result}` : ''}`,
          p.status === 'OPEN' ? (
            <span className="row">
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  await post(`/proposals/${p.id}/vote`, { approve: true });
                  list.reload();
                  bumpData();
                }}
              >
                За
              </AsyncButton>
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  await post(`/proposals/${p.id}/vote`, { approve: false });
                  list.reload();
                }}
              >
                Против
              </AsyncButton>
            </span>
          ) : (
            ''
          ),
        ];
      })}
      empty="Няма предложения"
    />
  );
}

export function CorpPanel() {
  const all =
    useApi<{ id: string; name: string; founder: string; status: string; rating: string; totalShares: number; parentCompanyId: string | null }[]>('/companies');
  const [sel, setSel] = useState<string>('');
  const id = sel || all.data?.[0]?.id || '';
  const c = useApi<CompanyPublic>(id ? `/companies/${id}` : null, [id]);
  const users = useApi<{ id: string; username: string }[]>('/social/users');
  const companies = useStore((s) => s.companies);
  const [kind, setKind] = useState('PAY_DIVIDEND');
  const [form, setForm] = useState<Record<string, string>>({
    amountPerShare: '1',
    shares: '1000',
    pricePerShare: '5',
    role: 'MANAGER',
    userId: '',
    targetCompanyId: '',
    ratio: '1',
    facilityId: '',
  });
  const [trade, setTrade] = useState({ side: 'BUY', qty: '100', price: '5', as: '' });
  const d = c.data;
  return (
    <div>
      <h2>Корпорации, акции и управление</h2>
      <Field label="Компания">
        <select value={id} onChange={(e) => setSel(e.target.value)}>
          {(all.data ?? []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {x.founder} · {x.status}
            </option>
          ))}
        </select>
      </Field>
      {d && (
        <>
          <div className="grid2">
            <Stat label="Балансова стойност/акция" value={money(d.valuation.bookPerShare)} />
            <Stat label="Последна цена" value={money(d.valuation.lastSharePrice)} />
            <Stat label="Собствен капитал" value={money(d.valuation.equity)} />
            <Stat label="Рейтинг" value={<span style={{ color: RATING_COLOR[d.rating] }}>{d.rating}</span>} />
            <Stat label="Публичен отчет (30 дни): приходи" value={money(d.publicReport.revenue)} />
            <Stat label="Печалба (паричен поток)" value={money(d.publicReport.profit)} tone={d.publicReport.profit < 0 ? 'bad' : 'good'} />
          </div>
          {d.parentCompanyId && <p className="small">Дъщерно дружество на {all.data?.find((x) => x.id === d.parentCompanyId)?.name ?? d.parentCompanyId}</p>}
          <Section title="Акционери">
            <Table
              head={['Акционер', 'Акции', '%']}
              rows={d.shareholders.map((h) => [`${h.name ?? h.holderId}${h.holderType === 'COMPANY' ? ' (компания)' : ''}`, num(h.shares), `${h.pct}%`])}
            />
          </Section>
          <Section title="Ръководство">
            <div className="chips">
              {d.roles.map((r) => (
                <span key={r.userId + r.role} className="chip">
                  {r.username}: {r.role}
                </span>
              ))}
            </div>
            <p className="muted small">
              Акционерите гласуват с тежест по брой акции (прието при над 50%). CEO управлява операциите, кредитите и изследванията; мениджърите – операциите и
              търговията; бордът внася предложения.
            </p>
          </Section>
          <Section title="Предложения и гласуване">
            <Proposals scopeType="COMPANY" scopeId={d.id} totalWeight={d.totalShares} />
            {(d.myShares > 0 || d.myRoles.length > 0) && (
              <div className="form-grid">
                <Field label="Вид">
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>
                    {['PAY_DIVIDEND', 'ISSUE_SHARES', 'APPOINT_ROLE', 'REMOVE_ROLE', 'SELL_FACILITY', 'MERGE_INTO'].map((k) => (
                      <option key={k} value={k}>
                        {KINDS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                {kind === 'PAY_DIVIDEND' && (
                  <Field label="Дивидент на акция (€)">
                    <input type="number" step={0.01} value={form.amountPerShare} onChange={(e) => setForm({ ...form, amountPerShare: e.target.value })} />
                  </Field>
                )}
                {kind === 'ISSUE_SHARES' && (
                  <>
                    <Field label="Нови акции (записвате вие)">
                      <input type="number" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} />
                    </Field>
                    <Field label="Цена/акция (€)">
                      <input type="number" step={0.01} value={form.pricePerShare} onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })} />
                    </Field>
                  </>
                )}
                {(kind === 'APPOINT_ROLE' || kind === 'REMOVE_ROLE') && (
                  <>
                    <Field label="Потребител">
                      <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                        <option value="">—</option>
                        {(users.data ?? []).map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Роля">
                      <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                        <option>CEO</option>
                        <option>MANAGER</option>
                        <option>BOARD</option>
                      </select>
                    </Field>
                  </>
                )}
                {kind === 'SELL_FACILITY' && (
                  <Field label="ID на съоръжение">
                    <input value={form.facilityId} onChange={(e) => setForm({ ...form, facilityId: e.target.value })} />
                  </Field>
                )}
                {kind === 'MERGE_INTO' && (
                  <>
                    <Field label="Приемаща компания">
                      <select value={form.targetCompanyId} onChange={(e) => setForm({ ...form, targetCompanyId: e.target.value })}>
                        <option value="">—</option>
                        {(all.data ?? [])
                          .filter((x) => x.id !== d.id)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Акции на приемащата за 1 акция">
                      <input type="number" step={0.01} value={form.ratio} onChange={(e) => setForm({ ...form, ratio: e.target.value })} />
                    </Field>
                  </>
                )}
              </div>
            )}
            {(d.myShares > 0 || d.myRoles.length > 0) && (
              <AsyncButton
                className="btn primary"
                onClick={async () => {
                  const payload: Record<string, unknown> =
                    kind === 'PAY_DIVIDEND'
                      ? { amountPerShare: toCents(Number(form.amountPerShare)) }
                      : kind === 'ISSUE_SHARES'
                        ? { shares: Number(form.shares), pricePerShare: toCents(Number(form.pricePerShare)) }
                        : kind === 'SELL_FACILITY'
                          ? { facilityId: form.facilityId }
                          : kind === 'MERGE_INTO'
                            ? { targetCompanyId: form.targetCompanyId, ratio: Number(form.ratio) }
                            : { userId: form.userId, role: form.role };
                  const p = await post<Proposal>('/proposals', { scopeType: 'COMPANY', scopeId: d.id, kind, payload });
                  toast(`Предложението е ${PSTATUS[p.status] ?? p.status}${p.result ? `: ${p.result}` : ''}`, p.status === 'FAILED' ? 'error' : 'success');
                  c.reload();
                  await refreshAll();
                }}
              >
                Внеси предложение
              </AsyncButton>
            )}
          </Section>
          <Section title="Търговия с акции">
            <div className="row wrap">
              <select value={trade.side} onChange={(e) => setTrade({ ...trade, side: e.target.value })} aria-label="Посока">
                <option value="BUY">Купува</option>
                <option value="SELL">Продава</option>
              </select>
              <input
                type="number"
                value={trade.qty}
                onChange={(e) => setTrade({ ...trade, qty: e.target.value })}
                aria-label="Брой акции"
                style={{ width: 80 }}
              />
              <input
                type="number"
                step={0.01}
                value={trade.price}
                onChange={(e) => setTrade({ ...trade, price: e.target.value })}
                aria-label="Цена €"
                style={{ width: 80 }}
              />
              <select value={trade.as} onChange={(e) => setTrade({ ...trade, as: e.target.value })} aria-label="Търгува като">
                <option value="">Личен портфейл</option>
                {companies
                  .filter((x) => x.roles.length && x.id !== d.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
              <AsyncButton
                className="btn primary"
                onClick={async () => {
                  const r = await post<{ fills: { quantity: number }[] }>(
                    '/market/orders',
                    {
                      instrument: `SHARE:${d.id}`,
                      side: trade.side,
                      quantity: Number(trade.qty),
                      price: toCents(Number(trade.price)),
                      companyId: trade.as || undefined,
                    },
                    true,
                  );
                  toast(`Поръчката е приета (изпълнени ${r.fills.reduce((a, f) => a + f.quantity, 0)})`, 'success');
                  c.reload();
                  await refreshCompanies();
                  await refreshAll();
                }}
              >
                Изпрати
              </AsyncButton>
            </div>
            <p className="muted small">
              Компания, натрупала над 50% от акциите на друга, става нейна компания-майка (придобиване). Акциите са виртуални игрови активи без реална стойност.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

export function TechPanel() {
  const techs = useApi<
    ((typeof TECHS)[TechId] & {
      patent: { id: string; owner: string | null; ownerCompanyId: string | null; public: boolean; licenseFee: number; expiresTick: number } | null;
      researchers: number;
    })[]
  >('/tech');
  const activeCompanyId = useStore((s) => s.activeCompanyId);
  const companies = useStore((s) => s.companies);
  const city = useStore((s) => s.city);
  const [fee, setFee] = useState<Record<string, string>>({});
  const mine = new Set(companies.filter((c) => c.roles.length).map((c) => c.id));
  return (
    <div>
      <h2>Иновации, патенти и лицензи</h2>
      <p className="muted small">
        Изследванията струват пари всеки ден и отнемат време; университет в седалището ги ускорява с 50%. Първият завършил получава патент за 1 година и може да
        лицензира технологията срещу дневна такса. Публично финансираните изследвания (от град с университет) стават обществено достояние.
      </p>
      {(techs.data ?? []).map((t) => {
        const p = t.patent;
        const owned = p?.ownerCompanyId && mine.has(p.ownerCompanyId);
        return (
          <div key={t.id} className="card">
            <div className="row between">
              <b>{t.name}</b>
              <span className="small muted">
                {t.days} дни · {money(t.dailyCost)}/ден
              </span>
            </div>
            <p className="small">
              {t.description}
              {t.alternatives.length ? ` · алтернатива: ${t.alternatives.map((a) => TECHS[a].name).join(', ')}` : ''}
            </p>
            {p ? (
              <p className="small">{p.public ? 'Обществено достояние' : `Патент: ${p.owner} (до ден ${p.expiresTick}) · лиценз ${money(p.licenseFee)}/ден`}</p>
            ) : (
              <p className="small muted">Не е патентована · изследват я {t.researchers} компании</p>
            )}
            <div className="row wrap">
              {!p && activeCompanyId && (
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/companies/${activeCompanyId}/research`, { techId: t.id });
                    toast('Изследването започна', 'success');
                    techs.reload();
                  }}
                >
                  Изследвай (компания)
                </AsyncButton>
              )}
              {!p && city?.isOwner && (
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/cities/${city.id}/public-research`, { techId: t.id });
                    toast('Публичното изследване започна', 'success');
                    techs.reload();
                  }}
                >
                  Публично изследване (град)
                </AsyncButton>
              )}
              {p && !p.public && !owned && activeCompanyId && (
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post(`/tech/patents/${p.id}/license`, { companyId: activeCompanyId });
                    toast('Лицензът е активен', 'success');
                  }}
                >
                  Лицензирай
                </AsyncButton>
              )}
              {p && owned && (
                <>
                  <input
                    type="number"
                    step={0.01}
                    placeholder="такса €/ден"
                    value={fee[p.id] ?? ''}
                    onChange={(e) => setFee({ ...fee, [p.id]: e.target.value })}
                    style={{ width: 110 }}
                    aria-label="Лицензионна такса"
                  />
                  <AsyncButton
                    className="btn small"
                    onClick={async () => {
                      await post(`/tech/patents/${p.id}/fee`, { dailyFee: toCents(Number(fee[p.id] || 0)) });
                      techs.reload();
                    }}
                  >
                    Задай такса
                  </AsyncButton>
                </>
              )}
            </div>
          </div>
        );
      })}
      <p className="muted small">
        Технологии в играта: {TECH_IDS.length}. Ефектите (по-висок добив, по-малко персонал, по-евтин транспорт, по-малко замърсяване) се прилагат автоматично в
        симулацията.
      </p>
    </div>
  );
}

export function DiplomacyPanel() {
  const data = useApi<{
    myAllianceId: string | null;
    myRole: string | null;
    invites: { id: string; allianceName?: string }[];
    alliances: {
      id: string;
      name: string;
      description: string;
      members: { userId: string; username?: string; role: string }[];
      sanctions: { userId: string; username: string }[];
    }[];
  }>('/alliances');
  const users = useApi<{ id: string; username: string }[]>('/social/users');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [invite, setInvite] = useState('');
  const [target, setTarget] = useState('');
  const d = data.data;
  const mine = d?.alliances.find((a) => a.id === d.myAllianceId);
  return (
    <div>
      <h2>Икономическа дипломация</h2>
      <p className="muted small">
        Членовете на един съюз образуват търговски блок: не плащат мита помежду си и могат да строят предприятия в градовете си. Съюзът гласува санкции (забрана
        за търговия) и изключване на членове.
      </p>
      {d?.invites.map((i) => (
        <div key={i.id} className="callout">
          Покана от „{i.allianceName}“{' '}
          <AsyncButton
            className="btn small"
            onClick={async () => {
              await post(`/alliances/invites/${i.id}/accept`);
              data.reload();
            }}
          >
            Приеми
          </AsyncButton>
          <AsyncButton
            className="btn small"
            onClick={async () => {
              await post(`/alliances/invites/${i.id}/decline`);
              data.reload();
            }}
          >
            Откажи
          </AsyncButton>
        </div>
      ))}
      {mine ? (
        <Section
          title={`Моят съюз: ${mine.name}`}
          right={
            <AsyncButton
              className="btn small"
              onClick={async () => {
                await post('/alliances/leave');
                data.reload();
              }}
            >
              Напусни
            </AsyncButton>
          }
        >
          <p className="small">{mine.description}</p>
          <div className="chips">
            {mine.members.map((m) => (
              <span key={m.userId} className="chip">
                {m.username} {m.role === 'LEADER' ? '★' : ''}
              </span>
            ))}
          </div>
          {d?.myRole === 'LEADER' && (
            <div className="row">
              <input placeholder="Потребителско име" value={invite} onChange={(e) => setInvite(e.target.value)} aria-label="Покани потребител" />
              <AsyncButton
                className="btn small"
                onClick={async () => {
                  await post(`/alliances/${mine.id}/invite`, { username: invite });
                  setInvite('');
                  toast('Поканата е изпратена', 'success');
                }}
              >
                Покани
              </AsyncButton>
            </div>
          )}
          <Section title="Санкции на съюза">
            <div className="chips">
              {mine.sanctions.map((s) => (
                <span key={s.userId} className="chip">
                  {s.username}
                </span>
              ))}
            </div>
            <div className="row">
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Цел на санкцията">
                <option value="">—</option>
                {(users.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
              <AsyncButton
                className="btn small"
                disabled={!target}
                onClick={async () => {
                  await post('/proposals', { scopeType: 'ALLIANCE', scopeId: mine.id, kind: 'ALLIANCE_SANCTION', payload: { targetUserId: target, on: true } });
                  data.reload();
                }}
              >
                Предложи санкция
              </AsyncButton>
            </div>
            <Proposals scopeType="ALLIANCE" scopeId={mine.id} totalWeight={mine.members.length} />
          </Section>
        </Section>
      ) : (
        <Section title="Създай съюз">
          <div className="row wrap">
            <input placeholder="Име" value={name} onChange={(e) => setName(e.target.value)} aria-label="Име на съюза" />
            <input placeholder="Описание" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Описание" />
            <AsyncButton
              className="btn primary"
              disabled={name.trim().length < 2}
              onClick={async () => {
                await post('/alliances', { name, description: desc });
                data.reload();
              }}
            >
              Създай
            </AsyncButton>
          </div>
        </Section>
      )}
      <Section title="Всички съюзи">
        <Table
          head={['Съюз', 'Членове', 'Санкции']}
          rows={(d?.alliances ?? []).map((a) => [a.name, a.members.map((m) => m.username).join(', '), a.sanctions.length])}
          empty="Няма съюзи"
        />
      </Section>
      <p className="muted small">Митата и санкциите на ниво град се задават в панела „Финанси“.</p>
    </div>
  );
}

export function AnalyticsPanel() {
  const o = useApi<{
    tick: number;
    baseRate: number;
    priceIndex: number;
    creditOutstanding: number;
    moneyCreated: number;
    population: number;
    gdp: number;
    cities: number;
    companies: number;
    players: number;
    feesCollected: number;
    sim: { avgTickMs: number };
  }>('/analytics/overview');
  const lb = useApi<{ userId: string; username: string; netWorth: number; population: number; cities: number }[]>('/analytics/leaderboard');
  const d = o.data;
  return (
    <div>
      <h2>Световна икономика</h2>
      {d && (
        <div className="grid2">
          <Stat label="Население на света" value={num(d.population)} />
          <Stat label="Световен БВП/ден" value={money(d.gdp)} />
          <Stat label="Ценови индекс" value={d.priceIndex.toFixed(3)} tone={d.priceIndex > 1.3 ? 'bad' : undefined} />
          <Stat label="Базова лихва" value={pct(d.baseRate, 2)} />
          <Stat label="Кредити в обращение" value={money(d.creditOutstanding)} />
          <Stat label="Емитирани пари" value={money(d.moneyCreated)} />
          <Stat label="Изтеглени чрез такси" value={money(d.feesCollected)} />
          <Stat label="Градове / компании / играчи" value={`${d.cities} / ${d.companies} / ${d.players}`} />
          <Stat label="Средна обработка на тик" value={`${d.sim.avgTickMs} ms`} />
        </div>
      )}
      <Section title="Класация (нетна стойност: портфейл + акции по балансова стойност)">
        <Table
          head={['#', 'Играч', 'Нетна стойност', 'Население', 'Градове']}
          rows={(lb.data ?? []).map((r, i) => [i + 1, r.username, money(r.netWorth), num(r.population), r.cities])}
        />
      </Section>
      <p className="muted small">
        Подробни графики: „Население“ (с прогноза), „Финанси“ (бюджет), „Пазар“ (история на цените), „Компании“ (приходи/разходи и инвестиционен симулатор).
      </p>
    </div>
  );
}

export function ChatPanel() {
  const me = useStore((s) => s.me);
  const companies = useStore((s) => s.companies);
  const [channel, setChannel] = useState('global');
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const users = useApi<{ id: string; username: string }[]>('/social/users');
  const alliances = useApi<{ myAllianceId: string | null }>('/alliances');
  const box = useRef<HTMLDivElement>(null);
  const norm = (ch: string) =>
    ch.startsWith('dm:') && me ? (me.user.id < ch.slice(3) ? `dm:${me.user.id}:${ch.slice(3)}` : `dm:${ch.slice(3)}:${me.user.id}`) : ch;
  useEffect(() => {
    let alive = true;
    get<ChatMsg[]>(`/social/chat?channel=${encodeURIComponent(channel)}`)
      .then((m) => alive && setMsgs(m))
      .catch(() => setMsgs([]));
    if (channel.startsWith('company:') || channel.startsWith('alliance:')) joinChannel(channel);
    const off = onChat((m) => {
      if (m.channel === norm(channel)) setMsgs((x) => [...x.slice(-199), m]);
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [msgs]);
  return (
    <div className="chat">
      <h2>Комуникация</h2>
      <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Канал">
        <option value="global">Общ чат</option>
        {companies.map((c) => (
          <option key={c.id} value={`company:${c.id}`}>
            Компания: {c.name}
          </option>
        ))}
        {alliances.data?.myAllianceId && <option value={`alliance:${alliances.data.myAllianceId}`}>Съюз</option>}
        {(users.data ?? [])
          .filter((u) => u.id !== me?.user.id)
          .map((u) => (
            <option key={u.id} value={`dm:${u.id}`}>
              Лично: {u.username}
            </option>
          ))}
      </select>
      <div className="chat-box" ref={box}>
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.senderId === me?.user.id ? 'mine' : ''}`}>
            <b>{m.senderName}</b> <span>{m.body}</span>
            {m.senderId !== me?.user.id && (
              <span className="msg-actions">
                <button
                  className="link small"
                  title="Блокирай"
                  onClick={async () => {
                    await post(`/social/block/${m.senderId}`, { on: true });
                    toast('Потребителят е блокиран', 'info');
                  }}
                >
                  ⛔
                </button>
                <button
                  className="link small"
                  title="Докладвай"
                  onClick={async () => {
                    await post('/social/report', { userId: m.senderId, reason: `Съобщение: ${m.body.slice(0, 200)}`, messageId: m.id });
                    toast('Докладвано на модераторите', 'info');
                  }}
                >
                  ⚑
                </button>
              </span>
            )}
          </div>
        ))}
        {!msgs.length && <p className="muted">Няма съобщения</p>}
      </div>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          try {
            await post('/social/chat', { channel, body: text.trim() });
            setText('');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Съобщение… (не споделяйте лични данни)"
          aria-label="Съобщение"
        />
        <button className="btn primary" type="submit">
          Изпрати
        </button>
      </form>
      <Friends />
    </div>
  );
}

function Friends() {
  const f = useApi<{ userId: string; username?: string; status: string; incoming: boolean; online: boolean }[]>('/social/friends');
  const [u, setU] = useState('');
  return (
    <Section title="Приятели">
      <div className="chips">
        {(f.data ?? []).map((x) => (
          <span key={x.userId} className="chip">
            {x.online ? '🟢' : '⚪'} {x.username}{' '}
            {x.status === 'PENDING' ? (
              x.incoming ? (
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await post('/social/friends', { username: x.username });
                    f.reload();
                  }}
                >
                  Приеми
                </AsyncButton>
              ) : (
                '(чака)'
              )
            ) : (
              ''
            )}
          </span>
        ))}
      </div>
      <div className="row">
        <input placeholder="Потребителско име" value={u} onChange={(e) => setU(e.target.value)} aria-label="Добави приятел" />
        <AsyncButton
          className="btn small"
          onClick={async () => {
            await post('/social/friends', { username: u });
            setU('');
            f.reload();
          }}
        >
          Добави
        </AsyncButton>
      </div>
    </Section>
  );
}

export function EventsPanel() {
  const n = useApi<{ id: string; kind: string; message: string; read: boolean; createdAt: string }[]>('/social/notifications');
  const news = useApi<{ id: string; tick: number; kind: string; message: string }[]>('/news');
  useEffect(() => {
    void post('/social/notifications/read').then(() => setState({ unread: 0 }));
  }, []);
  return (
    <div>
      <h2>Известия и новини</h2>
      <Section title="Моите известия">
        <ul className="list">
          {(n.data ?? []).map((x) => (
            <li key={x.id} className={x.read ? '' : 'unread'}>
              <small>{new Date(x.createdAt).toLocaleTimeString('bg-BG')}</small> {x.message}
            </li>
          ))}
        </ul>
        {!n.data?.length && <p className="muted">Няма известия</p>}
      </Section>
      <Section title="Световни новини">
        <ul className="list">
          {(news.data ?? []).map((x) => (
            <li key={x.id}>
              <small>ден {x.tick}</small> {x.message}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
