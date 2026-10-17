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
  reconcilePedido,
  updateProduct,
  updateProductModel,
  updateProveedor,
} from '../services/productService';
import type { Client, ParsedActionUnion, Pedido, PedidoEstado, Product, Proveedor } from '../domain/types';
import type { InventorySelectionReference, ProductAdjustment, ProductCreation, ProductInput, ProductModelInput } from '../services/productService';

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

  const createProductRecord = async (input: ProductInput, metadata: ProductCreation) => {
    await createProduct(input, metadata);
    await refreshState();
  };

  const createProductModelRecords = async (input: ProductModelInput, metadata: ProductCreation) => {
    await createProductModel(input, metadata);
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

  const deleteProductRecord = async (productId: string, selection: InventorySelectionReference) => {
    await deleteProduct(productId, selection);
    await refreshState();
  };

  const deleteProductRecords = async (selection: InventorySelectionReference) => {
    await deleteProducts(selection);
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

  const mergeClientRecords = async (keepId: string, mergeId: string, metadata: Parameters<typeof mergeClients>[2]) => {
    const snapshot = await mergeClients(keepId, mergeId, metadata);
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
    operationId: string;
    productId?: string | null;
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

  const updatePedidoRecord = async (pedidoId: string, input: Partial<Omit<Pedido, 'id' | 'fechaPedido' | 'revision' | 'stockPosting'>> & { operationId: string; expectedRevision: number }) => {
    await updatePedido(pedidoId, {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      productId: input.productId,
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

  const deletePedidoRecord = async (pedidoId: string, metadata: { operationId: string; expectedRevision: number }) => {
    await deletePedido(pedidoId, metadata);
    await refreshState();
  };
  const reconcilePedidoRecord = async (pedidoId: string, input: Parameters<typeof reconcilePedido>[1]) => {
    const receipt = await reconcilePedido(pedidoId,input);
    await refreshState();
    return receipt;
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
    reconcilePedidoRecord,
  };
};
