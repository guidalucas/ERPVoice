import { useAppStore } from '../store/AppStore';

export const useInventory = () => {
  const { state, confirmPendingProposal, clearPendingProposal } = useAppStore();

  return {
    products: state.products,
    clients: state.clients,
    transactions: state.transactions,
    pendingProposal: state.pendingProposal,
    confirmPendingProposal,
    clearPendingProposal,
  };
};