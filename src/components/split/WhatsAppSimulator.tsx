import { ChatBubble } from '../chat/ChatBubble';
import { useChatBot } from '../../hooks/useChatBot';

export function WhatsAppSimulator() {
  const {
    messages,
    draftText,
    setDraftText,
    pendingProposal,
    pendingActionsText,
    isProcessing,
    isRecording,
    isTranscribing,
    sendText,
    toggleRecording,
    onConfirm,
    onCancel,
  } = useChatBot();

  return (
    <section className="flex h-full flex-col rounded-[2rem] border border-slate-200 bg-[#e8f3ee] shadow-glow">
      <header className="border-b border-emerald-100 bg-[#0f172a] px-6 py-4 text-white">
        <p className="text-xs uppercase tracking-[0.35em] text-emerald-300">Simulador WhatsApp</p>
        <h2 className="font-display text-2xl font-bold">Voice First ERP</h2>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} />
        ))}
      </div>

      {pendingProposal && (
        <div className="mx-4 mb-4 rounded-3xl border border-emerald-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-600">Acciones detectadas</p>
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            {pendingActionsText.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600"
            >
              Confirmar Transacción
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              Cancelar/Editar
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
          <span>{isRecording ? 'Grabando audio...' : isTranscribing ? 'Transcribiendo audio...' : 'Podés escribir o grabar audio'}</span>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={toggleRecording}
            disabled={isProcessing || isTranscribing}
            className={`rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
              isRecording ? 'bg-rose-500 text-white hover:bg-rose-600' : 'border border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {isRecording ? 'Detener' : 'Grabar'}
          </button>

          <input
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                sendText();
              }
            }}
            placeholder="Pegá la transcripción del audio..."
            disabled={isRecording || isTranscribing}
            className="min-w-0 flex-1 rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-emerald-400"
          />
          <button
            type="button"
            onClick={sendText}
            disabled={isProcessing || isRecording || isTranscribing}
            className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isProcessing ? 'Procesando...' : 'Enviar'}
          </button>
        </div>
      </div>
    </section>
  );
}