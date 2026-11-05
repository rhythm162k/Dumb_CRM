import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { RegisterInput, WorkspaceRole } from '@crm/shared';
import { api, ApiError } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}
export interface Workspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}
interface Session {
  user: User;
  workspaces: Workspace[];
}

interface AuthState {
  user: User | null;
  workspaces: Workspace[];
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<{ verificationRequired: boolean }>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setSession(await api<Session>('/auth/me'));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      setSession(null);
    }
  }, []);

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, [reload]);

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      workspaces: session?.workspaces ?? [],
      loading,
      reload,
      async login(email, password) {
        setSession(
          await api<Session>('/auth/login', { method: 'POST', body: { email, password } }),
        );
      },
      async register(input) {
        const res = await api<Session & { verificationRequired: boolean }>('/auth/register', {
          method: 'POST',
          body: input,
        });
        if (!res.verificationRequired) setSession({ user: res.user, workspaces: res.workspaces });
        return { verificationRequired: res.verificationRequired };
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setSession(null);
      },
    }),
    [session, loading, reload],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
