import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError, downloadFile } from './api';

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Marks one record id for a few seconds, so its table row can flash once after it was saved.
 * `const [flashId, flash] = useFlash();` then `<tr data-new={flashId === c.id || undefined}>`.
 */
export function useFlash(ms = 3000) {
  const [id, setId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(
    (next: string | null) => {
      window.clearTimeout(timer.current);
      setId(next);
      if (next) timer.current = window.setTimeout(() => setId(null), ms);
    },
    [ms],
  );
  return [id, flash] as const;
}

/**
 * Opens a <dialog> as a modal on mount. When it closes (X, Esc, backdrop click or close()),
 * `onClosing` runs at once and `onClosed` runs after the exit transition, so the parent can
 * unmount it without cutting the animation short.
 */
function useDialog(onClosed: () => void, onClosing?: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const latest = useRef({ onClosed, onClosing });
  latest.current = { onClosed, onClosing };
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => window.clearTimeout(timer.current);
  }, []);

  function onCloseEvent() {
    latest.current.onClosing?.();
    const el = ref.current;
    const ms = el ? Number.parseFloat(getComputedStyle(el).transitionDuration) * 1000 : 0;
    timer.current = window.setTimeout(() => latest.current.onClosed(), Number.isFinite(ms) ? ms : 0);
  }

  return { ref, close: () => ref.current?.close(), onCloseEvent };
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { ref, close, onCloseEvent } = useDialog(onClose);
  return (
    <dialog
      ref={ref}
      className="ui-modal"
      onClose={onCloseEvent}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="ui-modal__body">
        <div className="ui-modal__head">
          <h2>{title}</h2>
          <button type="button" className="ui-icon-btn" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// ---------- confirm dialog (replaces window.confirm) ----------

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** red confirm button, for deletes */
  danger?: boolean;
}
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** `const confirm = useConfirm(); if (!(await confirm({ title: 'Delete?', danger: true }))) return;` */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm needs <ConfirmProvider>');
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog {...pending} onDone={() => setPending(null)} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  resolve,
  onDone,
}: PendingConfirm & { onDone: () => void }) {
  const answer = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { ref, close, onCloseEvent } = useDialog(onDone, () => resolve(answer.current));

  // focus Cancel, so a stray Enter never confirms a delete
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className="ui-modal ui-modal--sm"
      onClose={onCloseEvent}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="ui-modal__body">
        <div className="ui-modal__head">
          <h2>{title}</h2>
        </div>
        {message && <p className="ui-modal__text">{message}</p>}
        <div className="ui-actions ui-actions--static">
          <button ref={cancelRef} type="button" className="ui-btn ui-btn--outline" onClick={close}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'ui-btn ui-btn--danger-solid' : 'ui-btn ui-btn--primary'}
            onClick={() => {
              answer.current = true;
              close();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---------- toast ----------

type ToastTone = 'success' | 'danger';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  leaving: boolean;
}
type ToastFn = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ToastFn | null>(null);

/** `const toast = useToast(); toast('Saved');` */
export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast needs <ToastProvider>');
  return toast;
}

/** Puts the toast stack in the browser's top layer, so it also shows above an open dialog. */
function showOnTop(el: HTMLDivElement | null) {
  if (!el || el.hasAttribute('popover')) return;
  el.setAttribute('popover', 'manual');
  try {
    el.showPopover();
  } catch {
    // no popover support: the stack stays an ordinary fixed layer
  }
}

const TOAST_MS = 3200;
const TOAST_EXIT_MS = 250;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const toast = useCallback<ToastFn>(
    (message, tone = 'success') => {
      const id = nextId.current++;
      setItems((cur) => [...cur.slice(-2), { id, message, tone, leaving: false }]);
      later(
        () => setItems((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t))),
        TOAST_MS,
      );
      later(() => setItems((cur) => cur.filter((t) => t.id !== id)), TOAST_MS + TOAST_EXIT_MS);
    },
    [later],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {items.length > 0 && (
        <div className="ui-toasts" role="status" aria-live="polite" ref={showOnTop}>
          {items.map((t) => (
            <div
              key={t.id}
              className="ui-toast"
              data-tone={t.tone}
              data-state={t.leaving ? 'leaving' : undefined}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

// ---------- card ----------

/** Surface with a soft shadow. `interactive` adds the hover raise for clickable cards. */
export function Card({ interactive, children }: { interactive?: boolean; children: ReactNode }) {
  return (
    <div className={interactive ? 'ui-card ui-card--interactive' : 'ui-card'}>{children}</div>
  );
}

// ---------- skeleton (first-load placeholders) ----------

/** One grey placeholder (a line by default). Give it the size of what it stands in for. */
export function Skeleton({
  block,
  round,
  width,
  height,
}: {
  block?: boolean;
  round?: boolean;
  width?: string;
  height?: string;
}) {
  return (
    <span
      className={
        block
          ? 'ui-skeleton ui-skeleton--block'
          : round
            ? 'ui-skeleton ui-skeleton--round'
            : 'ui-skeleton ui-skeleton--line'
      }
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/** Wraps placeholders: announces "loading" to screen readers and hides the shapes from them. */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="ui-sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

const SKELETON_WIDTHS = ['72%', '58%', '84%', '46%', '66%'];

/** Placeholder for a ui-table: real column headings, grey cells. Same markup, so no layout jump. */
export function TableSkeleton({
  headers,
  label,
  rows = 6,
}: {
  headers: string[];
  label: string;
  rows?: number;
}) {
  return (
    <div className="ui-table-wrap" role="status" aria-busy="true">
      <span className="ui-sr-only">{label}</span>
      <table className="ui-table ui-table--static" aria-hidden="true">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {headers.map((h, c) => (
                <td key={h}>
                  <Skeleton width={SKELETON_WIDTHS[(r + c) % SKELETON_WIDTHS.length]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TextArea({
  label,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={3} {...props} />
    </div>
  );
}

export function Select({
  label,
  hint,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...props}>
        {children}
      </select>
      {hint && <p className="ui-hint">{hint}</p>}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav className="ui-pager" aria-label="Pagination">
      <button
        className="ui-btn ui-btn--outline ui-btn--sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span className="ui-pager__status">
        Page {page} of {pages}
      </span>
      <button
        className="ui-btn ui-btn--outline ui-btn--sm"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

/** Downloads a CSV from the API; shows a short error next to the button if it fails. */
export function ExportButton({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await downloadFile(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The download failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="ui-btn ui-btn--outline ui-btn--sm"
        disabled={busy}
        data-busy={busy || undefined}
        onClick={() => void onClick()}
      >
        {busy ? 'Exporting…' : 'Export CSV'}
      </button>
      {error && (
        <span className="ui-error ui-error--inline" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
