import type { ChatMessage, ParsedActionUnion } from '../../domain/types';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';

interface ChatBubbleProps {
  message: ChatMessage;
}

const formatActionLines = (
  actions: ParsedActionUnion[],
  describeProduct: (action: { productName: string; productType?: string; productModel?: string; size?: string }) => string,
  variantLabel: string,
): string[] => {
  const lines: string[] = [];
  let orderBuffer: Extract<ParsedActionUnion, { type: 'client_order' }>[] = [];
  let otherIndex = 0;

  const flushOrders = () => {
    if (!orderBuffer.length) {
      return;
    }

    const uniqueNames = (items: typeof orderBuffer, field: 'clientName' | 'proveedorName') => {
      const names: string[] = [];
      for (const item of items) {
        const name = item[field]?.trim() || '';
        if (name && !names.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
          names.push(name);
        }
      }
      return names;
    };

    const formatOrderHeader = (items: typeof orderBuffer) => {
      const clients = uniqueNames(items, 'clientName');
      const proveedores = uniqueNames(items, 'proveedorName');
      if (clients.length === 1 && proveedores.length === 1) {
        return `Pedido de ${clients[0]} · proveedor ${proveedores[0]}`;
      }
      if (clients.length === 1) {
        return `Pedido de ${clients[0]}`;
      }
      if (proveedores.length === 1) {
        return `Pedido al proveedor ${proveedores[0]}`;
      }
      return 'Pedido';
    };

    const groups = new Map<string, { items: typeof orderBuffer }>();
    for (const action of orderBuffer) {
      const clientName = action.clientName?.trim() || '';
      const proveedorName = action.proveedorName?.trim() || '';
      const key = clientName
        ? `client:${clientName.toLowerCase()}`
        : proveedorName
          ? `proveedor:${proveedorName.toLowerCase()}`
          : 'pedido';
      const current = groups.get(key) ?? { items: [] };
      current.items.push(action);
      groups.set(key, current);
    }

    for (const group of groups.values()) {
      const includeProveedor = uniqueNames(group.items, 'proveedorName').length > 1;
      lines.push(formatOrderHeader(group.items));
      for (const item of group.items) {
        const qty = item.qty && item.qty > 0 ? item.qty : 1;
        const proveedorLabel =
          includeProveedor && item.proveedorName?.trim() ? ` · proveedor ${item.proveedorName.trim()}` : '';
        lines.push(`• ${qty} ${describeProduct(item)}${proveedorLabel}`);
      }
    }
    orderBuffer = [];
  };

  const nextIndex = () => {
    otherIndex += 1;
    return otherIndex;
  };

  for (const action of actions) {
    if (action.type === 'client_order') {
      orderBuffer.push(action);
      continue;
    }

    flushOrders();

    if (action.type === 'add_stock') {
      lines.push(`${nextIndex()}. add_stock ${describeProduct(action)} x${action.qty}`);
    } else if (action.type === 'reserve_stock') {
      lines.push(`${nextIndex()}. reserve_stock ${describeProduct(action)} x${action.qty}${action.clientName ? ` -> ${action.clientName}` : ''}`);
    } else if (action.type === 'sell') {
      lines.push(`${nextIndex()}. sell ${describeProduct(action)} x${action.qty}`);
    } else if (action.type === 'payment_received') {
      lines.push(`${nextIndex()}. payment_received ${action.clientName} $${action.amount.toLocaleString('es-AR')}`);
    } else if (action.type === 'add_debt') {
      lines.push(`${nextIndex()}. add_debt ${action.clientName} $${action.amount.toLocaleString('es-AR')}`);
    } else if (action.type === 'update_product') {
      lines.push(`${nextIndex()}. update_product ${describeProduct(action)}${action.price ? ` $${action.price.toLocaleString('es-AR')}` : ''}${Number.isFinite(action.stockAvailable) ? ` stock ${action.stockAvailable}` : ''}`);
    } else if (action.type === 'update_pedido') {
      lines.push(`${nextIndex()}. update_pedido ${action.productName}${action.qty ? ` qty ${action.qty}` : ''}${action.size ? ` ${variantLabel} ${action.size}` : ''}${action.estado ? ` ${action.estado}` : ''}`);
    } else if (action.type === 'delete_pedido') {
      lines.push(`${nextIndex()}. delete_pedido ${action.productName}`);
    } else if (action.type === 'delete_product') {
      lines.push(`${nextIndex()}. delete_product ${describeProduct(action)}`);
    }
  }

  flushOrders();
  return lines;
};

export function ChatBubble({ message }: ChatBubbleProps) {
  const preset = useBusinessCategoryPreset();
  const isUser = message.role === 'user';
  const describeProduct = (action: { productName: string; productType?: string; productModel?: string; size?: string }) => {
    const parts = [
      action.productType,
      action.productModel,
      preset.useVariants ? action.size : undefined,
    ].filter((value): value is string => Boolean(value));
    return parts.length ? `${parts.join(' / ')} -> ${action.productName}` : action.productName;
  };

  const actionLines = message.parsedPayload
    ? formatActionLines(message.parsedPayload.actions, describeProduct, (preset.variantLabel ?? 'variante').toLowerCase())
    : [];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isUser ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/15' : 'bg-slate-200 text-slate-900 dark:bg-[#172337] dark:text-slate-100'
        }`}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
        {actionLines.length > 0 && (
          <div className="mt-3 space-y-1 rounded-2xl bg-sky-500/10 p-3 text-xs text-slate-700 dark:bg-sky-950/35 dark:text-slate-200">
            {actionLines.map((line, index) => (
              <p key={`${message.id}-${index}`}>{line}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
