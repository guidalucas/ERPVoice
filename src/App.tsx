import { DashboardPanel } from './components/dashboard/DashboardPanel';
import { WhatsAppSimulator } from './components/split/WhatsAppSimulator';
import { MetaSyncBridge } from './components/dashboard/MetaSyncBridge';
import { AppStoreProvider } from './store/AppStore';

function Shell() {
  return (
    <main className="min-h-screen bg-mesh-soft text-slate-100">
      <div className="mx-auto min-h-screen max-w-[1600px] px-4 py-4 lg:px-6 lg:py-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-[1.75rem] border border-white/10 bg-slate-950/70 px-5 py-4 shadow-glow backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
                <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Zm5-3a1 1 0 1 0-2 0 3 3 0 0 1-6 0 1 1 0 1 0-2 0 5 5 0 0 0 4 4.9V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-3.1a5 5 0 0 0 4-4.9Z" />
              </svg>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.35em] text-emerald-300">ERPVoice</p>
              <h1 className="font-display text-xl font-bold tracking-tight text-white">Voice-first stock management</h1>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span>MVP Demo</span>
          </div>
        </header>

        <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/55 p-4 shadow-glow backdrop-blur-xl lg:p-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(25,195,125,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.06),transparent_24%)]" />
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
    <AppStoreProvider>
      <MetaSyncBridge />
      <Shell />
    </AppStoreProvider>
  );
}