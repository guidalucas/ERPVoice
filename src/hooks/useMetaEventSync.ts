import { useEffect, useRef } from 'react';
import type { Client, Pedido, Product, Transaction } from '../domain/types';
import { useAppStore } from '../store/AppStore';
import { requestJson } from '../services/apiClient';

type PersistedStateSnapshot = {
  products: Product[];
  clients: Client[];
  pedidos?: Pedido[];
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

        const normalized = {
          products: snapshot.products,
          clients: snapshot.clients,
          pedidos: snapshot.pedidos ?? [],
          transactions: snapshot.transactions,
        };

        const serialized = JSON.stringify(normalized);

        if (serialized !== lastSnapshotRef.current) {
          lastSnapshotRef.current = serialized;
          hydratePersistedState(normalized);
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
