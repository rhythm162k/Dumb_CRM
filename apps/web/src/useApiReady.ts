import { useCallback, useEffect, useState } from 'react';

export type ApiStatus = 'checking' | 'ready' | 'failed';

// Dev: the API on localhost. Production: set VITE_API_URL to the API's own address so the splash can
// wake it directly; without it the splash falls back to the same-origin /api proxy.
const API_URL: string =
  import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:4000');
const HEALTH_URL = API_URL ? `${API_URL}/health` : '/api/health';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls GET /health until the API (and its database) answer, or gives up. */
export function useApiReady(giveUpAfterMs = 90_000) {
  const [status, setStatus] = useState<ApiStatus>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setStatus('checking');

    (async () => {
      let delay = 1000;
      while (!cancelled) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(HEALTH_URL, { signal: controller.signal });
          if (res.ok) {
            if (!cancelled) setStatus('ready');
            return;
          }
        } catch {
          // server still waking up
        } finally {
          clearTimeout(timer);
        }
        if (Date.now() - startedAt > giveUpAfterMs) {
          if (!cancelled) setStatus('failed');
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 1.3, 4000);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, giveUpAfterMs]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { status, retry };
}
