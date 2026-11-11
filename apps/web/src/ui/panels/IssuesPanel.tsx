import { ISSUE_TYPES } from '@gce/shared';
import { post } from '../../api';
import { bumpData, getState, refreshCity, refreshIssues, setState, toast, useStore, type Issue } from '../../store';
import { money } from '../../format';
import { AsyncButton, Section } from '../common';

const SEVERITY = ['', 'Лек', 'Сериозен', 'Критичен'];

export function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2);
}

/** Карта на един сигнал – подател, оплакване, степен, бутон за ремонтен екип. */
export function IssueCard({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const tick = useStore((s) => s.tick);
  const selected = useStore((s) => s.selectedIssue === issue.id);
  const def = ISSUE_TYPES[issue.kind];
  const age = Math.max(0, tick - issue.createdTick);
  return (
    <article className={`issue sev${issue.severity} ${issue.status === 'FIXING' ? 'fixing' : ''} ${selected ? 'selected' : ''}`}>
      <div className="issue-head">
        <span className="issue-icon" aria-hidden>
          {def?.icon ?? '❗'}
        </span>
        <div className="issue-title">
          <b>{def?.name ?? issue.kind}</b>
          <span className="small muted">
            {SEVERITY[issue.severity]} · преди {age} {age === 1 ? 'ден' : 'дни'}
          </span>
        </div>
        <button
          className="btn small ghost"
          title="Покажи на картата"
          onClick={() => setState({ focus: { x: issue.x, y: issue.y, n: Date.now() }, selectedIssue: issue.id })}
        >
          📍
        </button>
      </div>
      {!compact && (
        <blockquote className="issue-quote">
          <span className="avatar">{initials(issue.reporter)}</span>
          <span>
            „{issue.message}“<cite>— {issue.reporter}</cite>
          </span>
        </blockquote>
      )}
      {issue.status === 'FIXING' ? (
        <p className="small fixing-note">🔧 Екипът работи · готово до ден {issue.fixDoneTick}</p>
      ) : issue.status === 'OPEN' ? (
        <AsyncButton
          className="btn primary small"
          onClick={async () => {
            await post(`/cities/${getState().activeCityId}/issues/${issue.id}/fix`, {}, true);
            toast(`Изпратен е екип: ${def?.name ?? ''}`, 'success');
            await Promise.all([refreshIssues(), refreshCity()]);
            bumpData();
          }}
        >
          🚧 Изпрати екип · {money(issue.fixCost)}
        </AsyncButton>
      ) : (
        <p className="small muted">✔ Отстранено{issue.resolvedBy === 'AUTO' ? ' (отшумя само)' : ''}</p>
      )}
    </article>
  );
}

export function IssuesPanel() {
  const city = useStore((s) => s.city);
  const issues = useStore((s) => s.issues);
  const recent = useStore((s) => s.recentIssues);
  if (!city) return <p className="muted">Изберете град.</p>;
  if (!city.isOwner) return <p className="muted">Сигналите на гражданите вижда само кметът.</p>;
  const open = issues.filter((i) => i.status === 'OPEN');
  const fixing = issues.filter((i) => i.status === 'FIXING');
  const totalCost = open.reduce((a, i) => a + i.fixCost, 0);
  return (
    <div>
      <h2>🚨 Сигнали от гражданите</h2>
      <p className="small muted">
        Гражданите докладват проблеми – дупки, аварии, боклук, катастрофи. Докато не са отстранени, те дразнят хората, вредят на мрежите и спират надграждането
        на сградите наоколо. Пренебрегнатите проблеми се влошават.
      </p>
      {open.length === 0 && fixing.length === 0 && <div className="callout good">Няма нерешени сигнали. Гражданите са доволни от поддръжката.</div>}
      {open.length > 1 && (
        <AsyncButton
          className="btn"
          onClick={async () => {
            for (const i of open) await post(`/cities/${city.id}/issues/${i.id}/fix`, {}, true).catch(() => undefined);
            toast(`Изпратени екипи по ${open.length} сигнала`, 'success');
            await Promise.all([refreshIssues(), refreshCity()]);
            bumpData();
          }}
        >
          🚧 Изпрати екипи навсякъде · {money(totalCost)}
        </AsyncButton>
      )}
      <div className="issue-list">
        {open.map((i) => (
          <IssueCard key={i.id} issue={i} />
        ))}
        {fixing.map((i) => (
          <IssueCard key={i.id} issue={i} />
        ))}
      </div>
      {recent.length > 0 && (
        <Section title="Наскоро отстранени">
          <div className="issue-list">
            {recent.slice(0, 6).map((i) => (
              <IssueCard key={i.id} issue={i} compact />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
