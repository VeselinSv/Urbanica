import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { get } from '../api';
import { errorToast, useDataVersion } from '../store';

/** Зарежда данни от API и ги презарежда при нов игрови тик/промяна. */
export function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | null; loading: boolean; reload: () => void; error: string | null } {
  const version = useDataVersion();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    get<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, loading, reload, error };
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function Meter({ label, value, max = 1, color, text }: { label: string; value: number; max?: number; color?: string; text?: string }) {
  const p = Math.max(0, Math.min(1, value / max));
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div className="meter-head">
        <span>{label}</span>
        <span>{text ?? `${Math.round(p * 100)}%`}</span>
      </div>
      <div className="meter-bar">
        <div style={{ width: `${p * 100}%`, background: color ?? 'var(--accent)' }} />
      </div>
    </div>
  );
}

/** Търсене по зона: от -1 до +1, центрирано. */
export function DemandBar({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Math.max(-1, Math.min(1, value));
  return (
    <div className="demand" title={`${label}: ${(v * 100).toFixed(0)}`}>
      <div className="demand-track">
        <div
          className="demand-fill"
          style={{ height: `${Math.abs(v) * 50}%`, background: v >= 0 ? color : '#ef4444', bottom: v >= 0 ? '50%' : undefined, top: v < 0 ? '50%' : undefined }}
        />
      </div>
      <span>{label}</span>
    </div>
  );
}

export function AsyncButton({
  onClick,
  children,
  className,
  disabled,
  title,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className ?? 'btn'}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (e) {
          errorToast(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : children}
    </button>
  );
}

export function Table({ head, rows, empty }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty ?? 'Няма данни'}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Сгъваемо обяснение „Как работи?“ – кратки стъпки в самата игра. */
export function HowTo({ title = "Как работи?", steps }: { title?: string; steps: ReactNode[] }) {
  return (
    <details className="callout help">
      <summary>
        <b>{title}</b> (кликнете)
      </summary>
      <ol className="small">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

export interface GuideStep {
  label: string;
  done: boolean;
  /** какво точно да направите и защо (показва се за текущата стъпка) */
  hint: string;
  action?: { label: string; run: () => void };
}

/**
 * Стъпки за една функционалност (като плана на града): докъде сте стигнали, какво е следващото и бутон за него.
 * Когато всички стъпки са изпълнени, се показва кратко „✓ готово“ и съвет как да продължите.
 */
export function FeatureGuide({ title, steps, done }: { title: string; steps: GuideStep[]; done?: string }) {
  const next = steps.findIndex((s) => !s.done);
  const finished = steps.filter((s) => s.done).length;
  return (
    <div className="feature-guide">
      <div className="fg-head">
        <b>{title}</b>
        <span className="small muted">
          {finished}/{steps.length}
        </span>
      </div>
      <div className="fg-bar">
        <i style={{ width: `${(finished / steps.length) * 100}%` }} />
      </div>
      {next >= 0 ? (
        <div className="fg-next">
          <span className="small">
            <b>
              Стъпка {next + 1}: {steps[next].label}
            </b>{' '}
            – {steps[next].hint}
          </span>
          {steps[next].action && (
            <button className="btn primary small" onClick={steps[next].action!.run}>
              {steps[next].action!.label}
            </button>
          )}
        </div>
      ) : (
        <div className="small good">✓ {done ?? 'Всички стъпки са изпълнени.'}</div>
      )}
      <ol className="fg-steps small">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'done' : i === next ? 'cur' : ''}>
            {s.done ? '✓' : i === next ? '▶' : '○'} {s.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
