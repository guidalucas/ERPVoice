import type { ChatMessage } from '../../domain/types';

interface ChatBubbleProps {
  message: ChatMessage;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user';
  const describeProduct = (action: { productName: string; productType?: string; productModel?: string; size?: string }) => {
    const parts = [action.productType, action.productModel, action.size].filter((value): value is string => Boolean(value));
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
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}