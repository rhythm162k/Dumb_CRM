import { useState, type ChangeEvent } from 'react';
import { CsvError, IMPORT_MAX_ROWS, parseCsv, stripCsvGuard, type CsvRecord } from '@crm/shared';
import { api, ApiError } from './api';
import { FormError } from './components';
import { Modal, Select } from './ui';
import { useWorkspace } from './workspace';

type Target =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'jobTitle'
  | 'company'
  | 'tags'
  | 'notes';

const TARGETS: { key: Target; label: string; hint?: string }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  {
    key: 'fullName',
    label: 'Full name',
    hint: 'Split at the first space. Used when First name is not mapped.',
  },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'company', label: 'Company' },
  { key: 'tags', label: 'Tags', hint: 'Separated by ; or ,' },
  { key: 'notes', label: 'Notes' },
];

const STEPS = [
  { key: 'pick', label: 'File' },
  { key: 'map', label: 'Columns' },
  { key: 'preview', label: 'Preview' },
] as const;

// header names (lowercase, letters and digits only) that we map automatically
const GUESS: Record<Target, string[]> = {
  firstName: ['firstname', 'first', 'givenname', 'fname'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  fullName: ['name', 'fullname', 'contactname'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'tel', 'telephone', 'cell'],
  jobTitle: ['jobtitle', 'title', 'position', 'role'],
  company: ['company', 'companyname', 'organization', 'organisation', 'employer'],
  tags: ['tags', 'tag', 'labels', 'groups'],
  notes: ['notes', 'note', 'comments', 'comment', 'description'],
};

type Mapping = Record<Target, number>; // column index, -1 = not imported

function guessMapping(headers: string[]): Mapping {
  const norm = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const used = new Set<number>();
  const mapping = {} as Mapping;
  for (const { key } of TARGETS) {
    const index = norm.findIndex((h, i) => !used.has(i) && GUESS[key].includes(h));
    mapping[key] = index;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  companiesCreated: number;
  errors: { row: number; message: string }[];
}

interface Parsed {
  fileName: string;
  headers: string[];
  records: CsvRecord[]; // data rows, header excluded
}

const MAX_FILE_BYTES = 2_000_000;
const MAX_PAYLOAD_CHARS = 900_000; // the API accepts 1 MB of JSON
const SHOWN_ERRORS = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ImportContacts({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const ws = useWorkspace();
  const [step, setStep] = useState<'pick' | 'map' | 'preview' | 'done'>('pick');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [duplicates, setDuplicates] = useState<'skip' | 'update'>('skip');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is too large. Split it into files of up to 1,000 contacts.');
      return;
    }
    try {
      const { records } = parseCsv(await file.text());
      const [header, ...data] = records;
      if (!header || data.length === 0) {
        setError('The file needs a header row and at least one contact below it.');
        return;
      }
      if (data.length > IMPORT_MAX_ROWS) {
        setError(
          `This file has ${data.length.toLocaleString()} rows. Import at most ${IMPORT_MAX_ROWS.toLocaleString()} at a time.`,
        );
        return;
      }
      const headers = header.cells.map((h) => h.trim());
      setParsed({ fileName: file.name, headers, records: data });
      setMapping(guessMapping(headers));
      setStep('map');
    } catch (err) {
      setError(err instanceof CsvError ? err.message : 'Could not read that file. Is it a CSV?');
    }
  }

  function buildRows() {
    if (!parsed || !mapping) return [];
    return parsed.records.map((rec) => {
      const get = (key: Target) => {
        const index = mapping[key];
        if (index < 0) return undefined;
        const value = stripCsvGuard((rec.cells[index] ?? '').trim());
        return value === '' ? undefined : value;
      };
      let firstName = get('firstName');
      let lastName = get('lastName');
      if (firstName === undefined) {
        const [first, ...rest] = (get('fullName') ?? '').split(/\s+/);
        firstName = first || undefined;
        lastName = lastName ?? (rest.join(' ') || undefined);
      }
      return {
        firstName,
        lastName,
        email: get('email'),
        phone: get('phone'),
        jobTitle: get('jobTitle'),
        company: get('company'),
        tags: get('tags'),
        notes: get('notes'),
      };
    });
  }

  async function send(dryRun: boolean) {
    const rows = buildRows();
    if (JSON.stringify(rows).length > MAX_PAYLOAD_CHARS) {
      setError('This file has too much text to import in one go. Split it into smaller files.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>(`${ws.base}/contacts/import`, {
        method: 'POST',
        body: { rows, duplicates, dryRun },
      });
      setResult(res);
      if (dryRun) {
        setStep('preview');
      } else {
        setStep('done');
        onImported();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const canContinue = mapping !== null && (mapping.firstName >= 0 || mapping.fullName >= 0);
  // the finished state counts as past the last step
  const stepIndex = step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.key === step);
  const fileLine = (row: number) => parsed?.records[row]?.line ?? row + 2;

  return (
    <Modal title="Import contacts" onClose={onClose}>
      <ol className="import-steps" aria-label="Import progress">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className="import-steps__item"
            aria-current={i === stepIndex ? 'step' : undefined}
            data-done={i < stepIndex || undefined}
          >
            <span className="import-steps__dot">{i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
      <FormError message={error} />

      <div className="import-step" key={step}>
        {step === 'pick' && (
          <>
            <p className="ui-muted">
              Choose a CSV file with one contact per row and a header row on top (up to{' '}
              {IMPORT_MAX_ROWS.toLocaleString()} contacts). A file exported from Dumb works too. You
              will see a preview before anything is saved.
            </p>
            <div className="ui-field">
              <label htmlFor="import-file">CSV file</label>
              <input
                id="import-file"
                className="import-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void onFile(e)}
              />
            </div>
          </>
        )}

        {step === 'map' && parsed && mapping && (
          <>
            <p className="ui-muted">
              <strong>{parsed.fileName}</strong>: {plural(parsed.records.length, 'row')}. Match each
              field to a column.
            </p>
            <div className="import-map">
              {TARGETS.map(({ key, label, hint }) => (
                <Select
                  key={key}
                  label={label}
                  hint={hint}
                  value={mapping[key]}
                  onChange={(e) => setMapping({ ...mapping, [key]: Number(e.target.value) })}
                >
                  <option value={-1}>Do not import</option>
                  {parsed.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
            <fieldset className="ui-field import-dupes">
              <legend>If a contact with the same email already exists</legend>
              <label className="import-option">
                <input
                  type="radio"
                  name="dupes"
                  checked={duplicates === 'skip'}
                  onChange={() => setDuplicates('skip')}
                />
                <span>Skip it</span>
              </label>
              <label className="import-option">
                <input
                  type="radio"
                  name="dupes"
                  checked={duplicates === 'update'}
                  onChange={() => setDuplicates('update')}
                />
                <span>Update it (empty cells never erase existing data)</span>
              </label>
            </fieldset>
            {!canContinue && <p className="ui-hint">Map First name or Full name to continue.</p>}
            <div className="ui-actions">
              <button
                type="button"
                className="ui-btn ui-btn--outline"
                onClick={() => setStep('pick')}
              >
                Back
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--primary"
                disabled={!canContinue || busy}
                data-busy={busy || undefined}
                onClick={() => void send(true)}
              >
                {busy ? 'Checking…' : 'Preview'}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && result && (
          <>
            <Summary result={result} />
            <Problems result={result} fileLine={fileLine} />
            <div className="ui-actions">
              <button
                type="button"
                className="ui-btn ui-btn--outline"
                onClick={() => setStep('map')}
              >
                Back
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--primary"
                disabled={busy || result.created + result.updated === 0}
                data-busy={busy || undefined}
                onClick={() => void send(false)}
              >
                {busy
                  ? 'Importing…'
                  : `Import ${plural(result.created + result.updated, 'contact')}`}
              </button>
            </div>
          </>
        )}

        {step === 'done' && result && (
          <>
            <p>
              <strong>Import finished.</strong>
            </p>
            <Summary result={result} />
            <Problems result={result} fileLine={fileLine} />
            <div className="ui-actions">
              <button type="button" className="ui-btn ui-btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Summary({ result }: { result: ImportResult }) {
  const done = !result.dryRun;
  return (
    <ul className="import-summary">
      <li>
        {done ? 'Created' : 'Will create'} <strong>{plural(result.created, 'contact')}</strong>
        {result.companiesCreated > 0 && (
          <> and {plural(result.companiesCreated, 'new company', 'new companies')}</>
        )}
      </li>
      {result.updated > 0 && (
        <li>
          {done ? 'Updated' : 'Will update'}{' '}
          <strong>{plural(result.updated, 'existing contact')}</strong>
        </li>
      )}
      {result.skipped > 0 && (
        <li>
          {done ? 'Skipped' : 'Will skip'} <strong>{plural(result.skipped, 'duplicate')}</strong>
        </li>
      )}
      {result.failed > 0 && (
        <li className="ui-overdue">
          {plural(result.failed, 'row')}{' '}
          {done ? 'could not be imported' : 'will be left out because of problems'}
        </li>
      )}
    </ul>
  );
}

function Problems({
  result,
  fileLine,
}: {
  result: ImportResult;
  fileLine: (row: number) => number;
}) {
  if (result.errors.length === 0) return null;
  const shown = result.errors.slice(0, SHOWN_ERRORS);
  return (
    <>
      <h3 className="import-heading">Problems</h3>
      <ul className="import-errors">
        {shown.map((e) => (
          <li key={e.row}>
            <span className="ui-muted">Line {fileLine(e.row)}:</span> {e.message}
          </li>
        ))}
      </ul>
      {result.failed > shown.length && (
        <p className="ui-muted ui-small">and {result.failed - shown.length} more</p>
      )}
    </>
  );
}
