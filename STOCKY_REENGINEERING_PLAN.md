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
| H3 / P3 | Borradores/preguntas con IDs y parches; intérprete IA desacoplado. | Correcciones parciales sin reextraer; errores técnicos tipados; replay y respuestas tardías seguras. | H3.1–H3.4 verificados para ingresos; intérprete universal pendiente |
| H4 / P4 | Ventas, reservas, atributos, selectores/conjuntos y confirmaciones; retirar escritores anteriores. | Estado/respuesta exactos, stock insuficiente explícito; selección congelada y confirmación versionada. | H4.0, H4.1 y H4.2a implementados/verificados; bajas siguientes |
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

H4.3: migrar bajas/desactivación mediante el mismo núcleo y extender las selecciones ya
implementadas a esa mutación. Definir conservación de historial y semántica de inactividad;
migrar DELETE individual/batch y delete_product de WhatsApp antes de retirar su escritor.
Reutilizar inventario de consumidores: deleteProductRecord/deleteProductRecords y rama
delete_product de applyActionsToDatabase; modal individual y selección de ProductsAbmPanel.
No recalcular por nombre al confirmar. Mantener bloqueo de tabla hasta retirar el reemplazo
legacy completo. Luego ABM con stock inicial, efectos de pedidos y resto de mutaciones.
H4.2b pendiente: ampliar la conversación de conjuntos/verificación a WhatsApp y a otros
verbos; no confundir la edición de modelos migrada con todas las mutaciones masivas.
El intérprete universal y los esquemas configurables siguen pendientes; no abrir conjuntos
ni optimización LLM antes de cerrar la integridad de estas mutaciones.

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
  de ingresos; identidad/familias y esquemas configurables completos pendientes.
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
- H3.2: outbox conserva snapshot lote/pregunta y todos los wamid aceptados por Meta.
  context.id se valida contra pregunta actual, ítem, negocio y remitente. Preguntas rotan
  en el mismo CAS que sus acciones; se recupera ready antes de interpretar comandos nuevos.
  Respuestas citadas atrasadas/desconocidas no resuelven otro ítem ni cancelan otro lote.
- H3.2: borrador del panel en sessionStorage versionado, separado por negocio/actor
  autenticados; sobrevive recarga de la pestaña con el mismo operationId. Confirmación
  espera snapshot válido; fallos, consultas y parsing incompleto conservan el borrador.
  Respuesta anterior no borra propuesta nueva; almacenamiento lleno impide enviar hasta
  poder guardar. Cancelación explícita borra. No sincroniza dispositivos ni pestañas cerradas.
- H3.2 verificado: 67 checks PG/HTTP; build y Edge con recarga/503/replay, cancelación,
  aislamiento, respuesta inválida, confirmación concurrente y recuperación de cuota.
  Revisión independiente detectó dos ventanas (ready/cancel y rotación Q1→Q2), corregidas
  y cubiertas por regresiones; segunda revisión sin hallazgos en ese alcance.
- Al cerrar H3.2 quedaban preguntas genéricas e IDs tras reextracción (abordados después).
  Siguen pendientes sincronización del borrador entre dispositivos e intérprete universal. Respuestas sin cita
  siguen ligadas al lote activo; citas anteriores sin recibo persistido se retienen.
  La recuperación exactamente una vez en panel está probada para ingresos; otras
  mutaciones todavía usan el escritor legacy y requieren migración/idempotencia en H4.
- H3.3: stockDraftPatches interpreta confirmación, cambios de campos y eliminación
  explícita sobre preguntas/ítems ofrecidos. Contrato cerrado con citas por campo, sin
  introducir SKU/IDs de catálogo ni acciones nuevas. Ítems intactos y sus IDs se conservan.
- H3.3: validación conserva IDs existentes (también al reordenar) y rechaza duplicados;
  se generan IDs sin colisionar. Preguntas genéricas se persisten como conjuntos ligados
  a su fuente. Respuestas citadas siguen el mismo aislamiento que las elecciones SKU.
- H3.3: parche se guarda antes de auditar/resolver, con historia y fuente original. Una
  interrupción retoma esa etapa; retry del catálogo reutiliza auditoría solo con hash
  canónico idéntico de acciones/fuente. Reemplazar lista invalida ese permiso anterior.
  Cambios semánticos invalidan decisiones derivadas de referencia/repetición.
- H3.3 verificado: 74 checks PG/HTTP, 50 del motor y 27 de suite pura/seguridad
  (incluye 51 casos de patch). Cantidad/medida parcial, quitar solo un ítem, recuperación
  tras guardar, fallo de proveedor/catálogo, auditoría obsoleta, referencias anteriores y
  opción inválida seguida de una válida tienen verificación de estado persistido.
- Alcance H3 restante: el intérprete de ingresos aún conserva extracción/enriquecimiento/
  auditoría históricos; no se midió calidad, costo ni latencia con proveedores reales.
  Añadir ítems por aclaración requiere hoy reemplazo explícito; no simula soporte genérico.
  La sincronización entre dispositivos y el modal manual tras recarga siguen pendientes.
- H3.4: reemplazo explícito reconcilia IDs por identidad completa conservadora y única
  en ambas listas; cantidades/precios pueden cambiar sin reasignar el ítem. Ítems nuevos,
  identidades duplicadas o no verificables reciben UUID nuevos, sin reutilizar IDs viejos.
  Dirección numérica, unidad y atributos participan; índices de extracción no son identidad.
- H3.4 verificado: 75 checks PG/HTTP y 28 en suite pura; reemplazo reordenado con dos
  convertidores opuestos, un ítem nuevo, cantidad modificada y respuesta a pregunta anterior.
  Stock y movimientos corresponden a los ítems correctos; preguntas viejas no se ejecutan.
- Cierre de regresiones: audio largo y borrados aprobados de nuevo. River se ejecutó
  nuevamente: conserva los dos fallos de normalización preexistentes ("Camiseta Camisetas
  River" / modelo "Camisetas River"); obtiene los tres SKU esperados, pero el script falla.
  No se cambiaron sus expectativas ni se presenta la suite histórica completa como verde.

- H4.0: ventas y reservas usan OperationPlan v1 y el mismo planner/adapter PostgreSQL.
  SKU existente explícito, permisos por verbo, unidad/estado/fingerprint y enteros seguros.
  Stock insuficiente rechaza todo el lote; nunca recorta cantidad ni crea un producto.
  Movimientos conservan deltas por ítem; recibos y respuestas muestran balances finales
  persistidos incluso si varias líneas afectan el mismo SKU. Replay no vuelve a aplicar.
- H4.0: precio de venta opcional separado del catálogo; desconocido no equivale a cero.
  Historial transaccional derivado del recibo comparte el commit. Panel envía ID/fingerprint
  real y conserva operationId tras fallo. Totales separan monedas, importes desconocidos
  y estimaciones históricas. No se revaloriza una venta nueva con el catálogo actual.
- H4.0: grounding conservador de ventas/reservas antes de ejecutar; descarta IDs propuestos
  por el parser y no autoriza nombres parciales/variantes omitidas. Dos líneas idénticas
  siguen siendo dos efectos. La escritura solo usa los IDs ya resueltos.
- H4.0: rechazo de dominio Meta queda terminal con acciones vacías y respuesta persistida;
  reentrega después de reponer stock no ejecuta esa venta. Fallo técnico sigue recuperable.
  Respuesta de consulta mixta y recibo comparten outbox; replay devuelve ese texto guardado.
- H4.0 verificado: 88 checks PostgreSQL/HTTP, 50 del motor y 29 de suite pura; build y
  Edge de ventas aprobados. Incluye operaciones múltiples/concurrentes, aislamiento,
  rollback de movimiento/outbox, replay, cotización cero/desconocida y monedas separadas.
  Edge usa API simulada; HTTP usa servidor y PostgreSQL temporales con firma Meta real.
  Revisión independiente de las dos ventanas de respuesta/reintento cerrada sin hallazgos.
  Audio largo aprobado. Evaluador offline de parser ejecutado (390 casos), sin proveedor
  real: no equivale a 390 aprobados ni mide calidad LLM. River conserva fallos conocidos.
- H4 restante: actualizaciones/ajustes, conjuntos, bajas, ABM con stock inicial, efectos de
  pedidos y finanzas siguen pendientes. Un lote con stock y finanzas no migradas se rechaza
  entero. Continúa bloqueo compatible con escritores históricos. No se desplegó.

- H4.1: `stock.adjust` fija balances absolutos no negativos, con revisión esperada y motivo;
  `sku.update` modifica metadatos/atributos tipados/precio de catálogo. Mismo contrato v1,
  planner y transacción; permisos separados. Revisiones avanzan una vez por SKU por plan.
  Deltas de ajuste son exactos; cambios de catálogo dejan movimiento cero como auditoría.
  Identidad duplicada/inactiva, revisión obsoleta y fingerprint distinto rechazan todo.
- H4.1: PUT individual y `update_product` usan el núcleo. Recibo guarda producto final
  completo; replay de PUT retorna ese producto aunque el stock haya cambiado después.
  Panel captura revisión al abrir, exige motivo y conserva ID/payload tras fallo ambiguo
  o fallo de refresh posterior al commit; cambiar el borrador genera ID nuevo, sin saltar
  la revisión original. Conflicto conserva borrador e indica revisar inventario vigente.
- H4.1: escritores legacy de modelo/pedidos invalidan revisiones. Pedido individual toma
  bloqueo de inventario antes de leer y bloqueo de su fila; reemplazo legacy preserva
  metadatos e incrementa revisión de productos cambiados. No se retiraron esos escritores.
- H4.1 verificado: 101 checks PG/HTTP, 30 de suite pura y 50 del motor. Incluye carreras
  entre ajustes, venta y pedidos legacy; rollback multi-SKU; replay congelado; aislamiento;
  PUT real con metadata+stock+fingerprint y Meta firmado con precio cero. Build y Edge:
  inventario, recuperación de borrador, ventas y nuevo test de ajustes aprobados.
  Revisión independiente encontró fingerprint contra estado intermedio y asociación
  desplazada tras expandir acciones; corregidos y cubiertos por regresiones. Audio largo
  aprobado; sin evaluación LLM ni despliegue real. No declarar completa arquitectura C.
- H4.1 límites: edición de modelo masiva, bajas, stock inicial de ABM y efectos de pedidos
  aún esperan migración. No hay conversión de unidades ni cantidades fraccionarias.

- H4.2a: módulo puro de selectores ids/all/filter, con igualdad conservadora de metadatos
  y atributos tipados (missing/unknown/ausente distintos). Máximo 100 SKU; conjunto vacío,
  ID inexistente y filtros abiertos/ambiguos se rechazan. Solo plantilla sku.update hoy.
- H4.2a: inventory_selections guarda actor/negocio, requestId/hash, miembros, revisiones,
  fingerprints, plan inmutable, digest y vencimiento de 15 minutos. Preview reintenta con
  el mismo contenido congelado; confirmar usa solo ese plan, sin buscar otra vez por nombre.
  SKU nuevos después del preview no se incorporan. Cambios concurrentes rechazan todo.
  Recibo/movimientos/historial y selección aplicada comparten transacción; confirmaciones
  concurrentes aplican una vez. Replay aplicado sigue disponible tras cambios y vencimiento.
- H4.2a: PUT de modelo retiró su SQL anterior; exige selección revisada. Panel captura IDs
  al abrir, muestra miembros exactos, estado y cambios; separa revisar/confirmar. Modificar
  campos invalida preview; fallo ambiguo conserva referencia, conflicto exige nueva revisión
  explícita y cancelar no escribe. Endpoints públicos de operaciones y compatibilidad
  rechazan actualizaciones de varios SKU sin selección; el núcleo interno sigue componible.
- H4.2a verificado: 110 checks PG/HTTP, 31 de suite pura y 50 del motor. HTTP real verifica
  autorización, preview sin escritura, bloqueo de bypass, digest, confirmación y replay.
  Rollback SQL, expiración, aislamiento de actor/negocio, selección obsoleta, nuevo SKU
  excluido y conflicto de identidad posterior cubiertos. Build y Edge de conjuntos,
  inventario existente y ajustes individuales aprobados. Revisión independiente sin hallazgos.
- H4.2a límites: selección de cambios de SKU vía API/panel, no diálogo universal de WhatsApp
  ni bajas/ajustes absolutos masivos. NOW() de PostgreSQL define admisión por inicio de
  transacción; no revalida vencimiento tras esperar locks. No se desplegó ni evaluó IA real.

## Continuación sin repetir investigación

- Rama: `codex/architecture-c-foundation`. H0 `aa0cebe`, H1 `88400cd`, H2 `fdb03ed`,
  H3.1 `f56b500`, H3.2 `b3e031f`; consultar `git log` para checkpoints siguientes.
- H4.0 `aa64aba`; H4.1 `c484e1c`; H4.2a consultar el siguiente commit de conjuntos.
- Checks base: `npm run test:inventory`, `npm run test:voice-stock-batches`,
  `npm run test:voice-stock-postgres`; este último crea y elimina PostgreSQL temporal.
- Frontend: `npm run test:inventory-ui` y `npm run test:panel-draft-recovery`.
- Ventas/ajustes/conjuntos: `npm run test:sales-ui`, `npm run test:inventory-adjustments-ui`
  y `npm run test:inventory-selection-ui`.
  Edge local; APIs/proveedores simulados. Ninguna de estas pruebas valida IA real.
- Producción: falta verificar configuración privada, backup/restauración recuperable,
  ejecutar migración controlada, comprobar SHA/readiness y piloto aislado. No desplegado.
