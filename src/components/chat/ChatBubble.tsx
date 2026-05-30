import type { ChatMessage } from '../../domain/types';

interface ChatBubbleProps {
  message: ChatMessage;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isUser ? 'bg-emerald-500 text-white' : 'bg-white text-slate-800'
        }`}
      >
        <p>{message.text}</p>
        {message.parsedPayload && (
          <div className="mt-3 space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            {message.parsedPayload.actions.map((action, index) => (
              <p key={`${message.id}-${index}`}>
                {action.type === 'add_stock' && `${index + 1}. add_stock ${action.productName} x${action.qty}`}
                {action.type === 'reserve_stock' && `${index + 1}. reserve_stock ${action.productName} x${action.qty}${action.clientName ? ` -> ${action.clientName}` : ''}`}
                {action.type === 'sell' && `${index + 1}. sell ${action.productName} x${action.qty}`}
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