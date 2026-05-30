/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_VOICE_MODEL_ENDPOINT?: string;
	readonly VITE_VOICE_MODEL_API_KEY?: string;
	readonly VITE_VOICE_MODEL_NAME?: string;
	readonly VITE_VOICE_TRANSCRIPTION_ENDPOINT?: string;
	readonly VITE_VOICE_TRANSCRIPTION_MODEL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}