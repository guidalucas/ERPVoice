import { useAppStore } from '../store/AppStore';
import { createProduct, deleteProduct, fetchPersistedState, updateProduct } from '../services/productService';
import type { Product } from '../domain/types';

export const useInventory = () => {
  const { state, confirmPendingProposal, clearPendingProposal, hydratePersistedState } = useAppStore();

  const refreshState = async () => {
    const snapshot = await fetchPersistedState();
    hydratePersistedState(snapshot);
  };

  const createProductRecord = async (input: Omit<Product, 'id'> & { name: string }) => {
    await createProduct({
      ...input,
      productType: input.productType ?? undefined,
      productModel: input.productModel ?? undefined,
      size: input.size ?? undefined,
    });
    await refreshState();
  };

  const updateProductRecord = async (productId: string, input: Partial<Omit<Product, 'id'>>) => {
    await updateProduct(productId, {
      ...input,
      productType: input.productType ?? undefined,
      productModel: input.productModel ?? undefined,
      size: input.size ?? undefined,
    });
    await refreshState();
  };

  const deleteProductRecord = async (productId: string) => {
    await deleteProduct(productId);
    await refreshState();
  };

  return {
    products: state.products,
    clients: state.clients,
    transactions: state.transactions,
    pendingProposal: state.pendingProposal,
    confirmPendingProposal,
    clearPendingProposal,
    refreshState,
    createProductRecord,
    updateProductRecord,
    deleteProductRecord,
  };
};