import { DashboardPanel } from './components/dashboard/DashboardPanel';
import { WhatsAppSimulator } from './components/split/WhatsAppSimulator';
import { MetaSyncBridge } from './components/dashboard/MetaSyncBridge';
import { AppStoreProvider } from './store/AppStore';
import { AuthProvider, useAuth } from './store/AuthStore';
import { LoginPanel } from './components/auth/LoginPanel';
import { BusinessSetupPanel } from './components/onboarding/BusinessSetupPanel';
import { ThemeProvider } from './hooks/useTheme';
import { StockyLogo } from './components/brand/StockyLogo';

function Shell() {
  return (
    <main className="min-h-screen bg-mesh-soft-light text-slate-900 dark:bg-mesh-soft dark:text-slate-100">
      <div className="mx-auto min-h-screen max-w-[1600px] px-4 py-4 lg:px-6 lg:py-6">
        <div className="erp-shell relative p-4 lg:p-6">
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[2rem] bg-[radial-gradient(circle_at_top_left,rgba(25,195,125,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.06),transparent_24%)]" />
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
      <main className="flex min-h-screen items-center justify-center bg-mesh-soft-light px-4 text-slate-900 dark:bg-mesh-soft dark:text-slate-100">
        <div className="erp-card flex max-w-md flex-col items-center text-center">
          <StockyLogo size="lg" />
          <p className="mt-4 text-xs uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">Stocky Access</p>
          <h1 className="mt-3 font-display text-2xl font-bold text-slate-900 dark:text-white">Validando sesión</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Chequeando tu acceso seguro...</p>
        </div>
      </main>
    );
  }

  if (!session) {
    return <LoginPanel />;
  }

  if (session.needsOnboarding) {
    return <BusinessSetupPanel />;
  }

  return (
    <AppStoreProvider>
      <MetaSyncBridge />
      <Shell />
    </AppStoreProvider>
  );
}
