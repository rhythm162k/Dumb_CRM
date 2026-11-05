import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthLayout } from '../components';

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { reload } = useAuth();
  const [status, setStatus] = useState<'working' | 'ok' | 'failed'>(token ? 'working' : 'failed');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => {
        if (!cancelled) setStatus('ok');
        return reload();
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token, reload]);

  if (status === 'working') return <AuthLayout title="Confirming your email…" />;
  if (status === 'ok') {
    return (
      <AuthLayout title="Email confirmed" subtitle="Thanks, your address is verified.">
        <Link className="ui-btn ui-btn--primary ui-btn--block" to="/">
          Continue
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Link not valid"
      subtitle="It may have expired or already been used. Sign in to request a new one."
    >
      <Link className="ui-btn ui-btn--primary ui-btn--block" to="/login">
        Go to sign in
      </Link>
    </AuthLayout>
  );
}
