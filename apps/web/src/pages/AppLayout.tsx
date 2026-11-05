import { useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { can } from '@crm/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { LoadingRegion, Skeleton } from '../ui';

/* Small line icons (24px grid, drawn with currentColor) for the nav. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="shell-link__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  dashboard: (
    <Icon>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </Icon>
  ),
  contacts: (
    <Icon>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </Icon>
  ),
  companies: (
    <Icon>
      <path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V20" />
      <path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V20" />
      <path d="M3 20h18M8 8h3M8 12h3M8 16h3" />
    </Icon>
  ),
  deals: (
    <Icon>
      <rect x="3.5" y="4" width="4.5" height="16" rx="1.5" />
      <rect x="9.75" y="4" width="4.5" height="10" rx="1.5" />
      <rect x="16" y="4" width="4.5" height="13" rx="1.5" />
    </Icon>
  ),
  audit: (
    <Icon>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6l-7-2.5Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Icon>
  ),
};

function NavItem({
  to,
  end,
  icon,
  children,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  children: string;
}) {
  return (
    <NavLink to={to} end={end} className="shell-link">
      {icon}
      <span className="shell-link__label">{children}</span>
    </NavLink>
  );
}

/** The app frame with grey placeholders, shown while the session is still loading. */
export function ShellSkeleton() {
  return (
    <div className="shell-root">
      <aside className="shell-sidebar">
        <div className="shell-sidebar__brand">
          <span className="ui-brand">
            <img src="/images/favicon.png" alt="dumb-logo" width={48} />
          </span>
        </div>
        <nav className="shell-nav" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="shell-link">
              <Skeleton round width="1.4rem" height="1.4rem" />
              <Skeleton width="3.5rem" height="0.7rem" />
            </span>
          ))}
        </nav>
      </aside>
      <div className="shell-main">
        <div className="ui-page">
          <LoadingRegion label="Loading">
            <div className="ui-skeleton-stack">
              <Skeleton width="12rem" height="1.6rem" />
              <Skeleton block height="6rem" />
              <Skeleton block height="12rem" />
            </div>
          </LoadingRegion>
        </div>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { user, workspaces, logout } = useAuth();
  const [resent, setResent] = useState(false);

  return (
    <div className="shell-root">
      <aside className="shell-sidebar">
        <div className="shell-sidebar__brand">
          <span className="ui-brand">
            <img src="/images/favicon.png" alt="dumb-logo" width={48} />
          </span>
          <p className="shell-workspace">{workspaces[0]?.name}</p>
        </div>
        <nav className="shell-nav" aria-label="Main">
          <NavItem to="/" end icon={ICONS.dashboard}>
            Dashboard
          </NavItem>
          <NavItem to="/contacts" icon={ICONS.contacts}>
            Contacts
          </NavItem>
          <NavItem to="/companies" icon={ICONS.companies}>
            Companies
          </NavItem>
          <NavItem to="/deals" icon={ICONS.deals}>
            Deals
          </NavItem>
          {workspaces[0] && can(workspaces[0].role, 'audit:read') && (
            <NavItem to="/audit" icon={ICONS.audit}>
              Audit log
            </NavItem>
          )}
        </nav>
        <div className="shell-sidebar__foot">
          <span className="shell-sidebar__email">{user?.email}</span>
          <button className="ui-btn ui-btn--outline ui-btn--sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="shell-main">
        {user && !user.emailVerified && (
          <div className="shell-banner">
            Confirm your email address to keep your account secure.{' '}
            {resent ? (
              'Link sent.'
            ) : (
              <button
                className="ui-link-button"
                onClick={() =>
                  api('/auth/resend-verification', { method: 'POST' }).then(() => setResent(true))
                }
              >
                Resend link
              </button>
            )}
          </div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
