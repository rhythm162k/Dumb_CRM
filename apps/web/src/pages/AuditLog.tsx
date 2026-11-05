import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AUDIT_ENTITY_TYPES, type AuditEntityType } from '@crm/shared';
import { api, ApiError } from '../api';
import { FormError } from '../components';
import type { AuditEntry, Member, Page } from '../types';
import { Pager, Select, TableSkeleton } from '../ui';
import { useWorkspace } from '../workspace';
import { STAGE_LABEL } from './Deals';

const ENTITY_LABEL: Record<AuditEntityType, string> = {
  contact: 'Contacts',
  company: 'Companies',
  deal: 'Deals',
  activity: 'Activities',
  workspace: 'Exports and imports',
};

const VERB_LABEL: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  moved: 'moved',
  completed: 'completed',
  exported: 'exported',
  imported: 'imported',
};

/** "contact.created" -> "Contact created" */
function actionLabel(action: string) {
  const [entity = '', verb = ''] = action.split('.');
  const noun = entity.charAt(0).toUpperCase() + entity.slice(1);
  return `${noun} ${VERB_LABEL[verb] ?? verb}`.trim();
}

const stageName = (v: unknown) =>
  typeof v === 'string' && v in STAGE_LABEL
    ? STAGE_LABEL[v as keyof typeof STAGE_LABEL]
    : String(v ?? '?');

/** One short line from the metadata. It only ever holds field names and counts, never personal data. */
function details(entry: AuditEntry): string {
  const m = entry.metadata;
  if (!m) return '';
  const parts: string[] = [];
  if ('from' in m && 'to' in m) parts.push(`${stageName(m['from'])} → ${stageName(m['to'])}`);
  if (Array.isArray(m['fields']))
    parts.push(`Fields: ${(m['fields'] as unknown[]).map(String).join(', ')}`);
  if (typeof m['rows'] === 'number') parts.push(`${m['rows']} ${m['rows'] === 1 ? 'row' : 'rows'}`);
  if (typeof m['completed'] === 'boolean') parts.push(m['completed'] ? 'Marked done' : 'Reopened');
  if (typeof m['type'] === 'string') parts.push(`Type: ${m['type']}`);
  for (const key of ['created', 'updated', 'skipped', 'failed', 'companiesCreated'] as const) {
    if (typeof m[key] === 'number')
      parts.push(`${key === 'companiesCreated' ? 'companies created' : key}: ${m[key]}`);
  }
  return parts.join(' · ');
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function AuditLog() {
  const ws = useWorkspace();
  const allowed = ws.can('audit:read');
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState('');
  const [actorId, setActorId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [data, setData] = useState<Page<AuditEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // for the "who" filter; a failure here only hides the filter
  useEffect(() => {
    if (!allowed) return;
    api<{ members: Member[] }>(`${ws.base}/members`)
      .then((d) => setMembers(d.members))
      .catch(() => setMembers([]));
  }, [ws.base, allowed]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (entityType) params.set('entityType', entityType);
    if (actorId) params.set('actorId', actorId);
    api<Page<AuditEntry>>(`${ws.base}/audit?${params.toString()}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err.message : 'Could not load the audit log');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base, allowed, page, entityType, actorId]);

  if (!allowed) return <Navigate to="/" replace />;

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <h1>Audit log</h1>
      </div>
      <p className="ui-muted ui-small">
        Who changed what in this workspace. Entries record actions only, never contact details or
        note text.
      </p>

      <div className="audit-filters">
        <Select
          label="Type"
          value={entityType}
          onChange={(e) => {
            setEntityType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Everything</option>
          {AUDIT_ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {ENTITY_LABEL[t]}
            </option>
          ))}
        </Select>
        {members.length > 0 && (
          <Select
            label="Who"
            value={actorId}
            onChange={(e) => {
              setActorId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      <FormError message={error} />

      {data === null && !error && (
        <TableSkeleton
          label="Loading the audit log"
          headers={['Action', 'When', 'Who', 'Details']}
        />
      )}
      {data && data.items.length === 0 ? (
        <p className="ui-empty ui-empty--card">
          {entityType || actorId
            ? 'No entries match these filters.'
            : 'Nothing has been recorded yet.'}
        </p>
      ) : (
        data && (
          <div className="ui-table-wrap">
            <table className="ui-table ui-table--static">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>When</th>
                  <th>Who</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <strong>{actionLabel(e.action)}</strong>
                    </td>
                    <td data-label="When">{when(e.createdAt)}</td>
                    <td data-label="Who">{e.actorName ?? 'Removed user'}</td>
                    <td data-label="Details">{details(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {data && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
      )}
    </div>
  );
}
