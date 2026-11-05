import { useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { FormError } from '../components';
import { LoadingRegion, Skeleton } from '../ui';
import type { Dashboard as DashboardData, Money } from '../types';
import { useWorkspace } from '../workspace';
import { STAGE_LABEL } from './Deals';

function money({ value, currency }: Money) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}
// one line per currency: amounts in different currencies are never added together
const moneyLines = (totals: Money[]) => (totals.length === 0 ? ['—'] : totals.map(money));

const dueDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Same grid and cards as the real dashboard, so nothing jumps when the data arrives. */
function DashboardSkeleton() {
  return (
    <LoadingRegion label="Loading the dashboard">
      <div className="dash-stats">
        {[0, 1].map((i) => (
          <div key={i} className="ui-card dash-stat">
            <div className="ui-skeleton-stack">
              <Skeleton width="45%" height="0.8rem" />
              <Skeleton width="60%" height="1.75rem" />
              <Skeleton width="35%" height="0.8rem" />
            </div>
          </div>
        ))}
      </div>
      <div className="ui-card dash-panel">
        <div className="ui-skeleton-stack">
          <Skeleton width="30%" height="0.8rem" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

export function Dashboard() {
  const ws = useWorkspace();
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<DashboardData>(`${ws.base}/dashboard`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err.message : 'Could not load the dashboard');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base]);

  const maxCount = Math.max(1, ...(data?.stages.map((s) => s.count) ?? []));
  const noDeals = data !== null && data.stages.every((s) => s.count === 0);

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <h1>Welcome, {user?.name}</h1>
      </div>
      <FormError message={error} />

      {data === null && !error && <DashboardSkeleton />}
      {data && (
        <>
          <div className="dash-stats">
            <section className="ui-card dash-stat" aria-labelledby="stat-pipeline">
              <h2 id="stat-pipeline">Open pipeline</h2>
              {moneyLines(data.openDeals.totals).map((line) => (
                <p className="dash-stat__value" key={line}>
                  {line}
                </p>
              ))}
              <p className="dash-stat__note ui-muted ui-small">
                {data.openDeals.count} open {data.openDeals.count === 1 ? 'deal' : 'deals'}
              </p>
            </section>
            <section className="ui-card dash-stat" aria-labelledby="stat-overdue">
              <h2 id="stat-overdue">Overdue tasks</h2>
              <p
                className={
                  data.overdueTasks.count > 0 ? 'dash-stat__value ui-overdue' : 'dash-stat__value'
                }
              >
                {data.overdueTasks.count}
              </p>
              <p className="dash-stat__note ui-muted ui-small">
                {data.overdueTasks.count === 0 ? 'You are all caught up' : 'Past their due date'}
              </p>
            </section>
          </div>

          <section className="ui-card dash-panel" aria-labelledby="panel-stages">
            <h2 id="panel-stages">Deals by stage</h2>
            {noDeals ? (
              <p className="ui-empty dash-panel__empty">
                No deals yet. Add one on the Deals page to see your pipeline here.
              </p>
            ) : (
              <ul className="dash-stages">
                {data.stages.map((s, i) => (
                  <li
                    className="dash-stage"
                    data-stage={s.stage}
                    key={s.stage}
                    style={{ '--i': i } as CSSProperties}
                  >
                    <span className="dash-stage__name">{STAGE_LABEL[s.stage]}</span>
                    <span className="dash-stage__bar" aria-hidden="true">
                      <span style={{ width: `${(s.count / maxCount) * 100}%` }} />
                    </span>
                    <span className="dash-stage__count">{s.count}</span>
                    <span className="dash-stage__value ui-muted">
                      {s.totals.length ? s.totals.map(money).join(' · ') : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ui-card dash-panel" aria-labelledby="panel-overdue">
            <h2 id="panel-overdue">Overdue tasks</h2>
            {data.overdueTasks.items.length === 0 ? (
              <p className="ui-empty dash-panel__empty">Nothing overdue.</p>
            ) : (
              <ul className="dash-overdue">
                {data.overdueTasks.items.map((t) => (
                  <li key={t.id}>
                    <p className="dash-overdue__text">{t.content}</p>
                    <p className="dash-overdue__meta">
                      <span className="ui-overdue">Due {dueDate(t.dueAt)}</span>
                      {(t.contactName ?? t.dealTitle) && <> · {t.contactName ?? t.dealTitle}</>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {data.overdueTasks.count > data.overdueTasks.items.length && (
              <p className="ui-muted ui-small">
                and {data.overdueTasks.count - data.overdueTasks.items.length} more
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
