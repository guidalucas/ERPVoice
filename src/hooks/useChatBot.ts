import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedActionUnion } from '../domain/types';
import { useBusinessCategoryPreset } from './useBusinessCategoryPreset';
import { voiceModelService } from '../services/voiceModelService';
import { createChatMessage, useAppStore } from '../store/AppStore';
import { useAuth } from '../store/AuthStore';
import { toUserFacingError } from '../services/apiClient';

const formatProductMeta = (
  action: { productType?: string; productModel?: string; size?: string; productName: string },
  includeSize: boolean,
) => {
  const parts = [action.productType, action.productModel, includeSize ? action.size : undefined].filter(
    (value): value is string => Boolean(value),
  );

  return parts.length ? `${parts.join(' / ')} -> ${action.productName}` : action.productName;
};

export const useChatBot = (onUniversalText: (text: string) => void) => {
  const { state, addChatMessage, confirmPendingProposal, clearPendingProposal } = useAppStore();
  const { session } = useAuth();
  const storageKey = session ? 'universal-chat-input:' + JSON.stringify([session.tenantPhone, session.phoneNumber]) : null;
  const preset = useBusinessCategoryPreset();
  const [draftText, setDraftTextState] = useState('');
  const [inputStorageError, setInputStorageError] = useState('');
  const isProcessing = false;
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const isConfirmingRef = useRef(false);
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const mounted = useRef(true);
  const busy = useRef(false);
  const callback = useRef(onUniversalText);
  callback.current = onUniversalText;
  const setDraftText = (text: string) => {
    setDraftTextState(text);
    if (!storageKey) return false;
    try {
      // Persist before handing the source to review; keep failures editable in memory.
      localStorage.setItem(storageKey, text);
      setInputStorageError('');
      return true;
    } catch {
      setInputStorageError('No pudimos guardar tu mensaje. Lo conservamos en pantalla; reintentá enviarlo cuando el almacenamiento esté disponible.');
      return false;
    }
  };
  useEffect(() => {
    try {
      setDraftTextState(storageKey ? localStorage.getItem(storageKey) ?? '' : '');
      setInputStorageError('');
    } catch {
      setDraftTextState('');
      setInputStorageError('No pudimos recuperar tu mensaje guardado. Revisá el almacenamiento del navegador y volvé a intentarlo.');
    }
    busy.current = false;
    setIsRecording(false);
    setIsTranscribing(false);
    return () => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder.stream.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
    };
  }, [storageKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        if (recorder.state !== 'inactive') recorder.stop();
        recorder.stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const pendingActionsText = useMemo(() => {
    if (!state.pendingProposal) {
      return [];
    }

    const uniqueNames = (items: Extract<ParsedActionUnion, { type: 'client_order' }>[], field: 'clientName' | 'proveedorName') => {
      const names: string[] = [];
      for (const item of items) {
        const name = item[field]?.trim() || '';
        if (name && !names.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
          names.push(name);
        }
      }
      return names;
    };

    const formatOrderHeader = (items: Extract<ParsedActionUnion, { type: 'client_order' }>[]) => {
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

    const formatOrderItem = (
      action: Extract<ParsedActionUnion, { type: 'client_order' }>,
      includeProveedor: boolean,
    ) => {
      const qty = action.qty && action.qty > 0 ? action.qty : 1;
      const sizeLabel =
        preset.useVariants && action.size && preset.variantLabel
          ? ` ${preset.variantLabel.toLowerCase()} ${action.size}`
          : '';
      const proveedorLabel =
        includeProveedor && action.proveedorName?.trim() ? ` · proveedor ${action.proveedorName.trim()}` : '';
      return `${qty} ${action.productName}${sizeLabel}${proveedorLabel}`;
    };

    const lines: string[] = [];
    let orderBuffer: Extract<ParsedActionUnion, { type: 'client_order' }>[] = [];
    let otherIndex = 0;

    const flushOrders = () => {
      if (!orderBuffer.length) {
        return;
      }

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
          lines.push(`• ${formatOrderItem(item, includeProveedor)}`);
        }
      }
      orderBuffer = [];
    };

    const nextOtherIndex = () => {
      otherIndex += 1;
      return otherIndex;
    };

    for (const action of state.pendingProposal.actions) {
      if (action.type === 'client_order') {
        orderBuffer.push(action);
        continue;
      }

      flushOrders();

      if (action.type === 'add_stock') {
        lines.push(`${nextOtherIndex()}. add_stock -> ${formatProductMeta(action, preset.useVariants)} (+${action.qty})`);
        continue;
      }

      if (action.type === 'reserve_stock') {
        lines.push(`${nextOtherIndex()}. reserve_stock -> ${formatProductMeta(action, preset.useVariants)} (-${action.qty})`);
        continue;
      }

      if (action.type === 'sell') {
        lines.push(`${nextOtherIndex()}. sell -> ${formatProductMeta(action, preset.useVariants)} (-${action.qty})`);
        continue;
      }

      if (action.type === 'payment_received') {
        lines.push(`${nextOtherIndex()}. payment_received -> ${action.clientName} (-$${action.amount.toLocaleString('es-AR')})`);
        continue;
      }

      if (action.type === 'query_stock') {
        lines.push(`${nextOtherIndex()}. query_stock -> ${formatProductMeta(action, preset.useVariants)}`);
        continue;
      }

      if (action.type === 'query_pedidos') {
        const estado = action.estado && action.estado !== 'todos' ? action.estado : 'pendientes';
        const scope = action.clientName
          ? ` de ${action.clientName}`
          : action.proveedorName
            ? ` del proveedor ${action.proveedorName}`
            : '';
        lines.push(`${nextOtherIndex()}. query_pedidos -> ${estado}${scope}`);
        continue;
      }

      if (action.type === 'update_product') {
        const parts = [];
        if (Number.isFinite(action.price) && (action.price ?? 0) > 0) {
          parts.push(`precio $${Number(action.price).toLocaleString('es-AR')}`);
        }
        if (Number.isFinite(action.stockAvailable ?? NaN)) {
          parts.push(`stock ${action.stockAvailable}`);
        }
        lines.push(`${nextOtherIndex()}. update_product -> ${action.productName}${parts.length ? ` (${parts.join(', ')})` : ''}`);
        continue;
      }

      if (action.type === 'update_pedido') {
        const parts = [];
        if (Number.isFinite(action.qty ?? NaN) && (action.qty ?? 0) > 0) {
          parts.push(`qty ${action.qty}`);
        }
        if (action.size) {
          parts.push(`${(preset.variantLabel ?? 'variante').toLowerCase()} ${action.size}`);
        }
        if (action.estado) {
          parts.push(action.estado);
        }
        lines.push(`${nextOtherIndex()}. update_pedido -> ${action.productName}${parts.length ? ` (${parts.join(', ')})` : ''}`);
        continue;
      }

      if (action.type === 'delete_pedido') {
        lines.push(`${nextOtherIndex()}. delete_pedido -> ${action.productName}`);
        continue;
      }

      if (action.type === 'delete_product') {
        lines.push(`${nextOtherIndex()}. delete_product -> ${action.productName === '*' ? 'todo el inventario' : action.productName}`);
        continue;
      }

      lines.push(`${nextOtherIndex()}. add_debt -> ${action.clientName} (+$${action.amount.toLocaleString('es-AR')})`);
    }

    flushOrders();
    return lines;
  }, [state.pendingProposal, preset.useVariants, preset.variantLabel]);

  const processText = (inputText: string) => {
    const trimmed = inputText.trim();
    if (!trimmed || !storageKey || !mounted.current || scope.current !== storageKey) return;
    // Transcribed audio and typed text enter the same server-backed review.
    if (!setDraftText(trimmed)) return;
    addChatMessage(createChatMessage('user', trimmed));
    callback.current(trimmed);
  };

  const sendText = async () => {
    if (busy.current || isProcessing || isRecording || isTranscribing) return;
    processText(draftText);
  };

  const startRecording = async () => {
    if (busy.current || isProcessing || isRecording || isTranscribing) {
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      addChatMessage(createChatMessage('bot', 'Tu navegador no soporta grabación de audio.'));
      return;
    }

    busy.current = true;
    const recordingScope = storageKey;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || scope.current !== recordingScope) { stream.getTracks().forEach(track => track.stop()); busy.current = false; return; }
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
        if (!mounted.current || scope.current !== recordingScope) { busy.current = false; return; }
        setIsRecording(false);
        setIsTranscribing(true);

        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          const transcript = await voiceModelService.transcribeAudio(audioBlob);

          if (!mounted.current || scope.current !== recordingScope) return;
          if (!transcript) {
            addChatMessage(createChatMessage('bot', 'No pude transcribir el audio. Probá de nuevo.'));
            return;
          }

          processText(transcript);
        } catch (error) {
          if (mounted.current && scope.current === recordingScope) addChatMessage(createChatMessage('bot', toUserFacingError(error, 'No pude transcribir el audio. Probá de nuevo.')));
        } finally {
          busy.current = false;
          if (mounted.current && scope.current === recordingScope) setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      addChatMessage(createChatMessage('bot', 'Grabando audio. Tocá detener para procesarlo.'));
    } catch {
      busy.current = false;
      if (!mounted.current || scope.current !== recordingScope) return;
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

  const onConfirm = async () => {
    if (!state.pendingProposal || isConfirmingRef.current) {
      return;
    }

    isConfirmingRef.current = true;
    try {
      await confirmPendingProposal();
      addChatMessage(createChatMessage('bot', 'Transacción confirmada y aplicada al estado global.'));
    } catch (error) {
      addChatMessage(createChatMessage('bot', `${toUserFacingError(error, 'No se pudo confirmar la transacción.')} Podés volver a confirmar la propuesta.`));
    } finally {
      isConfirmingRef.current = false;
    }
  };

  const onCancel = () => {
    clearPendingProposal();
    addChatMessage(createChatMessage('bot', 'Propuesta descartada. Podés editar el texto y reenviarlo.'));
  };

  return {
    messages: state.chatMessages,
    draftText,
    inputStorageError,
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
