import { useEffect, useState, type FormEvent } from 'react';
import { createCompanySchema } from '@crm/shared';
import { api, ApiError } from '../api';
import { Field, FormError } from '../components';
import type { Company, Page } from '../types';
import {
  ExportButton,
  Modal,
  Pager,
  TableSkeleton,
  TextArea,
  useConfirm,
  useDebounced,
  useFlash,
  useToast,
} from '../ui';
import { useWorkspace } from '../workspace';

export function Companies() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Company> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [flashId, flash] = useFlash();

  useEffect(() => setPage(1), [debounced]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (debounced) params.set('q', debounced);
    api<Page<Company>>(`${ws.base}/companies?${params.toString()}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err.message : 'Could not load companies');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base, debounced, page, version]);

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <h1>Companies</h1>
      </div>
      <div className="ui-toolbar">
        <input
          className="ui-search"
          type="search"
          placeholder="Search companies"
          aria-label="Search companies"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="ui-toolbar__actions">
          <ExportButton path={`${ws.base}/companies/export.csv`} />
          <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => setEditing('new')}>
            New company
          </button>
        </div>
      </div>
      <FormError message={error} />

      {data === null && !error && (
        <TableSkeleton
          label="Loading companies"
          headers={['Name', 'Industry', 'Website', 'Contacts']}
        />
      )}
      {data && data.items.length === 0 ? (
        <p className="ui-empty ui-empty--card">
          {debounced
            ? 'No companies match your search.'
            : 'No companies yet. Add one to group your contacts.'}
        </p>
      ) : (
        data && (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Industry</th>
                  <th>Website</th>
                  <th>Contacts</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((c) => (
                  <tr
                    key={c.id}
                    data-new={flashId === c.id || undefined}
                    onClick={() => setEditing(c)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setEditing(c)}
                  >
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td data-label="Industry">{c.industry}</td>
                    <td data-label="Website">{c.website?.replace(/^https?:\/\//, '')}</td>
                    <td data-label="Contacts">{c.contactCount}</td>
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

      {editing && (
        <Modal
          title={editing === 'new' ? 'New company' : editing.name}
          onClose={() => setEditing(null)}
        >
          <CompanyForm
            company={editing === 'new' ? null : editing}
            onSaved={(id) => {
              setEditing(null);
              flash(id ?? null);
              setVersion((v) => v + 1);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function CompanyForm({
  company,
  onSaved,
}: {
  company: Company | null;
  /** `id` is set after a create or an edit (the row flashes), not after a delete */
  onSaved: (id?: string) => void;
}) {
  const ws = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = createCompanySchema.safeParse({
      name: val('name'),
      website: val('website'),
      industry: val('industry'),
      notes: val('notes'),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the form');
    setBusy(true);
    setError(null);
    try {
      const saved = await api<{ company: Company }>(
        company ? `${ws.base}/companies/${company.id}` : `${ws.base}/companies`,
        {
          method: company ? 'PATCH' : 'POST',
          body: parsed.data,
        },
      );
      toast(company ? 'Company saved' : 'Company added');
      onSaved(saved.company.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!company) return;
    const ok = await confirm({
      title: `Delete ${company.name}?`,
      message:
        company.contactCount > 0
          ? `Its ${company.contactCount} contact(s) will be kept without a company.`
          : 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`${ws.base}/companies/${company.id}`, { method: 'DELETE' });
      toast('Company deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the company');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <Field label="Name" name="name" defaultValue={company?.name} required />
      <div className="ui-row">
        <Field
          label="Website"
          name="website"
          defaultValue={company?.website ?? ''}
          placeholder="acme.com"
        />
        <Field label="Industry" name="industry" defaultValue={company?.industry ?? ''} />
      </div>
      <TextArea label="Notes" name="notes" defaultValue={company?.notes ?? ''} />
      <FormError message={error} />
      <div className="ui-actions">
        {company && ws.can('data:delete') && (
          <button
            type="button"
            className="ui-btn ui-btn--danger ui-btn--sm ui-actions__start"
            disabled={busy}
            onClick={() => void onDelete()}
          >
            Delete
          </button>
        )}
        <button
          className="ui-btn ui-btn--primary ui-btn--sm"
          disabled={busy}
          data-busy={busy || undefined}
        >
          {busy ? 'Saving…' : 'Save company'}
        </button>
      </div>
    </form>
  );
}
