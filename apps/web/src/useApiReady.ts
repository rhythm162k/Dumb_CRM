import { useCallback, useEffect, useState } from 'react';
import { HEALTH_URL, markAlive, sleep, WAKE_REQUEST_TIMEOUT_MS } from './wake';

export type ApiStatus = 'checking' | 'ready' | 'failed';

/** How long the splash keeps trying before it offers a "Try again" button. */
const GIVE_UP_AFTER_MS = 5 * 60_000;

/**
 * Polls GET /health until the API (and its database) answer.
 *
 * Each attempt may wait a long time (WAKE_REQUEST_TIMEOUT_MS): a sleeping free server holds the
 * request until it has started, and cutting it off early (it used to be 8 seconds) means the
 * request is gone before a cold start can possibly finish. `seconds` is how long we have waited.
 */
export function useApiReady(giveUpAfterMs = GIVE_UP_AFTER_MS) {
  const [status, setStatus] = useState<ApiStatus>('checking');
  const [seconds, setSeconds] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const controller = new AbortController();
    setStatus('checking');
    setSeconds(0);
    const ticker = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);

    (async () => {
      let delay = 1500;
      while (!cancelled) {
        const timer = setTimeout(() => controller.abort(), WAKE_REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
          if (res.ok) {
            markAlive();
            if (!cancelled) setStatus('ready');
            return;
          }
        } catch {
          // server still waking up (or this tab was closed)
        } finally {
          clearTimeout(timer);
        }
        if (cancelled) return;
        if (Date.now() - startedAt > giveUpAfterMs) {
          setStatus('failed');
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 1.5, 5000);
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(ticker);
      controller.abort();
    };
  }, [attempt, giveUpAfterMs]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { status, seconds, retry };
}
