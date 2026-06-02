import { useEffect, useRef } from 'react';
import type { Client, Product, Transaction } from '../domain/types';
import { useAppStore } from '../store/AppStore';
import { requestJson } from '../services/apiClient';

type PersistedStateSnapshot = {
  products: Product[];
  clients: Client[];
  transactions: Transaction[];
};

export const useMetaEventSync = () => {
  const { hydratePersistedState } = useAppStore();
  const lastSnapshotRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    lastSnapshotRef.current = '';

    const loadSnapshot = async () => {
      try {
        const snapshot = await requestJson<PersistedStateSnapshot>('/api/state');

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