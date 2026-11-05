import type { ApiStatus } from './useApiReady';

export function Splash({ status, onRetry }: { status: ApiStatus; onRetry: () => void }) {
  const failed = status === 'failed';
  return (
    <main className="splash-page">
      <div className="splash-web" aria-hidden="true" data-failed={failed}>
        <svg viewBox="0 0 168 56" className="splash-links">
          <path d="M18 28 H84" />
          <path d="M84 28 H150" />
        </svg>
        <span className="splash-node splash-node--1">A</span>
        <span className="splash-node splash-node--2">M</span>
        <span className="splash-node splash-node--3">K</span>
      </div>
      <img src="/images/favicon.png" alt="dumb-logo" width={48} />
      {failed ? (
        <>
          <p>The server didn’t respond. Check your connection and try again.</p>
          <button className="ui-btn ui-btn--primary" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <p role="status">Waking up your workspace. The first visit can take up to a minute.</p>
      )}
    </main>
  );
}
