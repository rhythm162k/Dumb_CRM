import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { registerSchema } from '@crm/shared';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { AuthLayout, Field, FormError } from '../components';

export function Register() {
  const { register } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const workspaceName = String(form.get('workspaceName') ?? '').trim();
    const parsed = registerSchema.safeParse({
      name: form.get('name'),
      email: form.get('email'),
      password: form.get('password'),
      workspaceName: workspaceName || undefined,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your details');
    setBusy(true);
    setError(null);
    try {
      const { verificationRequired } = await register(parsed.data);
      if (verificationRequired) setCheckEmail(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  if (checkEmail) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="We sent a link to confirm your address. Open it, then sign in."
      >
        <Link className="ui-btn ui-btn--primary ui-btn--block" to="/login">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your workspace"
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Your name" name="name" autoComplete="name" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters"
          required
        />
        <Field label="Workspace name (optional)" name="workspaceName" placeholder="Acme Inc." />
        <FormError message={error} />
        <button
          className="ui-btn ui-btn--primary ui-btn--block"
          disabled={busy}
          data-busy={busy || undefined}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <div className="auth-divider">or</div>
      <a className="ui-btn ui-btn--outline ui-btn--block" href="/api/auth/google">
        Continue with Google
      </a>
    </AuthLayout>
  );
}
