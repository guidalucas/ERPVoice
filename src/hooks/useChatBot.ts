import { useMemo, useRef, useState } from 'react';
import type { ParsedVoicePayload, ParsedActionUnion } from '../domain/types';
import { voiceModelService } from '../services/voiceModelService';
import { createChatMessage, useAppStore } from '../store/AppStore';

const buildBotMessage = (payloadCount: number) => {
  if (!payloadCount) {
    return 'No encontré acciones claras. Probá otra frase.';
  }

  if (payloadCount === 1) {
    return 'Detecté una acción. Revisala y confirmá si está correcta.';
  }

  return 'Detecté varias acciones. Revisalas y confirmá si están correctas.';
};

const buildMissingFieldsMessage = (fields: string[]) => `Me faltan estos datos: ${fields.join(', ')}. Probá de nuevo con más detalle.`;

const resolveMissingFields = (payload: ParsedVoicePayload) => {
  const missingFields = payload.missingFields ?? [];

  if (!missingFields.length) {
    return [];
  }

  const hasSellAction = payload.actions.some((action) => action.type === 'sell');
  const hasResolvableDebt = payload.actions.some(
    (action) => action.type === 'add_debt' && typeof action.productName === 'string' && typeof action.qty === 'number',
  );

  return missingFields.filter((field) => {
    const normalized = normalizeText(field);

    if (/(precio\s+unitario|unitario|precio\s+de\s+venta|valor\s+unitario)/u.test(normalized)) {
      return !(hasSellAction || hasResolvableDebt);
    }

    return true;
  });
};

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

const formatProductMeta = (action: { productType?: string; productModel?: string; size?: string; productName: string }) => {
  const parts = [action.productType, action.productModel, action.size].filter((value): value is string => Boolean(value));

  return parts.length ? `${parts.join(' / ')} -> ${action.productName}` : action.productName;
};

const resolveProduct = (products: { name: string; price: number }[], actionName: string) => {
  const actionTokens = tokenize(actionName);

  if (!actionTokens.length) {
    return null;
  }

  let bestProduct: { name: string; price: number } | undefined;
  let bestScore = 0;

  for (const product of products) {
    const productTokens = tokenize(product.name);
    const score = actionTokens.filter((token) => productTokens.includes(token)).length;

    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  return bestProduct ?? null;
};

const resolveDebtAmount = (products: { name: string; price: number }[], action: ParsedActionUnion) => {
  if (action.type !== 'add_debt') {
    return null;
  }

  if (!action.productName || typeof action.qty !== 'number') {
    return null;
  }

  const product = resolveProduct(products, action.productName);

  if (!product) {
    return null;
  }

  return product.price * action.qty;
};

const enrichProposal = (payload: ParsedVoicePayload, products: { name: string; price: number }[]): ParsedVoicePayload => {
  const lastSellAction = [...payload.actions].reverse().find((action) => action.type === 'sell');

  return {
    ...payload,
    actions: payload.actions.map((action) => {
      if (action.type === 'add_debt') {
        const debtAmount = resolveDebtAmount(products, action);

        if (debtAmount !== null) {
          return {
            ...action,
            amount: debtAmount,
          } as ParsedActionUnion;
        }

        if (!lastSellAction) {
          return action;
        }

        const soldProduct = resolveProduct(products, lastSellAction.productName);

        if (!soldProduct) {
          return action;
        }

        return {
          ...action,
          amount: soldProduct.price * lastSellAction.qty,
        } as ParsedActionUnion;
      }
      return action;
    }),
  };
};

export const useChatBot = () => {
  const { state, addChatMessage, setPendingProposal, confirmPendingProposal, clearPendingProposal } = useAppStore();
  const [draftText, setDraftText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);

  const pendingActionsText = useMemo(() => {
    if (!state.pendingProposal) {
      return [];
    }

    return state.pendingProposal.actions.map((action, index) => {
      if (action.type === 'add_stock') {
        return `${index + 1}. add_stock -> ${formatProductMeta(action)} (+${action.qty})`;
      }

      if (action.type === 'reserve_stock') {
        return `${index + 1}. reserve_stock -> ${formatProductMeta(action)} (-${action.qty})`;
      }

      if (action.type === 'sell') {
        return `${index + 1}. sell -> ${formatProductMeta(action)} (-${action.qty})`;
      }

      if (action.type === 'payment_received') {
        return `${index + 1}. payment_received -> ${action.clientName} (-$${action.amount.toLocaleString('es-AR')})`;
      }

      if (action.type === 'client_order') {
        const qty = action.qty && action.qty > 0 ? action.qty : 1;
        const sizeLabel = action.size ? ` talle ${action.size}` : '';
        return `${index + 1}. client_order -> ${action.clientName} pidió ${qty} ${action.productName}${sizeLabel}`;
      }

      // add_debt
      return `${index + 1}. add_debt -> ${action.clientName} (+$${action.amount.toLocaleString('es-AR')})`;
    });
  }, [state.pendingProposal]);

  const processText = async (inputText: string) => {
    const trimmed = inputText.trim();

    if (!trimmed || isProcessing || isRecording || isTranscribing) {
      return;
    }

    setIsProcessing(true);

    const userMessage = createChatMessage('user', trimmed);

    addChatMessage(userMessage);

    let parsed;

    try {
      parsed = await voiceModelService.parseVoiceText(trimmed);
    } catch {
      parsed = null;
    }

    if (!parsed) {
      addChatMessage(createChatMessage('bot', 'No pude interpretar el audio o el texto. Probá de nuevo.'));
      clearPendingProposal();
      setDraftText('');
      setIsProcessing(false);
      return;
    }

    const enrichedParsed = enrichProposal(parsed, state.products);
    const resolvedMissingFields = resolveMissingFields(enrichedParsed);

    if (resolvedMissingFields.length) {
      addChatMessage(createChatMessage('bot', buildMissingFieldsMessage(resolvedMissingFields)));
      clearPendingProposal();
      setDraftText('');
      setIsProcessing(false);
      return;
    }

    if (!enrichedParsed.actions.length) {
      addChatMessage(createChatMessage('bot', buildBotMessage(0)));
      clearPendingProposal();
      setDraftText('');
      setIsProcessing(false);
      return;
    }

    const botMessage = createChatMessage('bot', buildBotMessage(enrichedParsed.actions.length), enrichedParsed);

    addChatMessage(botMessage);
    setPendingProposal(enrichedParsed);
    setIsProcessing(false);
  };

  const sendText = async () => {
    const trimmed = draftText.trim();

    if (!trimmed || isProcessing || isRecording || isTranscribing) {
      return;
    }

    await processText(trimmed);
    setDraftText('');
  };

  const startRecording = async () => {
    if (isProcessing || isRecording || isTranscribing) {
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      addChatMessage(createChatMessage('bot', 'Tu navegador no soporta grabación de audio.'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setIsRecording(false);
        setIsTranscribing(true);

        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          const transcript = await voiceModelService.transcribeAudio(audioBlob);

          if (!transcript) {
            addChatMessage(createChatMessage('bot', 'No pude transcribir el audio. Probá de nuevo.'));
            return;
          }

          await processText(transcript);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      addChatMessage(createChatMessage('bot', 'Grabando audio. Tocá detener para procesarlo.'));
    } catch {
      addChatMessage(createChatMessage('bot', 'No pude acceder al micrófono. Revisá permisos del navegador.'));
      setIsRecording(false);
      setIsTranscribing(false);
      mediaRecorderRef.current = null;
    }
  };

  const stopRecording = async () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      return;
    }

    mediaRecorderRef.current.stop();
  };

  const toggleRecording = async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }

    await startRecording();
  };

  const onConfirm = () => {
    if (!state.pendingProposal) {
      return;
    }

    confirmPendingProposal();
    addChatMessage(createChatMessage('bot', 'Transacción confirmada y aplicada al estado global.'));
  };

  const onCancel = () => {
    clearPendingProposal();
    addChatMessage(createChatMessage('bot', 'Propuesta descartada. Podés editar el texto y reenviarlo.'));
  };

  return {
    messages: state.chatMessages,
    draftText,
    setDraftText,
    pendingProposal: state.pendingProposal,
    pendingActionsText,
    isProcessing,
    isRecording,
    isTranscribing,
    sendText,
    toggleRecording,
    onConfirm,
    onCancel,
  };
};