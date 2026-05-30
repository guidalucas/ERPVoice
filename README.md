# VoiceERP

Asistente por voz MVP para gestión ERP: interfaz web tipo chat, reconocimiento y parseo de voz, y servicios para manejar inventarios y transacciones.

## Características

- Interfaz de chat web con simulador tipo WhatsApp.
- Captura y parseo de voz para convertir comandos a transacciones.
- Servicios para inventario y transacciones.
- Arquitectura ligera ideal para prototipos y demos.

## Rápido inicio

Instala dependencias y levanta el servidor de desarrollo:

```bash
npm install
npm run dev
```

Abre `http://localhost:5173` (o la URL que muestre Vite) y prueba la interfaz de chat.

## Estructura principal

- `src/` – código fuente React + servicios
  - `src/components/` – componentes UI (chat, dashboard, simulador)
  - `src/services/` – servicios como `voiceModelService.ts`, `voiceParserService.ts`, `transactionService.ts`
  - `src/hooks/` – hooks personalizados (`useChatBot`, `useInventory`)
  - `src/domain/` – tipos y datos de prueba
  - `src/store/` – estado global

## Contribuir

1. Crea una rama nueva: `git checkout -b feat/mi-cambio`
2. Implementa y prueba tus cambios.
3. Abre un pull request con descripción clara.

## Licencia

MIT — usa y modifica libremente para prototipos y demos.
