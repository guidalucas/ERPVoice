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
| H2 / P2 | Ingresos resueltos de WhatsApp y panel al mismo ejecutor. | Única escritura de ingresos por núcleo, sin segunda inferencia de nombre; outbox y lote atómicos; regresiones. | Pendiente |
| H3 / P3 | Borradores/preguntas con IDs y parches; intérprete IA desacoplado. | Correcciones parciales sin reextraer; errores técnicos tipados; replay y respuestas tardías seguras. | Pendiente |
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

H2: conectar ingresos existentes conservando batch/outbox en la misma transacción.
Adaptar confirmación del panel para esperar persistencia y conservar ID al reintentar.

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
