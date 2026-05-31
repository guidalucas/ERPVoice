# VoiceERP

ERP voice-first para stock y cuentas corrientes. Convierte audio o texto en acciones de negocio, las confirma en una UI tipo chat y persiste el estado en PostgreSQL/Supabase.

## Qué incluye

- Simulador de WhatsApp flotante y desplegable.
- Parsing de voz con Whisper para transcripción y Llama para estructurar acciones.
- Dashboard con resumen, stock real, ABM de productos y eventos de WhatsApp.
- Backend Express para estado, persistencia y webhook de Meta WhatsApp Cloud API.
- Persistencia en PostgreSQL conectada a Supabase o a un `DATABASE_URL` compatible.
- Creación automática de productos cuando no hay match suficiente.

## Arranque rápido

Instala dependencias y levanta frontend + backend en una terminal:

```bash
npm install
npm run dev:frontback
```

En otra terminal, levanta ngrok:

```bash
npm run dev:ngrok
```

La interfaz queda en `http://localhost:5173` y el backend en `http://localhost:3001`.

## Scripts

- `npm run dev` - Vite solo frontend.
- `npm run dev:api` - backend Express solo.
- `npm run dev:frontback` - frontend + backend juntos.
- `npm run dev:ngrok` - túnel ngrok aparte.
- `npm run dev:all` - frontend + backend y ngrok si está disponible.
- `npm run build` - build de producción.

## Variables de entorno

Usa `.env.local` para configurar:

- `VITE_VOICE_MODEL_ENDPOINT`
- `VITE_VOICE_MODEL_API_KEY`
- `VITE_VOICE_MODEL_NAME`
- `VITE_VOICE_TRANSCRIPTION_ENDPOINT`
- `VITE_VOICE_TRANSCRIPTION_MODEL`
- `META_WEBHOOK_PORT`
- `META_VERIFY_TOKEN`
- `META_ACCESS_TOKEN`
- `META_PHONE_NUMBER_ID`
- `META_GRAPH_API_VERSION`
- `SUPABASE_DATABASE_URL`
- `VITE_META_API_BASE`
- `NGROK_AUTHTOKEN`

Importante: cualquier variable `VITE_` queda expuesta en el bundle del navegador.

## Webhook de Meta

El webhook principal es `GET/POST /api/meta-webhook` y el backend también expone:

- `GET /api/health`
- `GET /api/state`
- `POST /api/state/apply`
- `GET /api/meta-events`

La URL pública que imprime ngrok es la que debes cargar en Meta.

## Base de datos

La persistencia vive en PostgreSQL y se configura con `SUPABASE_DATABASE_URL` o `DATABASE_URL`.

Entidades principales:

- Productos: `name`, `productType`, `productModel`, `size`, `stockAvailable`, `stockReserved`, `price`
- Clientes: `name`, `debt`
- Transacciones: `sourceText`, `actions`, `summary`
- Eventos Meta: `fromNumber`, `body`, `transcript`, `replyText`, `processed`

## Estructura principal

- `src/components/split/WhatsAppSimulator.tsx` - simulador flotante desplegable.
- `src/components/dashboard/` - dashboard, stock real, ABM y panel de eventos.
- `src/services/` - transcripción, parsing, CRUD de productos.
- `src/hooks/` - hooks de chat e inventario.
- `src/store/` - estado global.
- `server/` - backend Express, persistencia y webhook de Meta.

## Notas

- El flujo de voz usa Whisper para transcribir y Llama para producir JSON de acciones.
- El parser local actúa como fallback si falta la API o la respuesta del modelo no es válida.
- La UI y el backend comparten el modelo de datos, pero el backend es la fuente de verdad para el estado persistido.
