import type { ChatMessage } from '../../domain/types';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';

interface ChatBubbleProps {
  message: ChatMessage;
}

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

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isUser ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/15' : 'bg-slate-200 text-slate-900 dark:bg-[#172337] dark:text-slate-100'
        }`}
      >
        <p>{message.text}</p>
        {message.parsedPayload && (
          <div className="mt-3 space-y-2 rounded-2xl bg-sky-500/10 p-3 text-xs text-slate-700 dark:bg-sky-950/35 dark:text-slate-200">
            {message.parsedPayload.actions.map((action, index) => (
              <p key={`${message.id}-${index}`}>
                {action.type === 'add_stock' && `${index + 1}. add_stock ${describeProduct(action)} x${action.qty}`}
                {action.type === 'reserve_stock' && `${index + 1}. reserve_stock ${describeProduct(action)} x${action.qty}${action.clientName ? ` -> ${action.clientName}` : ''}`}
                {action.type === 'sell' && `${index + 1}. sell ${describeProduct(action)} x${action.qty}`}
                {action.type === 'payment_received' && `${index + 1}. payment_received ${action.clientName} $${action.amount.toLocaleString('es-AR')}`}
                {action.type === 'add_debt' && `${index + 1}. add_debt ${action.clientName} $${action.amount.toLocaleString('es-AR')}`}
                {action.type === 'client_order' && `${index + 1}. client_order ${action.clientName ? `${action.clientName} -> ` : ''}${describeProduct(action)} x${action.qty ?? 1}`}
                {action.type === 'update_product' && `${index + 1}. update_product ${describeProduct(action)}${action.price ? ` $${action.price.toLocaleString('es-AR')}` : ''}${Number.isFinite(action.stockAvailable) ? ` stock ${action.stockAvailable}` : ''}`}
                {action.type === 'update_pedido' && `${index + 1}. update_pedido ${action.productName}${action.qty ? ` qty ${action.qty}` : ''}${action.size ? ` ${(preset.variantLabel ?? 'variante').toLowerCase()} ${action.size}` : ''}${action.estado ? ` ${action.estado}` : ''}`}
                {action.type === 'delete_pedido' && `${index + 1}. delete_pedido ${action.productName}`}
                {action.type === 'delete_product' && `${index + 1}. delete_product ${describeProduct(action)}`}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
