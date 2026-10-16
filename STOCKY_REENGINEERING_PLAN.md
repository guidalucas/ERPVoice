# Stocky: transición a arquitectura C

## Estado recuperable

- Base: `d53758832d37d522595b4830b428a20af5fdcba3` (2026-10-16).
- Decisión: monolito modular; IA propone, backend autoriza/resuelve/ejecuta.
- Auditoría previa reutilizada. No repetir investigación general.
- Trabajo previo preservado: modificaciones en postgresDatabase, metaWebhookProcessor,
  voiceCatalogContext y sus dos scripts de regresión de borrado/PG.
- Producción NO verificada; no hay claves LLM locales. Nunca presentar mocks como IA real.

## Hitos y dependencias

| Hito | Alcance y componentes | Aceptación | Estado |
| --- | --- | --- | --- |
| H0 / P0 | Identidad conservadora reutilizable; autenticidad POST Meta; versión de despliegue. Engine, security, index. | Dirección/orden no colisionan; firma válida/tampered/missing; GET intacto; regresiones relevantes. | Implementado y verificado localmente |
| H1 / P1 | Contrato OperationPlan v1, dominio SKU/atributos tipados/unidades/precios, motor determinista y adapter PostgreSQL. | Contrato cerrado; tenant desde contexto autorizado; efectos exactos; rollback, concurrencia, idempotencia, resultados persistidos. | Implementado para stock.receive; verificado localmente |
| H2 / P2 | Ingresos resueltos de WhatsApp y panel al mismo ejecutor. | Única escritura add_stock por núcleo, sin segunda inferencia de nombre; outbox y lote atómicos; regresiones. | Implementado; verificado localmente |
| H3 / P3 | Borradores/preguntas con IDs y parches; intérprete IA desacoplado. | Correcciones parciales sin reextraer; errores técnicos tipados; replay y respuestas tardías seguras. | H3.1 verificado para elección SKU; resto pendiente |
| H4 / P4 | Ventas, reservas, atributos, selectores/conjuntos y confirmaciones; retirar escritores anteriores. | Estado/respuesta exactos, stock insuficiente explícito; selección congelada y confirmación versionada. | Pendiente |
| H5 | Comparación pipelines, evaluación real, piloto y limpieza final. | Corpus reservado, métricas completas, SHA desplegado, aislamiento, sin escritores duplicados. | Pendiente / acceso externo |

## Contratos y decisiones

- Operación e identidad son independientes de proveedor/canal. No agregar categorías o
  frases de los incidentes al código del dominio.
- `products` es la tabla de SKU existente durante la migración. No renombrar ni destruir
  registros existentes. Evolución aditiva para atributos tipados, unidades y revisión.
- Igualdad de identidad conserva orden, valores y roles. Búsqueda aproximada solo propone;
  nunca autoriza una equivalencia ambigua. Preferir aclaración a una falsa coincidencia.
- Cantidades actuales: enteros seguros en unidad base explícita. Rechazar precisión no
  soportada; futuras unidades fraccionarias requieren contrato explícito, no truncamiento.
- Precios: dinero entero; política explícita. Conflictos no se resuelven silenciosamente.
- Contexto autorizado se recibe del backend; el LLM/cliente no elige otro negocio.
- Operaciones atómicas por defecto; replay requiere mismo ID y mismo contenido.
- Mantener el bloqueo compatible con el escritor legacy mientras siga reemplazando tablas.
  No reducir locks sin migrar todos los escritores que compiten.
- Conservar fuente, evidencias, claims, control de versión y outbox. Migrar etapas sin
  reinterpretar mensajes ya aplicados ni descartar borradores activos.

## Pruebas y migración

- Referencia conocida: motor 48; PostgreSQL aislado 42; audio largo y borrados aprobados.
  River tiene dos expectativas de representación fallidas; exige revisar resultado real.
- Cada hito: pruebas puras/contratos, PG temporal cuando aplica, regresiones de consumidores,
  estado final y respuesta. Build/typecheck no sustituyen integración.
- Migración PostgreSQL aditiva/repetible, probada en base temporal antes de producción.
- Commit por hito integrado; cambios previos checkpoint separado para no perder trabajo.
- Rollback de código conserva tablas/historial. No usar el parser antiguo como supuesto
  rollback seguro si puede aplicar por nombre; suspender capacidad afectada ante fallo.
- Sin acceso externo: avanzar localmente; documentar evaluación LLM, backup recuperable,
  configuración META_APP_SECRET, despliegue y smoke productivo como pendientes concretos.

## Próximo paso exacto

H3.2: extender preguntas/patches persistentes a atributos faltantes del lote activo,
sin reconstruir los ítems ya extraídos. Vincular respuestas citadas al ID de pregunta;
preservar IDs ante reordenamientos y recargas del panel. No abrir ventas/conjuntos
antes de verificar estos contratos.

## Registro de hitos

- Inicio: plan creado antes de modificar componentes principales; dos tareas independientes
  delegadas (seguridad y mapa de integración). No modificar los mismos archivos en paralelo.
- H0: dominio puro conserva orden/dirección, puntuación, acentos, repetición, atributos
  tipados y estados desconocido/no-aplicable/ausente. Identidad del motor ya lo consume;
  un puntaje 94 por variante omitida ya no autoriza aplicación automática.
- H0: POST Meta verifica HMAC SHA256 sobre bytes originales antes de procesar; sin secreto
  rechaza con 503, firma inválida 401. GET intacto. Health informa SHA disponible y readiness.
  Requiere configurar META_APP_SECRET antes de desplegar; no se desplegó esta sesión.
- H0 verificado: 16 tests de dominio/seguridad y 42 checks PostgreSQL. El escenario que
  asumía una variante omitida fue reemplazado por una variante explícita; la abstención
  con variante omitida se verifica en el motor. Preexistentes guardados en ea0f5bf.
- H1: contrato v1 cerrado e independiente del canal, autorización de contexto, tipos de
  atributos y unidades explícitas. Capacidad ejecutable actual: stock.receive; otras
  operaciones fallan explícitamente (no simulan soporte universal terminado).
- H1: inventory_operations conserva plan/hash/actor/resultado; inventory_movements conserva
  deltas por ítem. Replay concurrente aplica una vez; reutilizar ID con contenido distinto
  es conflicto. Fuente original queda en el primer recibo; no cambia el hash semántico.
- H1: migración repetible agrega metadatos a SKU y amplía stock/precio a BIGINT sin cambiar
  valores; no hay borrados de datos. API autenticada /api/inventory/operations deriva
  negocio/permisos del backend. initialize de precio conflictivo requiere corrección.
- H1 verificado: contrato puro aprobado y 53 checks PG (11 nuevos, 42 previos), incluyendo
  fallo SQL de movimiento con rollback de recibo y stock, aislamiento y cantidad >32 bits.
- Alcance pendiente del dominio: familia de producto/esquemas configurables persistentes,
  cantidades fraccionarias/conversiones y otras operaciones. No confundir atributos tipados
  implementados con el modelo completo terminado. No se aplicó migración a producción.
- H2: applyResolvedVoiceStockBatch delega la escritura al núcleo; movimientos, recibo,
  transacciones compatibles, estado aplicado y outbox comparten el commit. Eliminado
  el bucle de escritura de ingresos anterior. Fingerprints incluyen atributos/unidad/estado.
- H2: todo add_stock en applyActionsToDatabase se adapta al mismo núcleo. Requiere ID
  estable; un lote mixto todavía no soportado se rechaza entero. Ventas/reservas/pedidos,
  ABM con stock inicial y ajustes directos permanecen en H4: NO hay ejecutor único total aún.
- H2: panel espera persistencia, muestra fallo y conserva borrador/ID para retry; modal
  manual envía SKU explícito y conserva su ID tras fallo. Quitada confirmación optimista.
- H2 verificado: 60 checks PostgreSQL incluyendo 7 contra servidor HTTP real con JWT y
  firmas HMAC, recibos/aislamiento/replay; motor 49; pruebas puras/seguridad/auth 24;
  build aprobado; UI Edge simulada falla primer ingreso/reintenta mismo ID y aplica una vez.
- P0 adicional: JWT producción exige AUTH_JWT_SECRET privado >=32 bytes; se rechazan
  claims/headers/expiración inválidos. Bypass de desarrollo deshabilitado en producción.
- Pendientes externos: configurar secretos, backup/restauración y revisar migración BIGINT
  antes de desplegar; evaluar proveedores reales y verificar SHA efectivo. No se desplegó.
- Riesgos restantes: escritor legacy aún requiere bloqueo de tabla; matcher histórico fuera
  de ingresos; identidad/familias y esquemas configurables completos pendientes; persistencia
  del borrador del panel entre recargas aún pendiente de H3.
- H3.1: intérprete de aclaración SKU separado del motor; resultados existing/new/correction/
  unrelated, unavailable e invalid distinguen intención, contrato y fallos del proveedor.
  IDs fuera de candidatos, mutaciones ocultas y cantidades inválidas se rechazan.
- H3.1: pregunta SKU persistida con ID y candidatos/fingerprints. Fallo de interpretación,
  auditoría o resolución conserva respuesta ligada a pregunta e ítem; reintentar reproduce
  esa respuesta sin reextraer. Corrección/elección conserva itemId y limpia retry anterior.
  Una pregunta reemplazada invalida ese retry; CAS, recibos y outbox siguen vigentes.
- H3.1: retirados previews/cuerpos de error de los logs compartidos LLM, manteniendo
  proveedor/modelo/estado/motivo. No se alteraron retries ni la selección de proveedor.
- H3.1 verificado: 63 checks PG/HTTP; motor 49; suite pura/seguridad/auth/intérprete/logs 26
  (incluye 18 checks internos de aclaración y 4 escenarios de logs); audio largo y borrados
  aprobados. Build/UI del H2 siguen siendo la última validación frontend, sin cambios aquí.
- H3 sigue parcial: respuestas tardías citadas de Meta, preguntas genéricas, IDs tras
  reextracción completa, borradores panel tras recarga e intérprete universal pendientes.
