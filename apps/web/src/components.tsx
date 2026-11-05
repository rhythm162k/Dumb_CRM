import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {hint && <p className="ui-hint">{hint}</p>}
    </div>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Link to="/" className="ui-brand">
          <img src="/images/favicon.png" alt="dumb-logo" width={48} />
        </Link>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <p className="auth-footer">{footer}</p>}
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p className="ui-error" role="alert">
      {message}
    </p>
  ) : null;
}
