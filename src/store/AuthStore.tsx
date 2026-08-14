import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BusinessCategoryId } from '../domain/businessCategories';
import { isBusinessCategoryId } from '../domain/businessCategories';
import {
  fetchCurrentSession,
  requestDevLogin,
  saveBusinessProfile,
  type SaveBusinessProfilePayload,
} from '../services/authService';
import { clearAuthSession, getAuthSession, setAuthSession, subscribeAuthSession } from '../services/authTokenStore';
import {
  fetchCurrentSession,
  requestDevLogin,
  saveBusinessProfile,
  verifyLoginCode,
  type AuthUserProfile,
  type PendingInvite,
  type SaveBusinessProfilePayload,
} from '../services/authService';
import { acceptTeamInvite, declineTeamInvite } from '../services/teamService';
import { clearAuthSession, getAuthSession, setAuthSession, subscribeAuthSession } from '../services/authTokenStore';

export type AuthSession = {
  token: string;
  phoneNumber: string;
  tenantPhone: string;
  role: 'owner' | 'member';
  businessName: string | null;
  businessCategory: BusinessCategoryId | null;
  needsOnboarding: boolean;
  pendingInvite: PendingInvite | null;
  hasOwnBusiness: boolean;
};

type AuthContextValue = {
  session: AuthSession | null;
  isBootstrapping: boolean;
  completeWhatsAppLogin: (payload: { token: string; phoneNumber: string }) => Promise<AuthSession>;
  loginWithDevBypass: (phoneNumber?: string) => Promise<AuthSession>;
  completeOnboarding: (payload: SaveBusinessProfilePayload) => Promise<AuthSession>;
  refreshSession: () => Promise<AuthSession | null>;
  acceptInvite: (inviteId: string) => Promise<AuthSession>;
  declineInvite: (inviteId: string) => Promise<AuthSession>;
  applyProfile: (profile: AuthUserProfile) => AuthSession;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const toBusinessCategory = (value: string | null | undefined): BusinessCategoryId | null =>
  isBusinessCategoryId(value) ? value : null;

const buildSession = (
  token: string,
  profile: {
    phoneNumber: string;
    tenantPhone?: string | null;
    role?: string | null;
    businessName?: string | null;
    businessCategory?: string | null;
    needsOnboarding?: boolean;
    pendingInvite?: PendingInvite | null;
    hasOwnBusiness?: boolean;
  },
): AuthSession => {
  const businessCategory = toBusinessCategory(profile.businessCategory);
  const businessName =
    typeof profile.businessName === 'string' && profile.businessName.trim() ? profile.businessName.trim() : null;

  return {
    token,
    phoneNumber: profile.phoneNumber,
    tenantPhone: profile.tenantPhone || profile.phoneNumber,
    role: profile.role === 'member' ? 'member' : 'owner',
    businessName,
    businessCategory,
    needsOnboarding: profile.needsOnboarding ?? !businessCategory,
    pendingInvite: profile.pendingInvite ?? null,
    hasOwnBusiness: Boolean(profile.hasOwnBusiness),
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

const handleCompleteWhatsAppLogin = async (payload: { token: string; phoneNumber: string }) =>
  applyAuthenticatedSession(payload.token, payload.phoneNumber);

const applyProfile = (profile: AuthUserProfile): AuthSession => {
  if (!session) {
    throw new Error('No hay sesión activa');
  }

  const nextSession = buildSession(session.token, profile);
  setSession(nextSession);
  return nextSession;
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
    return applyProfile(profile);
  };

  const refreshSession = async () => {
    if (!session) {
      return null;
    }

    const profile = await fetchCurrentSession();
    return applyProfile(profile);
  };

  const handleAcceptInvite = async (inviteId: string) => {
    const profile = await acceptTeamInvite(inviteId);
    return applyProfile(profile);
  };

  const handleDeclineInvite = async (inviteId: string) => {
    const profile = await declineTeamInvite(inviteId);
    return applyProfile(profile);
  };

  const value: AuthContextValue = {
    session,
    isBootstrapping,
    completeWhatsAppLogin: handleCompleteWhatsAppLogin,
    loginWithDevBypass: handleDevLogin,
    completeOnboarding: handleCompleteOnboarding,
    refreshSession,
    acceptInvite: handleAcceptInvite,
    declineInvite: handleDeclineInvite,
    applyProfile,
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
