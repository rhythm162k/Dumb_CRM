import type { ApiStatus } from './useApiReady';

function message(seconds: number) {
  if (seconds < 20) return 'Waking up your workspace. The first visit can take up to a minute.';
  if (seconds < 90) return 'Still starting. The free server needs a little longer than usual.';
  return 'Taking longer than usual, but it is still trying. You do not need to do anything.';
}

export function Splash({
  status,
  seconds = 0,
  onRetry,
}: {
  status: ApiStatus;
  seconds?: number;
  onRetry: () => void;
}) {
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
          <p>The server did not wake up after several minutes. Please try again in a minute.</p>
          <button className="ui-btn ui-btn--primary" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <>
          <p role="status">{message(seconds)}</p>
          {seconds >= 5 && <p aria-hidden="true">Waiting {seconds}s</p>}
        </>
      )}
    </main>
  );
}
