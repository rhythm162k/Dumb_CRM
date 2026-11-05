import { useEffect, useState, type FormEvent } from 'react';
import { createContactSchema } from '@crm/shared';
import { api, ApiError } from '../api';
import { Field, FormError } from '../components';
import type { Company, Contact, Page } from '../types';
import { ActivityPanel } from '../ActivityPanel';
import { ImportContacts } from '../ImportContacts';
import {
  ExportButton,
  Modal,
  Pager,
  Select,
  TableSkeleton,
  TextArea,
  useConfirm,
  useDebounced,
  useFlash,
  useToast,
} from '../ui';
import { useWorkspace } from '../workspace';

const fullName = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(' ');

export function Contacts() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Contact> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [flashId, flash] = useFlash();

  useEffect(() => setPage(1), [debounced]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page) });
    if (debounced) params.set('q', debounced);
    api<Page<Contact>>(`${ws.base}/contacts?${params.toString()}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load contacts');
      });
    return () => {
      cancelled = true;
    };
  }, [ws.base, debounced, page, version]);

  return (
    <div className="ui-page">
      <div className="ui-page__head">
        <h1>Contacts</h1>
      </div>
      <div className="ui-toolbar">
        <input
          className="ui-search"
          type="search"
          placeholder="Search name, email, phone or company"
          aria-label="Search contacts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="ui-toolbar__actions">
          <ExportButton path={`${ws.base}/contacts/export.csv`} />
          {ws.can('data:write') && (
            <button
              className="ui-btn ui-btn--outline ui-btn--sm"
              onClick={() => setImporting(true)}
            >
              Import CSV
            </button>
          )}
          <button className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => setEditing('new')}>
            New contact
          </button>
        </div>
      </div>
      <FormError message={error} />

      {data === null && !error && (
        <TableSkeleton
          label="Loading contacts"
          headers={['Name', 'Email', 'Company', 'Phone', 'Tags']}
        />
      )}
      {data && data.items.length === 0 ? (
        <p className="ui-empty ui-empty--card">
          {debounced
            ? 'No contacts match your search.'
            : 'No contacts yet. Add your first one to get started.'}
        </p>
      ) : (
        data && (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th>Phone</th>
                  <th>Tags</th>
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
                      <strong>{fullName(c)}</strong>
                      {c.jobTitle && <div className="ui-muted ui-small">{c.jobTitle}</div>}
                    </td>
                    <td data-label="Email">{c.email}</td>
                    <td data-label="Company">{c.companyName}</td>
                    <td data-label="Phone">{c.phone}</td>
                    <td data-label="Tags">
                      {c.tags.map((t) => (
                        <span key={t} className="ui-chip">
                          {t}
                        </span>
                      ))}
                    </td>
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

      {importing && (
        <ImportContacts
          onClose={() => setImporting(false)}
          onImported={() => {
            setPage(1);
            setVersion((v) => v + 1);
          }}
        />
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? 'New contact' : fullName(editing)}
          onClose={() => setEditing(null)}
        >
          <ContactForm
            contact={editing === 'new' ? null : editing}
            onSaved={(id) => {
              setEditing(null);
              flash(id ?? null);
              setVersion((v) => v + 1);
            }}
          />
          {editing !== 'new' && <ActivityPanel contactId={editing.id} />}
        </Modal>
      )}
    </div>
  );
}

function ContactForm({
  contact,
  onSaved,
}: {
  contact: Contact | null;
  /** `id` is set after a create or an edit (the row flashes), not after a delete */
  onSaved: (id?: string) => void;
}) {
  const ws = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Page<Company>>(`${ws.base}/companies?pageSize=100`)
      .then((d) => setCompanies(d.items))
      .catch(() => setCompanies([]));
  }, [ws.base]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = createContactSchema.safeParse({
      firstName: val('firstName'),
      lastName: val('lastName'),
      email: val('email'),
      phone: val('phone'),
      jobTitle: val('jobTitle'),
      companyId: val('companyId') || null,
      tags: val('tags')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: val('notes'),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the form');
    setBusy(true);
    setError(null);
    try {
      const saved = await api<{ contact: Contact }>(
        contact ? `${ws.base}/contacts/${contact.id}` : `${ws.base}/contacts`,
        {
          method: contact ? 'PATCH' : 'POST',
          body: parsed.data,
        },
      );
      toast(contact ? 'Contact saved' : 'Contact added');
      onSaved(saved.contact.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!contact) return;
    const ok = await confirm({
      title: `Delete ${fullName(contact)}?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`${ws.base}/contacts/${contact.id}`, { method: 'DELETE' });
      toast('Contact deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the contact');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="ui-row">
        <Field label="First name" name="firstName" defaultValue={contact?.firstName} required />
        <Field label="Last name" name="lastName" defaultValue={contact?.lastName ?? ''} />
      </div>
      <Field label="Email" name="email" type="email" defaultValue={contact?.email ?? ''} />
      <div className="ui-row">
        <Field label="Phone" name="phone" type="tel" defaultValue={contact?.phone ?? ''} />
        <Field label="Job title" name="jobTitle" defaultValue={contact?.jobTitle ?? ''} />
      </div>
      <Select label="Company" name="companyId" defaultValue={contact?.companyId ?? ''}>
        <option value="">No company</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Field
        label="Tags"
        name="tags"
        defaultValue={contact?.tags.join(', ') ?? ''}
        hint="Separate with commas"
      />
      <TextArea label="Notes" name="notes" defaultValue={contact?.notes ?? ''} />
      <FormError message={error} />
      <div className="ui-actions">
        {contact && ws.can('data:delete') && (
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
          {busy ? 'Saving…' : 'Save contact'}
        </button>
      </div>
    </form>
  );
}
