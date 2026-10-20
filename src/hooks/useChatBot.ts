import { useEffect, useRef, useState } from 'react';
import { voiceModelService } from '../services/voiceModelService';
import { createChatMessage, useAppStore } from '../store/AppStore';
import { useAuth } from '../store/AuthStore';
import { toUserFacingError } from '../services/apiClient';

export const useChatBot = (onUniversalText: (text: string) => void) => {
  const { state, addChatMessage } = useAppStore();
  const { session } = useAuth();
  const storageKey = session ? 'universal-chat-input:' + JSON.stringify([session.tenantPhone, session.phoneNumber]) : null;
  const [draftText, setDraftTextState] = useState('');
  const [inputStorageError, setInputStorageError] = useState('');
  const isProcessing = false;
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
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

  return {
    messages: state.chatMessages,
    draftText,
    inputStorageError,
    setDraftText,
    isProcessing,
    isRecording,
    isTranscribing,
    sendText,
    toggleRecording,
  };
};
