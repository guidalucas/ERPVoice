import { DashboardPanel } from './components/dashboard/DashboardPanel';
import { WhatsAppSimulator } from './components/split/WhatsAppSimulator';
import { MetaSyncBridge } from './components/dashboard/MetaSyncBridge';
import { AppStoreProvider } from './store/AppStore';
import { AuthProvider, useAuth } from './store/AuthStore';
import { LoginPanel } from './components/auth/LoginPanel';
import { BusinessSetupPanel } from './components/onboarding/BusinessSetupPanel';
import { AcceptInvitePanel } from './components/onboarding/AcceptInvitePanel';
import { ThemeProvider } from './hooks/useTheme';
import { StockyLogo } from './components/brand/StockyLogo';
import { WaveformMark } from './components/brand/WaveformMark';

function Shell() {
  return (
    <main className="min-h-[100dvh] text-[color:var(--text)]">
      <DashboardPanel />
      <WhatsAppSimulator />
    </main>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppGate />
      </AuthProvider>
    </ThemeProvider>
  );
}

function AppGate() {
  const { session, isBootstrapping } = useAuth();

  if (isBootstrapping) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center px-4 text-[color:var(--text)]">
        <div className="erp-card flex max-w-md flex-col items-center text-center">
          <StockyLogo size="lg" />
          <p className="mt-4">
            <WaveformMark bars={7} />
          </p>
          <h1 className="mt-3 type-title text-2xl text-[color:var(--text)]">Abriendo tu sesión</h1>
          <p className="mt-2 text-sm text-[color:var(--muted)]">Un momento, estamos preparando tu panel…</p>
        </div>
      </main>
    );
  }

  if (!session) {
    return <LoginPanel />;
  }

  if (session.pendingInvite) {
    return <AcceptInvitePanel />;
  }

  if (session.needsOnboarding) {
    return <BusinessSetupPanel />;
  }

  return (
    <AppStoreProvider key={session.tenantPhone}>
      <MetaSyncBridge />
      <Shell />
    </AppStoreProvider>
  );
}
