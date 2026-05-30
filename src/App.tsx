import { AppStoreProvider } from './store/AppStore';
import { DashboardPanel } from './components/dashboard/DashboardPanel';
import { WhatsAppSimulator } from './components/split/WhatsAppSimulator';
import { TwilioSyncBridge } from './components/dashboard/TwilioSyncBridge';

function Shell() {
  return (
    <main className="min-h-screen bg-mesh-soft text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-5 px-4 py-4 lg:flex-row lg:p-6">
        <div className="lg:w-[38%] xl:w-[34%]">
          <WhatsAppSimulator />
        </div>
        <div className="lg:w-[62%] xl:w-[66%]">
          <DashboardPanel />
        </div>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <AppStoreProvider>
      <TwilioSyncBridge />
      <Shell />
    </AppStoreProvider>
  );
}