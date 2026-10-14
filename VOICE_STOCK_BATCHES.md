# Ingresos por WhatsApp: operación y validación

## Alcance de la entrega

El motor de ingresos `add_stock` admite cualquier rubro. `voiceStockEngine.js` extrae sin inventario, audita cobertura sin inventario y luego resuelve identidad usando candidatos del mismo negocio. `voiceStockWorkflow.js` conserva el lote, interpreta aclaraciones y gobierna las transiciones. El webhook solo adapta mensajes, transcripciones y respuestas.

Ventas, reservas y pedidos mantienen su interpretación actual. El panel mantiene propuestas que la persona confirma manualmente antes de llamar a `/api/state/apply`; todavía no usa el diálogo persistente de WhatsApp. Esta es la separación de alcance prevista en el plan original.

## Persistencia y recuperación

- Las referencias al producto anterior y las autocorrecciones actualizan ese ítem; no agregan unidades sin un ingreso adicional explícito. Los atributos globales conservan su alcance y sus citas. Los atributos no mencionados quedan ausentes; la auditoría de cobertura no exige completarlos para todo el lote.
- Un rechazo de formato intenta una reparación de extracción. Los fallos de cobertura reparables intentan una reparación adicional seguida de otra auditoría. Ninguna reparación permite saltar la validación ni aplicar un lote sin cobertura verificada.
- Los diagnósticos internos de auditoría quedan separados de las preguntas al usuario. Una duda de intención produce una pregunta concreta respaldada por una cita del original. La respuesta breve se procesa junto con el listado guardado, sin pedir repetirlo; un listado completo de reemplazo se procesa por separado. “Reintentar” reutiliza la transcripción guardada.
- `voice_stock_batches` conserva fuente original inmutable, extracción inicial, ítems con IDs estables, citas y posiciones, evidencia de cantidades/precios, resolución, candidatos ofrecidos, aclaraciones y versión. Los ítems están en JSONB dentro de la fila bloqueada del lote para que una transición sea indivisible.
- Un lote sin auditoría satisfactoria o con alguna resolución pendiente no puede modificar stock. Al elegir un producto existente se usa exclusivamente su ID y se valida su identidad actual. “Nuevo” fuerza creación; si la identidad coincide con un producto existente se pide qué lo diferencia.
- Cambiar o borrar un candidato no cambia la numeración que la persona recibió. Las opciones conservan sus IDs y su identidad original.
- Las transiciones usan versión esperada. Aplicación, registros por ítem y respuesta final se confirman en la misma transacción. Los estados terminales no pueden reabrirse.
- `meta_message_claims` conserva el mensaje entrante y la transcripción. El proceso revisa cada 30 segundos trabajos fallidos y leases abandonados de más de cinco minutos. Después de una caída se reutiliza la transcripción persistida. Si el lote ya se aplicó, se devuelve el resultado guardado.
- El webhook responde HTTP 200 después de persistir el mensaje. Si no puede reclamarlo porque la base está caída, responde 503 para permitir que Meta lo reintente.
- `meta_reply_outbox` reintenta solo el envío. Un fallo de WhatsApp no repite inventario. Como la API externa no comparte nuestra transacción, una caída justo después del envío puede repetir una notificación; nunca repite stock.
- Los otros intents también reciben una clave idempotente por mensaje y su outbox transaccional para que la recuperación del webhook no vuelva a ejecutar ventas o reservas.
- Los borradores sin actividad vencen a los siete días. Errores de conexión o serialización mantienen la operación recuperable; una identidad que cambió requiere corrección.

## Activación y observación

`VOICE_STOCK_BATCHES_MODE` define el valor predeterminado: `active`, `shadow` o `disabled`. El valor predeterminado del código es `active`.

El titular puede consultar `GET /api/settings/voice-stock-batches` y guardar `PUT /api/settings/voice-stock-batches` con `{"mode":"active"}` (o los otros modos), usando su token de sesión. El negocio se toma de la sesión: el cliente no elige un tenant. Los miembros pueden consultar, pero solo el titular puede cambiar el modo.

En sombra se conserva el resultado nuevo y la interpretación anterior en `voice_stock_shadow_runs`. El motor nuevo no escribe stock en ese modo; el flujo anterior sigue funcionando. Cada etapa registra proveedor, modelo, duración y uso de tokens cuando el proveedor lo informa. Los lotes pendientes siguen atendiendo aclaraciones aunque se deshabiliten nuevas entradas.

## Verificación local

1. `npm run test:voice-stock-batches`: corpus etiquetado y respuestas de modelo simuladas. Comprueba citas, precios globales y excepciones, omisiones, productos inventados, variantes, distintos rubros y recuperación de candidatos en catálogos grandes.
2. `npm run test:voice-stock-postgres`: levanta PostgreSQL 18 en un puerto local libre y una carpeta temporal, ejecuta la migración dos veces y usa las funciones reales de persistencia. Prueba concurrencia, rollback, aislamiento, replay, aclaraciones, correcciones, expiración, outbox y recuperación del audio. Se cierra y elimina la base al terminar. No usa las URLs de producción de `.env`.
3. `node scripts/test-long-audio-regression.js` verifica la compatibilidad del parser anterior.
4. `npm run build` compila el panel.

## Prueba con el proveedor real y producción

`npm run eval:voice-stock:live` evalúa el corpus con las credenciales reales del entorno y guarda `scripts/test-results-stock-live.json`. Solo llama al modelo; no abre la base del negocio ni envía WhatsApp. Conserva las decisiones y métricas para inspección. Sin clave configurada termina explicándolo y no simula un resultado real.

El dictado original incluye una frase adicional poco precisa sobre Independiente antes del producto explícito de 2026. El corpus conserva ese audio transcrito tal como se recibió y admite una aclaración; la variante sintética aclarada contiene once productos identificables. Se verifica Argentina tercera 2025, ausencia de Chelsea y precio global de 65.000 con excepción de 70.000 para manga larga. El conteo no está codificado en el motor de producción.

Para probar después de desplegar: ejecutar `npm run db:migrate` con la URL del entorno, correr la evaluación real y enviar por WhatsApp el dictado, responder una aclaración y verificar que el resumen coincida con los productos guardados. La migración CLI y el servidor usan exactamente la misma definición de esquema. Cambiar el modo a `disabled` permite volver al flujo anterior para mensajes nuevos y conserva los borradores existentes.
