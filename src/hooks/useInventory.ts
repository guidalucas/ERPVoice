import { useAppStore } from '../store/AppStore';
import {
  applyStateActions,
  createClient,
  createPedido,
  createProduct,
  createProductModel,
  createProveedor,
  deleteClient,
  deletePedido,
  deleteProduct,
  deleteProducts,
  deleteProveedor,
  fetchPersistedState,
  mergeClients,
  mergeProveedores,
  previewInventorySelection,
  updateClient,
  updatePedido,
  updateProduct,
  updateProductModel,
  updateProveedor,
} from '../services/productService';
import type { Client, ParsedActionUnion, Pedido, PedidoEstado, Product, Proveedor } from '../domain/types';
import type { ProductAdjustment } from '../services/productService';

export const useInventory = () => {
  const { state, confirmPendingProposal, clearPendingProposal, hydratePersistedState } = useAppStore();

  const hydrateFromSnapshot = (snapshot: {
    products: Product[];
    clients: Client[];
    proveedores?: Proveedor[];
    pedidos?: Pedido[];
    transactions: typeof state.transactions;
  }) => {
    hydratePersistedState({
      products: snapshot.products,
      clients: snapshot.clients,
      proveedores: snapshot.proveedores ?? [],
      pedidos: snapshot.pedidos ?? [],
      transactions: snapshot.transactions,
    });
  };

  const refreshState = async () => {
    const snapshot = await fetchPersistedState();
    hydrateFromSnapshot(snapshot);
  };

  const applyActions = async (sourceText: string, actions: ParsedActionUnion[], operationId?: string) => {
    const snapshot = await applyStateActions(sourceText, actions, operationId);
    hydrateFromSnapshot(snapshot);
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

  const createProductModelRecords = async (input: { productType: string; productModel: string; variants: Array<{ size: string; stockAvailable: number; price: number }> }) => {
    await createProductModel(input);
    await refreshState();
  };

  const updateProductRecord = async (productId: string, input: Partial<Omit<Product, 'id'>>, adjustment: ProductAdjustment) => {
    if (!Number.isSafeInteger(adjustment.expectedRevision) || adjustment.expectedRevision < 0) {
      throw new Error('Falta la revisión del producto. Actualizá la página y volvé a abrir el formulario.');
    }
    await updateProduct(productId, {
      ...input,
      productType: input.productType ?? undefined,
      productModel: input.productModel ?? undefined,
      size: input.size ?? undefined,
    }, adjustment);
    await refreshState();
  };

  const updateProductModelRecords = async (input: { selectionId: string; digest: string }) => {
    await updateProductModel(input);
    await refreshState();
  };

  const deleteProductRecord = async (productId: string) => {
    await deleteProduct(productId);
    await refreshState();
  };

  const deleteProductRecords = async (ids: string[]) => {
    await deleteProducts(ids);
    await refreshState();
  };

  const createClientRecord = async (input: { name: string; notas?: string | null }) => {
    const client = await createClient(input);
    await refreshState();
    return client;
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
    hydrateFromSnapshot(snapshot);
  };

  const createProveedorRecord = async (input: { name: string; notas?: string | null }) => {
    const proveedor = await createProveedor(input);
    await refreshState();
    return proveedor;
  };

  const updateProveedorRecord = async (proveedorId: string, input: Partial<Pick<Proveedor, 'name' | 'notas'>>) => {
    await updateProveedor(proveedorId, input);
    await refreshState();
  };

  const deleteProveedorRecord = async (proveedorId: string) => {
    await deleteProveedor(proveedorId);
    await refreshState();
  };

  const mergeProveedorRecords = async (keepId: string, mergeId: string) => {
    const snapshot = await mergeProveedores(keepId, mergeId);
    hydrateFromSnapshot(snapshot);
  };

  const createPedidoRecord = async (input: {
    clienteId: string;
    proveedorId?: string | null;
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
      proveedorId: input.proveedorId,
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
    proveedores: state.proveedores,
    pedidos: state.pedidos,
    transactions: state.transactions,
    pendingProposal: state.pendingProposal,
    confirmPendingProposal,
    clearPendingProposal,
    refreshState,
    applyActions,
    createProductRecord,
    createProductModelRecords,
    updateProductRecord,
    updateProductModelRecords,
    previewInventorySelection,
    deleteProductRecord,
    deleteProductRecords,
    createClientRecord,
    updateClientRecord,
    deleteClientRecord,
    mergeClientRecords,
    createProveedorRecord,
    updateProveedorRecord,
    deleteProveedorRecord,
    mergeProveedorRecords,
    createPedidoRecord,
    updatePedidoRecord,
    deletePedidoRecord,
  };
};
