import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { User } from "../lib/types";
import { api, setSession, clearSession, SESSION_KEY } from "../lib/api";

interface SignupInput {
  orgName: string;
  fullName: string;
  email: string;
  password: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  signup(input: SignupInput): Promise<void>;
  logout(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? ((JSON.parse(raw) as { user: User }).user ?? null) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);

  const applySession = useCallback((token: string, u: User) => {
    setSession({ token, user: u });
    setUser(u);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      try {
        const { token, user: u } = await api.post<{ token: string; user: User }>("/auth/login", { email, password });
        applySession(token, u);
      } finally {
        setLoading(false);
      }
    },
    [applySession]
  );

  const signup = useCallback(
    async (input: SignupInput) => {
      setLoading(true);
      try {
        const { token, user: u } = await api.post<{ token: string; user: User }>("/auth/signup", input);
        applySession(token, u);
      } finally {
        setLoading(false);
      }
    },
    [applySession]
  );

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, logout }),
    [user, loading, login, signup, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
