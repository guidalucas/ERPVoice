import type { AppState, Client, ParsedActionUnion as ParsedAction, Pedido, Product, Transaction } from '../domain/types';
import { matchProductsForUpdate } from '../domain/stockQuery';

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeText = (value: string) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const titleCase = (value: string) =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const tokenize = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les'].includes(token));

const slugify = (value: string) =>
  normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'nuevo-producto';

const normalizeOptionalText = (value: string | null | undefined) => {
  const trimmed = String(value ?? '').trim();
  return trimmed.length ? normalizeText(trimmed) : '';
};

type ProductMatchInput = {
  productName: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  price?: number | null;
};

const createProduct = (name: string, index: number, metadata: Partial<Pick<Product, 'productType' | 'productModel' | 'size' | 'price'>> = {}): Product => ({
  id: `product-${slugify(name)}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
  name: name.trim(),
  productType: metadata.productType ?? null,
  productModel: metadata.productModel ?? null,
  size: metadata.size ?? null,
  stockAvailable: 0,
  stockReserved: 0,
  price: Number.isFinite(metadata.price ?? 0) ? metadata.price ?? 0 : 0,
});

const matchesMetadata = (product: Product, action: ProductMatchInput) => {
  const normalizedActionType = normalizeOptionalText(action.productType);
  const normalizedActionModel = normalizeOptionalText(action.productModel);
  const normalizedActionSize = normalizeOptionalText(action.size);
  const normalizedProductSize = normalizeOptionalText(product.size);

  if (normalizedActionType && normalizeOptionalText(product.productType) !== normalizedActionType) {
    return false;
  }

  if (normalizedActionModel && normalizeOptionalText(product.productModel) !== normalizedActionModel) {
    return false;
  }

  if (normalizedActionSize && normalizedProductSize && normalizedProductSize !== normalizedActionSize) {
    return false;
  }

  return true;
};

const resolveProduct = (products: Product[], action: ProductMatchInput) => {
  const actionTokens = tokenize(action.productName);
  const normalizedActionName = normalizeOptionalText(action.productName);
  const hasMetadata = Boolean(normalizeOptionalText(action.productType) || normalizeOptionalText(action.productModel) || normalizeOptionalText(action.size));

  if (!actionTokens.length) {
    return null;
  }

  let bestProduct: Product | undefined;
  let bestScore = 0;
  let bestSpecificScore = 0;

  for (const product of products) {
    if (hasMetadata && !matchesMetadata(product, action)) {
      continue;
    }

    const productTokens = tokenize(product.name);
    const normalizedProductName = normalizeOptionalText(product.name);

    if (normalizedActionName && normalizedProductName && (normalizedProductName.includes(normalizedActionName) || normalizedActionName.includes(normalizedProductName))) {
      return product;
    }

    const matchingTokens = actionTokens.filter((token) => productTokens.includes(token));
    const score = matchingTokens.length;
    const sizesMatch =
      normalizeOptionalText(action.size) && normalizeOptionalText(product.size)
        ? normalizeOptionalText(action.size) === normalizeOptionalText(product.size)
        : false;
    const specificScore =
      matchingTokens.filter((token) => !['camiseta', 'titular', 'suplente', 'talle', 'con', 'de', 'del', 'los', 'las', 'por', 'para', 's', 'm', 'l', 'xl', 'xxl'].includes(token)).length +
      (sizesMatch ? 1 : 0);

    if (score > bestScore || (score === bestScore && specificScore > bestSpecificScore)) {
      bestScore = score;
      bestSpecificScore = specificScore;
      bestProduct = product;
    }
  }

  if (hasMetadata) {
    return bestProduct ?? null;
  }

  if (bestScore < 2 || bestSpecificScore < 1) {
    return null;
  }

  return bestProduct ?? null;
};

const ensureProduct = (products: Product[], action: ProductMatchInput) => {
  const resolvedProduct = resolveProduct(products, action);

  if (resolvedProduct) {
    if (typeof action.price === 'number' && action.price > 0 && (!resolvedProduct.price || resolvedProduct.price === 0)) {
      resolvedProduct.price = action.price;
    }
    return { product: resolvedProduct, created: false };
  }

  const product = createProduct(action.productName, products.length, {
    productType: action.productType ?? null,
    productModel: action.productModel ?? null,
    size: action.size ?? null,
    price: typeof action.price === 'number' ? action.price : undefined,
  });
  products.push(product);
  return { product, created: true };
};

const calculateSaleDebt = (products: Product[], sellAction: ProductMatchInput & { qty: number }) => {
  const product = resolveProduct(products, sellAction);
  if (!product) {
    return 0;
  }
  return product.price * sellAction.qty;
};

const calculateProductDebt = (products: Product[], debtAction: Partial<ProductMatchInput> & { qty?: number }) => {
  if (!debtAction.productName || typeof debtAction.qty !== 'number' || debtAction.qty <= 0) {
    return null;
  }

  const product = resolveProduct(products, {
    productName: debtAction.productName,
    productType: debtAction.productType,
    productModel: debtAction.productModel,
    size: debtAction.size,
  });

  if (!product) {
    return null;
  }

  return product.price * debtAction.qty;
};

const resolveOrCreateClient = (clients: Client[], clientName?: string) => {
  const resolvedName = String(clientName ?? '').trim() || 'Sin cliente';
  const target = normalizeText(resolvedName).trim();
  const exactMatches = clients.filter((entry) => normalizeText(entry.name).trim() === target);

  if (exactMatches.length === 1) {
    return exactMatches[0]!;
  }

  const created: Client = {
    id: createId('client'),
    name: titleCase(resolvedName),
    debt: 0,
    notas: resolvedName === 'Sin cliente' ? 'Pedidos sin cliente asignado' : null,
  };
  clients.push(created);
  return created;
};

const buildPedidoProducto = (action: Extract<ParsedAction, { type: 'client_order' }>) => {
  const parts = [action.productType, action.productModel].map((value) => String(value ?? '').trim()).filter(Boolean);
  if (parts.length) {
    return parts.join(' ');
  }

  return action.productName.replace(/(?:,\s*|\s+)talle\s+[a-z0-9]+\b/i, '').trim() || action.productName;
};

const summarizeAction = (action: ParsedAction) => {
  if (action.type === 'add_stock') {
    return `+${action.qty} stock para ${action.productName}`;
  }

  if (action.type === 'reserve_stock') {
    return `-${action.qty} reservado para ${action.productName}`;
  }

  if (action.type === 'sell') {
    return `-${action.qty} vendidos de ${action.productName}`;
  }

  if (action.type === 'payment_received') {
    return `-$${action.amount.toLocaleString('es-AR')} cobrado a ${action.clientName}`;
  }

  if (action.type === 'client_order') {
    const qty = action.qty && action.qty > 0 ? action.qty : 1;
    const sizeLabel = action.size ? ` talle ${action.size}` : '';
    if (action.clientName?.trim()) {
      return `Pedido: ${action.clientName} pidió ${qty} ${action.productName}${sizeLabel}`;
    }
    return `Pedido: ${qty} ${action.productName}${sizeLabel}`;
  }

  if (action.type === 'update_product') {
    const parts = [];
    if (Number.isFinite(action.price) && (action.price as number) > 0) {
      parts.push(`precio $${Number(action.price).toLocaleString('es-AR')}`);
    }
    if (Number.isFinite(action.stockAvailable as number)) {
      parts.push(`stock ${action.stockAvailable}`);
    }
    return `Actualizar ${action.productName}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'update_pedido') {
    const parts = [];
    if (Number.isFinite(action.qty as number) && (action.qty as number) > 0) {
      parts.push(`cantidad ${action.qty}`);
    }
    if (action.size) {
      parts.push(`variante ${action.size}`);
    }
    if (action.estado) {
      parts.push(`estado ${action.estado}`);
    }
    return `Actualizar pedido ${action.productName}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'delete_pedido') {
    return `Eliminar pedido ${action.productName}`;
  }

  if (action.type === 'delete_product') {
    return `Eliminar producto ${action.productName}`;
  }

  const debt = action as { type: 'add_debt'; clientName: string; amount: number };
  return `+$${debt.amount.toLocaleString('es-AR')} en cuenta de ${debt.clientName}`;
};

export const applyConfirmedActions = (state: AppState, actions: ParsedAction[], sourceText: string): AppState => {
  const nextProducts = state.products.map((product) => ({ ...product }));
  const nextClients = state.clients.map((client) => ({ ...client }));
  const nextPedidos = [...state.pedidos];
  const newTransactions: Transaction[] = [];
  const lastSellAction = [...actions].reverse().find((action) => action.type === 'sell') as { type: 'sell'; productName: string; qty: number } | undefined;
  const computedDebtAmount = lastSellAction ? calculateSaleDebt(nextProducts, lastSellAction) : null;

  actions.forEach((action, index) => {
    if (action.type === 'add_stock') {
      const { product } = ensureProduct(nextProducts, action);
      product.stockAvailable += action.qty;
    }

    if (action.type === 'reserve_stock') {
      const { product } = ensureProduct(nextProducts, action);
      const reservationQty = Math.min(product.stockAvailable, action.qty);
      product.stockAvailable -= reservationQty;
      product.stockReserved += reservationQty;
    }

    if ((action as { type: string }).type === 'sell' || (action as { type: string }).type === 'venta') {
      const sellAction = action as { type: string; productName: string; qty: number };
      const { product } = ensureProduct(nextProducts, sellAction);
      const sellQty = Math.min(product.stockAvailable, sellAction.qty);
      product.stockAvailable -= sellQty;
    }

    if (action.type === 'add_debt') {
      const debtAction = action as { type: 'add_debt'; clientName: string; amount: number };
      const client = nextClients.find((entry) => entry.name.toLowerCase() === debtAction.clientName.toLowerCase()) ?? nextClients[0]!;

      const productDebtAmount = calculateProductDebt(nextProducts, debtAction as { productName?: string; qty?: number });
      const amountToApply =
        productDebtAmount && productDebtAmount > 0
          ? productDebtAmount
          : computedDebtAmount && computedDebtAmount > 0
            ? computedDebtAmount
            : debtAction.amount;
      client.debt += amountToApply;

      action = {
        ...action,
        amount: amountToApply,
      };
    }

    if (action.type === 'payment_received') {
      const paymentAction = action as { type: 'payment_received'; clientName: string; amount: number };
      const client = nextClients.find((entry) => entry.name.toLowerCase() === paymentAction.clientName.toLowerCase()) ?? nextClients[0]!;
      client.debt = Math.max(0, client.debt - paymentAction.amount);
    }

    if (action.type === 'client_order') {
      const client = resolveOrCreateClient(nextClients, action.clientName);
      const qty = action.qty && action.qty > 0 ? action.qty : 1;
      const pedido: Pedido = {
        id: createId('pedido'),
        clienteId: client.id,
        producto: buildPedidoProducto(action),
        productType: action.productType ?? null,
        productModel: action.productModel ?? null,
        talle: action.size ?? null,
        qty,
        estado: 'pendiente',
        fechaPedido: new Date().toISOString(),
        notas: action.notas ?? null,
      };
      nextPedidos.unshift(pedido);
    }

    if (action.type === 'update_product') {
      const productsToUpdate = matchProductsForUpdate(nextProducts, action);
      for (const product of productsToUpdate) {
        if (Number.isFinite(action.price) && (action.price as number) > 0) {
          product.price = Math.trunc(action.price as number);
        }
        if (Number.isFinite(action.stockAvailable as number) && (action.stockAvailable as number) >= 0) {
          product.stockAvailable = Math.trunc(action.stockAvailable as number);
        }
      }
    }

    if (action.type === 'update_pedido') {
      const query = normalizeText(action.productName);
      const pedido = nextPedidos.find((entry) => {
        const haystack = normalizeText([entry.producto, entry.productType, entry.productModel, entry.talle].filter(Boolean).join(' '));
        return haystack.includes(query) || query.includes(normalizeText(entry.producto));
      });
      if (pedido) {
        if (Number.isFinite(action.qty as number) && (action.qty as number) > 0) {
          pedido.qty = Math.trunc(action.qty as number);
        }
        if (action.size?.trim()) {
          pedido.talle = action.size.trim().toUpperCase();
        }
        if (action.estado) {
          pedido.estado = action.estado;
        }
      }
    }

    if (action.type === 'delete_pedido') {
      const query = normalizeText(action.productName);
      const pedidoIndex = nextPedidos.findIndex((entry) => {
        const haystack = normalizeText([entry.producto, entry.productType, entry.productModel, entry.talle].filter(Boolean).join(' '));
        return haystack.includes(query) || query.includes(normalizeText(entry.producto));
      });
      if (pedidoIndex >= 0) {
        nextPedidos.splice(pedidoIndex, 1);
      }
    }

    if (action.type === 'delete_product') {
      const product = resolveProduct(nextProducts, action);
      if (product) {
        const productIndex = nextProducts.findIndex((entry) => entry.id === product.id);
        if (productIndex >= 0) {
          nextProducts.splice(productIndex, 1);
        }
      }
    }

    newTransactions.push({
      id: createId(`transaction-${index + 1}`),
      timestamp: new Date().toISOString(),
      sourceText,
      actions: [action],
      summary: summarizeAction(action),
    });
  });

  return {
    ...state,
    products: nextProducts,
    clients: nextClients,
    pedidos: nextPedidos,
    transactions: [...newTransactions.reverse(), ...state.transactions],
    pendingProposal: null,
  };
};
