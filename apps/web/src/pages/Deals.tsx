import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import { createDealSchema, DEAL_STAGES, type DealStage } from '@crm/shared';
import { api, ApiError } from '../api';
import { ActivityPanel } from '../ActivityPanel';
import { Field, FormError } from '../components';
import type { Company, Contact, Deal, Page } from '../types';
import {
  ExportButton,
  LoadingRegion,
  Modal,
  Select,
  Skeleton,
  useConfirm,
  useDebounced,
  useToast,
} from '../ui';
import { useWorkspace } from '../workspace';

export const STAGE_LABEL: Record<DealStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

function money(value: number, currency: string) {
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

/** Column totals can mix currencies, so group them instead of adding unlike amounts. */
function totalLabel(items: Deal[]) {
  const byCurrency = new Map<string, number>();
  for (const d of items) byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + d.value);
  return [...byCurrency.entries()].map(([cur, sum]) => money(sum, cur)).join(' · ');
}

/** Optimistic move: pull the deal out, drop it into `stage` at `position`, renumber that column. */
function moveLocal(deals: Deal[], id: string, stage: DealStage, position: number): Deal[] {
  const moving = deals.find((d) => d.id === id);
  if (!moving) return deals;
  const rest = deals.filter((d) => d.id !== id);
  const target = rest.filter((d) => d.stage === stage).sort((a, b) => a.position - b.position);
  target.splice(Math.min(position, target.length), 0, { ...moving, stage });
  const renumbered = new Map(target.map((d, i) => [d.id, { ...d, position: i }]));
  return [...rest.filter((d) => d.stage !== stage), ...renumbered.values()];
}

/** Six empty-looking columns with a few grey cards, in the same grid as the real board. */
function BoardSkeleton() {
  return (
    <LoadingRegion label="Loading deals">
      <div className="deals-board">
        {DEAL_STAGES.map((stage, i) => (
          <section key={stage} className="deals-column" data-stage={stage}>
            <div className="deals-column__head">
              <Skeleton width="55%" height="0.8rem" />
            </div>
            <div className="deals-column__body">
              <div className="ui-skeleton-stack">
                {Array.from({ length: i % 3 === 0 ? 2 : 1 }, (_, n) => (
                  <Skeleton key={n} block />
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function Deals() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Deal | DealStage | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<DealStage | null>(null);
  // false in the first moment of a drag (the card looks lifted for the drag ghost), then true
  const [dragReady, setDragReady] = useState(false);
  // ids of cards that are fading in, and of deleted cards that are fading out
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const knownIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (debounced) params.set('q', debounced);
    api<{ items: Deal[] }>(`${ws.base}/deals?${params.toString()}`)
      .then((d) => {
        if (!cancelled) {
          setDeals(d.items);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load deals');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base, debounced, version]);

  // a card whose id was not on the board before is "added": it fades in (not on the first load)
  useLayoutEffect(() => {
    if (!deals) return;
    const ids = new Set(deals.map((d) => d.id));
    const before = knownIds.current;
    if (before) {
      const added = [...ids].filter((id) => !before.has(id));
      if (added.length) setEntering((cur) => new Set([...cur, ...added]));
    }
    knownIds.current = ids;
  }, [deals]);

  // safety net: if a fade-out never reports animationend, drop the cards anyway
  useEffect(() => {
    if (leaving.size === 0) return;
    const timer = window.setTimeout(() => {
      setDeals((cur) => cur?.filter((d) => !leaving.has(d.id)) ?? cur);
      setLeaving(new Set());
    }, 800);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  function onSlotAnimationEnd(e: ReactAnimationEvent<HTMLDivElement>, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.animationName === 'deals-leave') {
      setDeals((cur) => cur?.filter((d) => d.id !== id) ?? cur);
      setLeaving((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    } else if (e.animationName === 'deals-in') {
      setEntering((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  const columns = useMemo(() => {
    const map = new Map<DealStage, Deal[]>(DEAL_STAGES.map((s) => [s, []]));
    for (const d of deals ?? []) map.get(d.stage)?.push(d);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [deals]);

  // `index` is the slot among the column's other cards (for the instant UI update);
  // `position` is the value sent to the API (column positions can have gaps)
  async function move(id: string, stage: DealStage, index: number, position: number) {
    if (!deals || !ws.can('data:write')) return;
    const before = deals;
    setDeals(moveLocal(deals, id, stage, index));
    try {
      await api(`${ws.base}/deals/${id}/move`, { method: 'POST', body: { stage, position } });
    } catch (err) {
      setDeals(before);
      setError(err instanceof ApiError ? err.message : 'Could not move the deal');
      setVersion((v) => v + 1);
    }
  }

  function drop(stage: DealStage, index: number, position: number) {
    const id = dragId;
    setDragId(null);
    setOverStage(null);
    if (id) void move(id, stage, index, position);
  }

  // stage picker (touch screens): put the deal at the bottom of the chosen column
  function moveToStage(deal: Deal, stage: DealStage) {
    if (stage === deal.stage) return;
    const others = columns.get(stage) ?? [];
    const last = others[others.length - 1];
    void move(deal.id, stage, others.length, last ? last.position + 1 : 0);
  }

  const onDragOver = (e: DragEvent, stage: DealStage) => {
    if (!dragId) return;
    e.preventDefault();
    setOverStage(stage);
  };

  return (
    <div className="ui-page ui-page--wide">
      <div className="ui-page__head">
        <h1>Deals</h1>
      </div>
      <div className="ui-toolbar">
        <input
          className="ui-search"
          type="search"
          placeholder="Search deals"
          aria-label="Search deals"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="ui-toolbar__actions">
          <ExportButton path={`${ws.base}/deals/export.csv`} />
          {ws.can('data:write') && (
            <button
              className="ui-btn ui-btn--primary ui-btn--sm"
              onClick={() => setEditing('lead')}
            >
              New deal
            </button>
          )}
        </div>
      </div>
      <FormError message={error} />

      {deals === null && !error && <BoardSkeleton />}
      {deals && (
        <div className="deals-board">
          {DEAL_STAGES.map((stage) => {
            const items = columns.get(stage) ?? [];
            return (
              <section
                key={stage}
                className="deals-column"
                data-stage={stage}
                data-over={overStage === stage}
                aria-label={STAGE_LABEL[stage]}
                onDragOver={(e) => onDragOver(e, stage)}
                onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  const others = items.filter((d) => d.id !== dragId);
                  const last = others[others.length - 1];
                  drop(stage, others.length, last ? last.position + 1 : 0);
                }}
              >
                <div className="deals-column__head">
                  <h2>
                    {STAGE_LABEL[stage]} <span className="ui-muted">({items.length})</span>
                  </h2>
                  <span className="deals-column__total">{totalLabel(items)}</span>
                </div>
                <div className="deals-column__body">
                  {items.length === 0 && <p className="deals-column__empty">No deals</p>}
                  {items.map((d) => (
                    <div
                      key={d.id}
                      className="deals-slot"
                      data-state={leaving.has(d.id) ? 'leaving' : undefined}
                      data-enter={entering.has(d.id) || undefined}
                      onAnimationEnd={(e) => onSlotAnimationEnd(e, d.id)}
                    >
                      <div className="deals-slot__inner">
                        <div
                          role="button"
                          tabIndex={0}
                          className="deals-card"
                          data-dragging={
                            dragId === d.id ? (dragReady ? 'placeholder' : 'lifted') : undefined
                          }
                          draggable={ws.can('data:write')}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', d.id);
                            setDragId(d.id);
                            setDragReady(false);
                            window.setTimeout(() => setDragReady(true), 0);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setOverStage(null);
                          }}
                          onDragOver={(e) => onDragOver(e, stage)}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            // dropping on a card puts the dragged deal just before that card
                            if (d.id === dragId) {
                              setDragId(null);
                              setOverStage(null);
                              return;
                            }
                            const others = items.filter((x) => x.id !== dragId);
                            drop(
                              stage,
                              others.findIndex((x) => x.id === d.id),
                              d.position,
                            );
                          }}
                          onClick={() => setEditing(d)}
                          onKeyDown={(e) => e.key === 'Enter' && setEditing(d)}
                        >
                          <span className="deals-card__title">{d.title}</span>
                          {(d.companyName || d.contactName) && (
                            <span className="deals-card__meta">
                              {[d.companyName, d.contactName].filter(Boolean).join(' · ')}
                            </span>
                          )}
                          <span className="deals-card__value">{money(d.value, d.currency)}</span>
                          {ws.can('data:write') && (
                            <select
                              className="deals-card__move"
                              aria-label={`Move ${d.title} to another stage`}
                              value={d.stage}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              onChange={(e) => moveToStage(d, e.target.value as DealStage)}
                            >
                              {DEAL_STAGES.map((s) => (
                                <option key={s} value={s}>
                                  {STAGE_LABEL[s]}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal
          title={typeof editing === 'string' ? 'New deal' : editing.title}
          onClose={() => setEditing(null)}
        >
          <DealForm
            deal={typeof editing === 'string' ? null : editing}
            initialStage={typeof editing === 'string' ? editing : editing.stage}
            stageEnds={
              Object.fromEntries(
                DEAL_STAGES.map((s) => {
                  const list = columns.get(s) ?? [];
                  const last = list[list.length - 1];
                  return [s, last ? last.position + 1 : 0];
                }),
              ) as Record<DealStage, number>
            }
            onSaved={() => {
              setEditing(null);
              setVersion((v) => v + 1);
            }}
            onDeleted={(id) => {
              // no refetch: the card fades out and is then removed from the list
              setEditing(null);
              setLeaving((cur) => new Set([...cur, id]));
            }}
          />
          {typeof editing !== 'string' && <ActivityPanel dealId={editing.id} />}
        </Modal>
      )}
    </div>
  );
}

function DealForm({
  deal,
  initialStage,
  stageEnds,
  onSaved,
  onDeleted,
}: {
  deal: Deal | null;
  initialStage: DealStage;
  stageEnds: Record<DealStage, number>;
  onSaved: () => void;
  onDeleted: (id: string) => void;
}) {
  const ws = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Page<Company>>(`${ws.base}/companies?pageSize=100`)
      .then((d) => setCompanies(d.items))
      .catch(() => setCompanies([]));
    api<Page<Contact>>(`${ws.base}/contacts?pageSize=100`)
      .then((d) => setContacts(d.items))
      .catch(() => setContacts([]));
  }, [ws.base]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? '').trim();
    const stage = val('stage') as DealStage;
    const parsed = createDealSchema.safeParse({
      title: val('title'),
      value: val('value') === '' ? 0 : Number(val('value')),
      currency: val('currency') || 'USD',
      stage,
      companyId: val('companyId') || null,
      contactId: val('contactId') || null,
      expectedCloseDate: val('expectedCloseDate') || null,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the form');
    setBusy(true);
    setError(null);
    try {
      if (deal) {
        await api(`${ws.base}/deals/${deal.id}`, { method: 'PATCH', body: parsed.data });
        if (stage !== deal.stage) {
          // a stage change goes through /move; put the deal at the bottom of its new column
          await api(`${ws.base}/deals/${deal.id}/move`, {
            method: 'POST',
            body: { stage, position: stageEnds[stage] },
          });
        }
      } else {
        await api(`${ws.base}/deals`, { method: 'POST', body: parsed.data });
      }
      toast(deal ? 'Deal saved' : 'Deal added');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!deal) return;
    const ok = await confirm({
      title: `Delete “${deal.title}”?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`${ws.base}/deals/${deal.id}`, { method: 'DELETE' });
      toast('Deal deleted');
      onDeleted(deal.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the deal');
      setBusy(false);
    }
  }

  const canWrite = ws.can('data:write');
  return (
    <form onSubmit={onSubmit} noValidate>
      <Field label="Title" name="title" defaultValue={deal?.title} required />
      <div className="ui-row">
        <Field
          label="Value"
          name="value"
          type="number"
          min={0}
          step="0.01"
          defaultValue={deal?.value ?? ''}
        />
        <Field
          label="Currency"
          name="currency"
          defaultValue={deal?.currency ?? 'USD'}
          maxLength={3}
        />
      </div>
      <div className="ui-row">
        <Select label="Stage" name="stage" defaultValue={initialStage}>
          {DEAL_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
        <Field
          label="Expected close"
          name="expectedCloseDate"
          type="date"
          defaultValue={deal?.expectedCloseDate ?? ''}
        />
      </div>
      <Select label="Company" name="companyId" defaultValue={deal?.companyId ?? ''}>
        <option value="">No company</option>
        {deal?.companyId && !companies.some((c) => c.id === deal.companyId) && (
          <option value={deal.companyId}>{deal.companyName}</option>
        )}
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select label="Contact" name="contactId" defaultValue={deal?.contactId ?? ''}>
        <option value="">No contact</option>
        {deal?.contactId && !contacts.some((c) => c.id === deal.contactId) && (
          <option value={deal.contactId}>{deal.contactName}</option>
        )}
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {[c.firstName, c.lastName].filter(Boolean).join(' ')}
          </option>
        ))}
      </Select>
      <FormError message={error} />
      <div className="ui-actions">
        {deal && ws.can('data:delete') && (
          <button
            type="button"
            className="ui-btn ui-btn--danger ui-btn--sm ui-actions__start"
            disabled={busy}
            onClick={() => void onDelete()}
          >
            Delete
          </button>
        )}
        {canWrite && (
          <button
            className="ui-btn ui-btn--primary ui-btn--sm"
            disabled={busy}
            data-busy={busy || undefined}
          >
            {busy ? 'Saving…' : 'Save deal'}
          </button>
        )}
      </div>
    </form>
  );
}
