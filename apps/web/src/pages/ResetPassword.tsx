import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { passwordSchema } from '@crm/shared';
import { api, ApiError } from '../api';
import { AuthLayout, Field, FormError } from '../components';

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = passwordSchema.safeParse(new FormData(e.currentTarget).get('password'));
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your password');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password: parsed.data } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Link not valid" subtitle="Request a new reset link and try again.">
        <Link className="ui-btn ui-btn--primary ui-btn--block" to="/forgot-password">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title="Password updated" subtitle="You can now sign in with your new password.">
        <Link className="ui-btn ui-btn--primary ui-btn--block" to="/login">
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters"
          required
        />
        <FormError message={error} />
        <button
          className="ui-btn ui-btn--primary ui-btn--block"
          disabled={busy}
          data-busy={busy || undefined}
        >
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthLayout>
  );
}
