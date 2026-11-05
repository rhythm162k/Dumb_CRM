import {
  useEffect,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type FormEvent,
} from 'react';
import { ACTIVITY_TYPES, createActivitySchema, type ActivityType } from '@crm/shared';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { Field, FormError } from './components';
import type { Page } from './types';
import { Select, Skeleton, TextArea, useConfirm, useToast } from './ui';
import { useWorkspace } from './workspace';

interface Activity {
  id: string;
  type: ActivityType;
  content: string;
  dueAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

const LABELS: Record<ActivityType, string> = {
  note: 'Note',
  call: 'Call',
  meeting: 'Meeting',
  task: 'Task',
};

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Notes, calls, meetings and tasks for one contact or one deal. */
export function ActivityTimeline({ contactId, dealId }: { contactId?: string; dealId?: string }) {
  const ws = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const { user } = useAuth();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<ActivityType>('note');
  const [busy, setBusy] = useState(false);
  // ids of entries that are fading in, and of deleted entries that are fading out
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const filter = contactId ? `contactId=${contactId}` : `dealId=${dealId ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    api<Page<Activity>>(`${ws.base}/activities?${filter}&limit=100`)
      .then((d) => {
        if (!cancelled) setItems(d.items);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err.message : 'Could not load the timeline');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base, filter]);

  // safety net: if a fade-out never reports animationend, drop the entries anyway
  useEffect(() => {
    if (leaving.size === 0) return;
    const timer = window.setTimeout(() => {
      setItems((cur) => cur?.filter((x) => !leaving.has(x.id)) ?? cur);
      setLeaving(new Set());
    }, 800);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  function onSlotAnimationEnd(e: ReactAnimationEvent<HTMLLIElement>, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.animationName === 'activity-leave') {
      setItems((cur) => cur?.filter((x) => x.id !== id) ?? cur);
      setLeaving((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    } else if (e.animationName === 'activity-in') {
      setEntering((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const due = String(f.get('dueAt') ?? '');
    const parsed = createActivitySchema.safeParse({
      type,
      content: String(f.get('content') ?? ''),
      dueAt: type === 'task' && due ? new Date(due).toISOString() : null,
      contactId: contactId ?? null,
      dealId: dealId ?? null,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the form');
    setBusy(true);
    setError(null);
    try {
      const { activity } = await api<{ activity: Activity }>(`${ws.base}/activities`, {
        method: 'POST',
        body: parsed.data,
      });
      setEntering((cur) => new Set(cur).add(activity.id));
      setItems((cur) => [activity, ...(cur ?? [])]);
      form.reset();
      setType('note');
      toast('Entry added');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(a: Activity) {
    try {
      const { activity } = await api<{ activity: Activity }>(`${ws.base}/activities/${a.id}`, {
        method: 'PATCH',
        body: { completed: !a.completedAt },
      });
      setItems((cur) => cur?.map((x) => (x.id === a.id ? activity : x)) ?? cur);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the task');
    }
  }

  async function remove(a: Activity) {
    const ok = await confirm({
      title: 'Delete this entry?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`${ws.base}/activities/${a.id}`, { method: 'DELETE' });
      // the entry fades out and collapses; it is removed from the list when that animation ends
      setLeaving((cur) => new Set(cur).add(a.id));
      toast('Entry deleted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the entry');
    }
  }

  return (
    <section className="activity-timeline" aria-label="Activity">
      <h3>Activity</h3>

      {ws.can('data:write') && (
        <form className="activity-composer" onSubmit={onSubmit} noValidate>
          <div className="activity-composer__row">
            <Select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as ActivityType)}
            >
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LABELS[t]}
                </option>
              ))}
            </Select>
            {type === 'task' && <Field label="Due (optional)" name="dueAt" type="datetime-local" />}
          </div>
          <TextArea
            label={type === 'task' ? 'What needs doing?' : 'What happened?'}
            name="content"
            rows={2}
            maxLength={5000}
          />
          <div className="ui-actions ui-actions--static">
            <button
              className="ui-btn ui-btn--primary ui-btn--sm"
              disabled={busy}
              data-busy={busy || undefined}
            >
              {busy ? 'Adding…' : `Add ${LABELS[type].toLowerCase()}`}
            </button>
          </div>
        </form>
      )}
      <FormError message={error} />

      {items === null && !error && (
        <div role="status" aria-busy="true">
          <span className="ui-sr-only">Loading activity</span>
          <div className="ui-skeleton-stack" aria-hidden="true">
            <Skeleton block />
            <Skeleton block />
          </div>
        </div>
      )}
      {items && items.length === 0 && <p className="ui-muted ui-small">Nothing logged yet.</p>}
      <ul className="activity-list">
        {items?.map((a) => {
          const done = a.completedAt !== null;
          const overdue =
            a.type === 'task' && !done && a.dueAt !== null && new Date(a.dueAt) < new Date();
          return (
            <li
              key={a.id}
              className="activity-slot"
              data-state={leaving.has(a.id) ? 'leaving' : undefined}
              data-enter={entering.has(a.id) || undefined}
              onAnimationEnd={(e) => onSlotAnimationEnd(e, a.id)}
            >
              <div className="activity-slot__inner">
                <div className="activity-item" data-done={done}>
                  {a.type === 'task' ? (
                    <label className="activity-check-box">
                      <input
                        type="checkbox"
                        className="activity-check"
                        checked={done}
                        disabled={!ws.can('data:write')}
                        onChange={() => void toggle(a)}
                        aria-label={done ? 'Mark as not done' : 'Mark as done'}
                      />
                    </label>
                  ) : (
                    <span className="activity-check-spacer" aria-hidden="true" />
                  )}
                  <div className="activity-main">
                    <div className="activity-meta">
                      <span className="activity-type" data-type={a.type}>
                        {LABELS[a.type]}
                      </span>
                      <span className="ui-muted ui-small">
                        {a.createdByName ?? 'Someone'} · {ago(a.createdAt)}
                      </span>
                    </div>
                    <p className="activity-body">{a.content}</p>
                    {a.dueAt && (
                      <span className={`ui-small ${overdue ? 'ui-overdue' : 'ui-muted'}`}>
                        {done ? 'Done' : overdue ? 'Overdue' : 'Due'} · {dueLabel(a.dueAt)}
                      </span>
                    )}
                  </div>
                  {(a.createdBy === user?.id || ws.can('data:delete')) && (
                    <button
                      className="ui-icon-btn ui-icon-btn--sm"
                      aria-label="Delete entry"
                      onClick={() => void remove(a)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
