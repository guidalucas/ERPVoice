import { useEffect, useRef } from 'react';
import type { Client, ParsedActionUnion, Product, Transaction } from '../domain/types';
import { useAppStore } from '../store/AppStore';

type PersistedStateSnapshot = {
  products: Product[];
  clients: Client[];
  transactions: Transaction[];
};

const META_API_BASE = import.meta.env.VITE_META_API_BASE ?? import.meta.env.VITE_TWILIO_API_BASE ?? 'http://localhost:3001';

export const useMetaEventSync = () => {
  const { hydratePersistedState } = useAppStore();
  const lastSnapshotRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async () => {
      try {
        const response = await fetch(`${META_API_BASE}/api/state`);

        if (!response.ok) {
          return;
        }

        const snapshot = (await response.json()) as PersistedStateSnapshot;

        if (cancelled || !snapshot || !Array.isArray(snapshot.products) || !Array.isArray(snapshot.clients) || !Array.isArray(snapshot.transactions)) {
          return;
        }

        const serialized = JSON.stringify(snapshot);

        if (serialized !== lastSnapshotRef.current) {
          lastSnapshotRef.current = serialized;
          hydratePersistedState(snapshot);
        }
      } catch {
        // Intentionally silent: dashboard sync is best-effort.
      }
    };

    loadSnapshot();
    const intervalId = window.setInterval(loadSnapshot, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hydratePersistedState]);
};