import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BusinessCategoryId } from '../domain/businessCategories';
import { isBusinessCategoryId } from '../domain/businessCategories';
import {
  fetchCurrentSession,
  requestDevLogin,
  requestLoginCode,
  saveBusinessProfile,
  verifyLoginCode,
  type SaveBusinessProfilePayload,
} from '../services/authService';
import { clearAuthSession, getAuthSession, setAuthSession, subscribeAuthSession } from '../services/authTokenStore';

export type AuthSession = {
  token: string;
  phoneNumber: string;
  businessName: string | null;
  businessCategory: BusinessCategoryId | null;
  needsOnboarding: boolean;
};

type AuthContextValue = {
  session: AuthSession | null;
  isBootstrapping: boolean;
  requestLoginCode: (phoneNumber: string) => Promise<{
    challengeId: string;
    phoneNumber: string;
    expiresAt: string;
    expiresInSeconds: number;
    devOtpCode?: string;
    devMode?: boolean;
  }>;
  verifyLoginCode: (payload: { phoneNumber: string; otpCode: string; challengeId: string }) => Promise<AuthSession>;
  loginWithDevBypass: (phoneNumber?: string) => Promise<AuthSession>;
  completeOnboarding: (payload: SaveBusinessProfilePayload) => Promise<AuthSession>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const toBusinessCategory = (value: string | null | undefined): BusinessCategoryId | null =>
  isBusinessCategoryId(value) ? value : null;

const buildSession = (
  token: string,
  profile: {
    phoneNumber: string;
    businessName?: string | null;
    businessCategory?: string | null;
    needsOnboarding?: boolean;
  },
): AuthSession => {
  const businessCategory = toBusinessCategory(profile.businessCategory);
  const businessName =
    typeof profile.businessName === 'string' && profile.businessName.trim() ? profile.businessName.trim() : null;

  return {
    token,
    phoneNumber: profile.phoneNumber,
    businessName,
    businessCategory,
    needsOnboarding: profile.needsOnboarding ?? !businessCategory,
  };
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const syncFromStorage = () => {
      if (cancelled) {
        return;
      }

      const stored = getAuthSession();
      if (!stored) {
        setSession(null);
      }
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
        const nextSession = buildSession(storedSession.token, currentSession);

        setAuthSession({ token: nextSession.token, phoneNumber: nextSession.phoneNumber });
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

  const applyAuthenticatedSession = async (token: string, phoneNumber: string): Promise<AuthSession> => {
    setAuthSession({ token, phoneNumber });

    try {
      const profile = await fetchCurrentSession();
      const nextSession = buildSession(token, profile);
      setSession(nextSession);
      return nextSession;
    } catch {
      const fallbackSession = buildSession(token, {
        phoneNumber,
        businessName: null,
        businessCategory: null,
        needsOnboarding: true,
      });
      setSession(fallbackSession);
      return fallbackSession;
    }
  };

  const handleVerifyLoginCode = async (payload: { phoneNumber: string; otpCode: string; challengeId: string }) => {
    const result = await verifyLoginCode(payload);
    return applyAuthenticatedSession(result.token, result.phoneNumber);
  };

  const handleDevLogin = async (phoneNumber?: string) => {
    const result = await requestDevLogin(phoneNumber);
    return applyAuthenticatedSession(result.token, result.phoneNumber);
  };

  const handleCompleteOnboarding = async (payload: SaveBusinessProfilePayload) => {
    if (!session) {
      throw new Error('No hay sesión activa');
    }

    const profile = await saveBusinessProfile(payload);
    const nextSession = buildSession(session.token, profile);
    setSession(nextSession);
    return nextSession;
  };

  const value: AuthContextValue = {
    session,
    isBootstrapping,
    requestLoginCode: handleRequestLoginCode,
    verifyLoginCode: handleVerifyLoginCode,
    loginWithDevBypass: handleDevLogin,
    completeOnboarding: handleCompleteOnboarding,
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
