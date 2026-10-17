# VoiceERP

La transición a arquitectura C se sigue en [STOCKY_REENGINEERING_PLAN.md](STOCKY_REENGINEERING_PLAN.md).
Ingresos, ventas y reservas usan `stock.receive`, `stock.sell` y `stock.reserve` del
mismo núcleo, con recibos idempotentes y movimientos transaccionales. Stock insuficiente
rechaza todo el lote. Ventas y reservas requieren SKU explícito; el precio de venta
opcional queda separado del catálogo y los totales separan monedas y precios desconocidos.
`POST /api/inventory/operations` acepta el contrato v1 con autenticación; el negocio
se verifica contra la sesión. `POST /api/state/apply` requiere `operationId` estable
para estas tres operaciones. Los lotes mixtos con mutaciones aún no migradas se rechazan.
Actualizaciones y ajustes individuales usan `sku.update` y `stock.adjust` en el mismo
núcleo. `PUT /api/products/:id` exige `operationId`, `expectedRevision` y motivo;
un snapshot obsoleto se rechaza con 409 y se conserva el borrador para revisarlo.
`npm run test:inventory` prueba dominio/contratos/seguridad y
`npm run test:voice-stock-postgres` agrega integración y HTTP en PostgreSQL temporal.
`npm run test:sales-ui` comprueba identidad, retry y totales en el navegador con API simulada.
`npm run test:inventory-adjustments-ui` verifica revisiones, conflictos y retry de ediciones.

Antes de desplegar: configurar `META_APP_SECRET` (firma POST Meta) y, en producción,
`AUTH_JWT_SECRET` privado de al menos 32 bytes. `/api/health` publica readiness y el SHA
si existe `RENDER_GIT_COMMIT` o `GIT_COMMIT_SHA`. Verificar backup/restauración antes de
la migración que amplía cantidades/precios a BIGINT. No hay despliegue automático desde esta documentación.

ERP voice-first para stock y cuentas corrientes. Convierte audio o texto en acciones de negocio, las confirma en una UI tipo chat y persiste el estado en PostgreSQL/Supabase.

## Qué incluye

- Simulador de WhatsApp flotante y desplegable.
- Parsing de voz con Whisper para transcripción y Gemini (con fallback Groq) para estructurar acciones.
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

### Probar el inventario sin PostgreSQL

Ejecutá `npm run dev:inventory-demo` y abrí `http://localhost:5174`. El demo corre separado de la app habitual de `localhost:5173`, trae modelos de ejemplo y permite entrar con el acceso de desarrollo. En **Inventario** podés crear un modelo con varios talles, seleccionar modelos completos o talles individuales para eliminarlos en lote, y editar cantidades y precios; desde **Inicio → Registrar ingreso** podés sumar stock. Los cambios son descartables y se pierden al detener el demo.

`npm run test:inventory-ui` compila la app y comprueba en Edge (Windows) o Chromium (otros sistemas) la creación de varios talles, la validación de duplicados, la edición, el ingreso de stock y la eliminación múltiple. La prueba simula la API y no toca datos reales.

## Scripts

- `npm run dev` - Vite solo frontend.
- `npm run dev:api` - backend Express solo.
- `npm run dev:frontback` - frontend + backend juntos.
- `npm run dev:ngrok` - túnel ngrok aparte.
- `npm run dev:all` - frontend + backend y ngrok si está disponible.
- `npm run db:migrate` - actualiza la BDD existente con `owner_phone` y tablas de auth.
- `npm run build` - build de producción.

## Variables de entorno

Usa `.env.local` para configurar:

- `LLM_PROVIDER` (`gemini` por default, o `groq`)
- `GEMINI_API_KEY`
- `GEMINI_MODEL_NAME` (opcional; default `gemini-3.5-flash-lite`)
- `VITE_VOICE_MODEL_ENDPOINT` / `VITE_VOICE_MODEL_API_KEY` / `VITE_VOICE_MODEL_NAME` (fallback Groq)
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

Si tu base ya existía antes del tenant por teléfono, corré:

```bash
npm run db:migrate
```

Eso crea/actualiza las tablas y agrega `owner_phone` donde falta.

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
