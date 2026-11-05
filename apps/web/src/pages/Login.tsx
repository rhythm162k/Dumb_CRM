import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { loginSchema } from '@crm/shared';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { AuthLayout, Field, FormError } from '../components';

export function Login() {
  const { login } = useAuth();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(
    params.get('error') === 'google_failed' ? 'Google sign-in failed. Try again.' : null,
  );
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = loginSchema.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your details');
    setBusy(true);
    setError(null);
    try {
      await login(parsed.data.email, parsed.data.password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
          New here? <Link to="/register">Create an account</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <FormError message={error} />
        <button
          className="ui-btn ui-btn--primary ui-btn--block"
          disabled={busy}
          data-busy={busy || undefined}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-aside">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <div className="auth-divider">or</div>
      <a className="ui-btn ui-btn--outline ui-btn--block" href="/api/auth/google">
        Continue with Google
      </a>
    </AuthLayout>
  );
}
