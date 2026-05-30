# VoiceERP

Asistente por voz MVP para gestión ERP: interfaz web tipo chat, reconocimiento y parseo de voz, webhook de Meta WhatsApp Cloud API, y persistencia local con SQLite.

## Características

- Interfaz de chat web con simulador tipo WhatsApp.
- Captura y parseo de voz para convertir comandos a transacciones.
- Backend Express para Meta, estado y persistencia.
- Stock, clientes y transacciones guardados en SQLite.
- Si un producto no matchea, se crea uno nuevo automáticamente.
- Arquitectura ligera ideal para prototipos y demos.

## Rápido inicio

Instala dependencias y levanta el servidor de desarrollo:

```bash
npm install
npm run dev
```

Abre `http://localhost:5173` (o la URL que muestre Vite) y prueba la interfaz de chat.

Si el puerto ya está ocupado, Vite puede arrancar en otro puerto como `5174`.

## Webhook de Meta WhatsApp

Para recibir audios y mensajes de WhatsApp desde Meta, levanta el webhook local en otro puerto:

```bash
npm run dev:api
```

El servidor escucha en `http://localhost:3001` por defecto y expone:

- `GET /api/meta-webhook`
- `POST /api/meta-webhook`
- `GET /api/health`
- `GET /api/meta-events`
- `GET /api/state`
- `POST /api/state/apply`

Si quieres levantar web y API al mismo tiempo:

```bash
npm run dev:all
```

Para exponer Meta en local con ngrok, apunta el túnel al puerto del webhook, no al de Vite:

```bash
ngrok http 3001
```

Luego configura en Meta la URL pública resultante, por ejemplo `https://xxxx.ngrok-free.app/api/meta-webhook`.

## Persistencia

- La base local se guarda en `server/data/erpvoice.sqlite`.
- Puedes abrirla con DB Browser for SQLite o cualquier cliente compatible.
- El backend sincroniza productos, clientes, transacciones y eventos Meta.

## Estructura principal

- `src/` – código fuente React + servicios
  - `src/components/` – componentes UI (chat, dashboard, simulador)
  - `src/services/` – servicios como `voiceModelService.ts`, `voiceParserService.ts`, `transactionService.ts`
  - `src/hooks/` – hooks personalizados (`useChatBot`, `useInventory`)
  - `src/domain/` – tipos y datos de prueba
  - `src/store/` – estado global
- `server/` – backend Express, persistencia SQLite y webhook de Meta

## Contribuir

1. Crea una rama nueva: `git checkout -b feat/mi-cambio`
2. Implementa y prueba tus cambios.
3. Abre un pull request con descripción clara.

## Licencia

MIT — usa y modifica libremente para prototipos y demos.
