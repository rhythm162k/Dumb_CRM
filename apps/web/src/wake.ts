// Everything about waking the free server (Render puts it to sleep after 15 minutes without visitors).

const API_URL: string =
  import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:4000');
export const HEALTH_URL = API_URL ? `${API_URL}/health` : '/api/health';

/** One request may wait for a whole cold start: the free tier needs 30 to 60 seconds, sometimes more. */
export const WAKE_REQUEST_TIMEOUT_MS = 100_000;
/** The free server sleeps after 15 idle minutes, so check on it a little earlier than that. */
const IDLE_BEFORE_CHECK_MS = 8 * 60_000;
const WAKE_GIVE_UP_MS = 4 * 60_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let lastAlive = Date.now();
let waking: Promise<void> | null = null;
const listeners = new Set<(isWaking: boolean) => void>();

/** Call whenever the server has just answered: it is awake, so the idle clock restarts. */
export const markAlive = () => {
  lastAlive = Date.now();
};

/** Subscribe to "the server is being woken up" (used by the banner). Returns an unsubscribe function. */
export function onWaking(listener: (isWaking: boolean) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const notify = (isWaking: boolean) => listeners.forEach((l) => l(isWaking));

/**
 * Call before an API request. If the app has been idle long enough for the free server to have gone
 * to sleep, wake it first (waiting patiently) instead of letting the real request fail or time out.
 * Several requests at once share one wake-up.
 */
export async function ensureAwake(): Promise<void> {
  if (Date.now() - lastAlive < IDLE_BEFORE_CHECK_MS) return;
  waking ??= (async () => {
    notify(true);
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < WAKE_GIVE_UP_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WAKE_REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
          if (res.ok) {
            markAlive();
            return;
          }
        } catch {
          // still waking up
        } finally {
          clearTimeout(timer);
        }
        await sleep(2000);
      }
    } finally {
      notify(false);
      waking = null;
    }
  })();
  await waking;
}
