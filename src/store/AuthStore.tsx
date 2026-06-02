import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchCurrentSession, requestLoginCode, verifyLoginCode } from '../services/authService';
import { clearAuthSession, getAuthSession, setAuthSession, subscribeAuthSession } from '../services/authTokenStore';

type AuthSession = {
  token: string;
  phoneNumber: string;
};

type AuthContextValue = {
  session: AuthSession | null;
  isBootstrapping: boolean;
  requestLoginCode: (phoneNumber: string) => Promise<{ challengeId: string; phoneNumber: string; expiresAt: string; expiresInSeconds: number }>;
  verifyLoginCode: (payload: { phoneNumber: string; otpCode: string; challengeId: string }) => Promise<{ token: string; tokenType: 'Bearer'; phoneNumber: string }>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => getAuthSession());
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const syncFromStorage = () => {
      if (cancelled) {
        return;
      }

      setSession(getAuthSession());
    };

    const unsubscribe = subscribeAuthSession(syncFromStorage);

    const bootstrap = async () => {
      const storedSession = getAuthSession();

      if (!storedSession) {
        setIsBootstrapping(false);
        return;
      }

      try {
        const currentSession = await fetchCurrentSession();
        const nextSession = {
          token: storedSession.token,
          phoneNumber: currentSession.phoneNumber,
        };

        setAuthSession(nextSession);
        if (!cancelled) {
          setSession(nextSession);
        }
      } catch {
        clearAuthSession();
        if (!cancelled) {
          setSession(null);
        }
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleRequestLoginCode = async (phoneNumber: string) => requestLoginCode(phoneNumber);

  const handleVerifyLoginCode = async (payload: { phoneNumber: string; otpCode: string; challengeId: string }) => {
    const result = await verifyLoginCode(payload);
    const nextSession = {
      token: result.token,
      phoneNumber: result.phoneNumber,
    };

    setAuthSession(nextSession);
    setSession(nextSession);

    return result;
  };

  const value: AuthContextValue = {
    session,
    isBootstrapping,
    requestLoginCode: handleRequestLoginCode,
    verifyLoginCode: handleVerifyLoginCode,
    logout: () => {
      clearAuthSession();
      setSession(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
};