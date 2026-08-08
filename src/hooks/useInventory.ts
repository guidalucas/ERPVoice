import { useAppStore } from '../store/AppStore';
import {
  createClient,
  createPedido,
  createProduct,
  deleteClient,
  deletePedido,
  deleteProduct,
  fetchPersistedState,
  mergeClients,
  updateClient,
  updatePedido,
  updateProduct,
} from '../services/productService';
import type { Client, Pedido, PedidoEstado, Product } from '../domain/types';

export const useInventory = () => {
  const { state, confirmPendingProposal, clearPendingProposal, hydratePersistedState } = useAppStore();

  const refreshState = async () => {
    const snapshot = await fetchPersistedState();
    hydratePersistedState({
      products: snapshot.products,
      clients: snapshot.clients,
      pedidos: snapshot.pedidos ?? [],
      transactions: snapshot.transactions,
    });
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

  const createClientRecord = async (input: { name: string; notas?: string | null }) => {
    await createClient(input);
    await refreshState();
  };

  const updateClientRecord = async (clientId: string, input: Partial<Pick<Client, 'name' | 'notas' | 'debt'>>) => {
    await updateClient(clientId, input);
    await refreshState();
  };

  const deleteClientRecord = async (clientId: string) => {
    await deleteClient(clientId);
    await refreshState();
  };

  const mergeClientRecords = async (keepId: string, mergeId: string) => {
    const snapshot = await mergeClients(keepId, mergeId);
    hydratePersistedState({
      products: snapshot.products,
      clients: snapshot.clients,
      pedidos: snapshot.pedidos ?? [],
      transactions: snapshot.transactions,
    });
  };

  const createPedidoRecord = async (input: {
    clienteId: string;
    producto: string;
    productType?: string | null;
    productModel?: string | null;
    talle?: string | null;
    qty?: number;
    estado?: PedidoEstado;
    notas?: string | null;
  }) => {
    await createPedido(input);
    await refreshState();
  };

  const updatePedidoRecord = async (pedidoId: string, input: Partial<Omit<Pedido, 'id' | 'fechaPedido'>>) => {
    await updatePedido(pedidoId, {
      clienteId: input.clienteId,
      producto: input.producto,
      productType: input.productType,
      productModel: input.productModel,
      talle: input.talle,
      qty: input.qty,
      estado: input.estado,
      notas: input.notas,
    });
    await refreshState();
  };

  const deletePedidoRecord = async (pedidoId: string) => {
    await deletePedido(pedidoId);
    await refreshState();
  };

  return {
    products: state.products,
    clients: state.clients,
    pedidos: state.pedidos,
    transactions: state.transactions,
    pendingProposal: state.pendingProposal,
    confirmPendingProposal,
    clearPendingProposal,
    refreshState,
    createProductRecord,
    updateProductRecord,
    deleteProductRecord,
    createClientRecord,
    updateClientRecord,
    deleteClientRecord,
    mergeClientRecords,
    createPedidoRecord,
    updatePedidoRecord,
    deletePedidoRecord,
  };
};
