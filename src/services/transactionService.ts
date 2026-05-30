import type { AppState, ParsedActionUnion as ParsedAction, Product, Transaction } from '../domain/types';

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const tokenize = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les'].includes(token));

const resolveProduct = (products: Product[], actionName: string) => {
  const actionTokens = tokenize(actionName);

  if (!actionTokens.length) {
    return products[0];
  }

  let bestProduct: Product | undefined;
  let bestScore = 0;

  for (const product of products) {
    const productTokens = tokenize(product.name);
    const score = actionTokens.filter((token) => productTokens.includes(token)).length;

    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  return bestProduct ?? products[0];
};

const calculateSaleDebt = (products: Product[], sellAction: { productName: string; qty: number }) => {
  const product = resolveProduct(products, sellAction.productName);

  if (!product) {
    return 0;
  }

  return product.price * sellAction.qty;
};

const calculateProductDebt = (products: Product[], debtAction: { productName?: string; qty?: number }) => {
  if (!debtAction.productName || typeof debtAction.qty !== 'number' || debtAction.qty <= 0) {
    return null;
  }

  const product = resolveProduct(products, debtAction.productName);

  if (!product) {
    return null;
  }

  return product.price * debtAction.qty;
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

  const debt = action as { type: 'add_debt'; clientName: string; amount: number };
  return `+$${debt.amount.toLocaleString('es-AR')} en cuenta de ${debt.clientName}`;
};

export const applyConfirmedActions = (state: AppState, actions: ParsedAction[], sourceText: string): AppState => {
  const nextProducts = state.products.map((product) => ({ ...product }));
  const nextClients = state.clients.map((client) => ({ ...client }));
  const newTransactions: Transaction[] = [];
  const lastSellAction = [...actions].reverse().find((action) => action.type === 'sell') as { type: 'sell'; productName: string; qty: number } | undefined;
  const computedDebtAmount = lastSellAction ? calculateSaleDebt(nextProducts, lastSellAction) : null;

  actions.forEach((action, index) => {
    if (action.type === 'add_stock') {
      const product = resolveProduct(nextProducts, action.productName);

      if (product) {
        product.stockAvailable += action.qty;
      }
    }

    if (action.type === 'reserve_stock') {
      const product = resolveProduct(nextProducts, action.productName);

      if (product) {
        const reservationQty = Math.min(product.stockAvailable, action.qty);
        product.stockAvailable -= reservationQty;
        product.stockReserved += reservationQty;
      }
    }

    if ((action as any).type === 'sell' || (action as any).type === 'venta') {
      const sellAction = action as { type: string; productName: string; qty: number };
      const product = resolveProduct(nextProducts, sellAction.productName);

      if (product) {
        const sellQty = Math.min(product.stockAvailable, sellAction.qty);
        product.stockAvailable -= sellQty;
      }
    }

    if (action.type === 'add_debt') {
      const debtAction = action as { type: 'add_debt'; clientName: string; amount: number };
      const client = nextClients.find((entry) => entry.name.toLowerCase() === debtAction.clientName.toLowerCase()) ?? nextClients[0]!;

      const productDebtAmount = calculateProductDebt(nextProducts, debtAction as { productName?: string; qty?: number });
      const amountToApply = productDebtAmount && productDebtAmount > 0
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
    transactions: [...newTransactions.reverse(), ...state.transactions],
    pendingProposal: null,
  };
};