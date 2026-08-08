import { useState } from 'react';
import { ChatBubble } from '../chat/ChatBubble';
import { useChatBot } from '../../hooks/useChatBot';
import { StockyLogo } from '../brand/StockyLogo';

export function WhatsAppSimulator() {
  const [isOpen, setIsOpen] = useState(false);
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
    <div
      className={
        isOpen
          ? 'fixed inset-x-0 top-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-50 lg:inset-auto lg:bottom-4 lg:right-4 lg:top-auto'
          : 'fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-4 z-50 lg:bottom-4'
      }
    >
      {isOpen ? (
        <section className="flex h-full w-full flex-col overflow-hidden border-b border-emerald-950/50 bg-[#0b1424] shadow-2xl shadow-sky-950/40 lg:h-[min(42rem,calc(100dvh-2rem))] lg:w-[min(92vw,34rem)] lg:rounded-[1.35rem] lg:border">
          <header className="flex shrink-0 items-center justify-between gap-3 bg-[#12a65a] px-4 py-3 text-white pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="flex items-center gap-3">
              <div className="overflow-hidden rounded-full ring-2 ring-white/20">
                <StockyLogo size="sm" className="rounded-full" />
              </div>
              <div>
                <h2 className="text-[1.05rem] font-bold leading-tight">Stocky</h2>
                <p className="text-xs font-medium text-white/85">En línea</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-white/95 transition hover:bg-white/10"
              aria-label="Cerrar chat"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[2.2]">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#0b1424] px-3 py-3">
            {messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
          </div>

          {pendingProposal && (
            <div className="mx-3 mb-3 shrink-0 rounded-2xl border border-sky-500/15 bg-sky-500/10 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-sky-300">Acciones detectadas</p>
              <div className="mt-2 space-y-1 text-sm text-slate-200">
                {pendingActionsText.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={onConfirm}
                  className="rounded-xl bg-sky-500 px-3 py-2 font-semibold text-white transition hover:bg-sky-400"
                >
                  Confirmar
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-xl border border-sky-500/15 bg-sky-500/10 px-3 py-2 font-semibold text-sky-100 transition hover:bg-sky-500/15"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          <div className="shrink-0 border-t border-emerald-950/50 bg-[#0b1424] px-3 py-3">
            <div className="flex items-end gap-3">
              <button
                type="button"
                onClick={toggleRecording}
                disabled={isProcessing || isTranscribing}
                aria-label={isRecording ? 'Detener grabación' : 'Grabar audio'}
                className={`mb-0.5 flex h-11 w-11 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  isRecording ? 'bg-rose-500 text-white hover:bg-rose-600' : 'text-emerald-400 hover:bg-white/5'
                }`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[2]">
                  <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
                  <path d="M17 11a5 5 0 0 1-10 0" />
                  <path d="M12 17v4" />
                </svg>
              </button>

              <input
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    sendText();
                  }
                }}
                placeholder="Escribí un mensaje..."
                disabled={isRecording || isTranscribing}
                className="min-w-0 flex-1 rounded-2xl border border-sky-950/70 bg-[#101a2e] px-3 py-2.5 text-base text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400 lg:text-sm"
              />

              <button
                type="button"
                onClick={sendText}
                disabled={isProcessing || isRecording || isTranscribing}
                aria-label="Enviar mensaje"
                className="mb-0.5 flex h-11 w-11 items-center justify-center rounded-full text-emerald-400 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[2]">
                  <path d="M4 20 20 4l-5 16-3-7-8-3Z" />
                </svg>
              </button>
            </div>
          </div>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Abrir simulador WhatsApp"
          className="group flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-500 text-white shadow-glow transition hover:scale-105 hover:bg-emerald-400"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 fill-current text-white transition group-hover:text-white">
            <path d="M12 2a9.98 9.98 0 0 0-8.6 15.02L2 22l5.15-1.34A10 10 0 1 0 12 2zm0 18a7.96 7.96 0 0 1-4.07-1.12l-.29-.17-3.06.8.82-2.98-.19-.31A8 8 0 1 1 12 20zm4.64-5.8c-.25-.12-1.47-.72-1.7-.8-.23-.08-.4-.12-.57.12-.17.25-.66.8-.8.97-.14.17-.3.19-.55.06-.25-.12-1.05-.39-2-1.25-.74-.66-1.24-1.48-1.39-1.73-.15-.25-.02-.38.11-.5.11-.11.25-.3.37-.45.12-.15.16-.25.24-.42.08-.17.04-.32-.02-.45-.06-.12-.57-1.36-.78-1.86-.2-.48-.41-.41-.57-.42-.15-.01-.32-.01-.49-.01-.17 0-.45.06-.68.32-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.02 2.61.12.17 1.77 2.7 4.29 3.79.6.26 1.07.41 1.44.53.6.19 1.15.16 1.58.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.16-.48-.29z" />
          </svg>
        </button>
      )}
    </div>
  );
}
