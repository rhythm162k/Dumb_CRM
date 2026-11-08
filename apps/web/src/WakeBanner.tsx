import { useEffect, useState } from 'react';
import { onWaking } from './wake';

/** Shown when the free server went to sleep while the app was open and is being woken again. */
export function WakeBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => onWaking(setWaking), []);
  if (!waking) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        maxWidth: 'calc(100vw - 24px)',
        padding: '10px 16px',
        borderRadius: 999,
        background: '#1d1d1f',
        color: '#fff',
        fontSize: 14,
        boxShadow: '0 8px 24px rgb(0 0 0 / 0.25)',
      }}
    >
      Waking the server. This can take up to a minute.
    </div>
  );
}
