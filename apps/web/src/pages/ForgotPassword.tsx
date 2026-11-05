import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { forgotPasswordSchema } from '@crm/shared';
import { api, ApiError } from '../api';
import { AuthLayout, Field, FormError } from '../components';

export function ForgotPassword() {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = forgotPasswordSchema.safeParse({
      email: new FormData(e.currentTarget).get('email'),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Enter your email');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: parsed.data });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If an account exists for that address, we sent a link to reset the password."
      >
        <Link className="ui-btn ui-btn--primary ui-btn--block" to="/login">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we will send you a link."
      footer={<Link to="/login">Back to sign in</Link>}
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <FormError message={error} />
        <button
          className="ui-btn ui-btn--primary ui-btn--block"
          disabled={busy}
          data-busy={busy || undefined}
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthLayout>
  );
}
