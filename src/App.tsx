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

function Shell() {
  return (
    <main className="min-h-screen bg-mesh-soft-light text-[color:var(--text)] dark:bg-mesh-soft">
      <div className="mx-auto min-h-screen max-w-[1600px] px-4 py-4 lg:px-6 lg:py-6">
        <div className="erp-shell relative p-4 lg:p-6">
          <div className="relative">
            <DashboardPanel />
          </div>
        </div>

        <div className="relative mt-4">
          <WhatsAppSimulator />
        </div>
      </div>
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
      <main className="flex min-h-screen items-center justify-center bg-mesh-soft-light px-4 text-[color:var(--text)] dark:bg-mesh-soft">
        <div className="erp-card flex max-w-md flex-col items-center text-center">
          <StockyLogo size="lg" />
          <p className="erp-brand-gradient-text mt-4 text-xs uppercase tracking-[0.35em]">Stocky</p>
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
