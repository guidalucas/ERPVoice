# Stocky: transición a arquitectura C

## Estado recuperable

- Base: `d53758832d37d522595b4830b428a20af5fdcba3` (2026-10-16).
- Decisión: monolito modular; IA propone, backend autoriza/resuelve/ejecuta.
- Auditoría previa reutilizada. No repetir investigación general.
- Trabajo previo preservado: modificaciones en postgresDatabase, metaWebhookProcessor,
  voiceCatalogContext y sus dos scripts de regresión de borrado/PG.
- Producción NO verificada. H5 inicial: Gemini real 10/10 casos; Meta y PostgreSQL con
  conexión comprobada. Migración remota universal aplicada y verificada; datos existentes
  preservados. Usuario dispensó backup explícitamente. Audio real aún sin clave configurada.
- Último alcance integrado: H4.5e, retiro del parser del navegador/endpoint antiguo y
  transcripción privada compartida. H4.5d2 WhatsApp/conjuntos `3c51c65`, panel/consultas
  `bf8e2c1`; familias H4.6b2 y cambios del usuario preservados. Ver git log para cierre audio.
- Cambios del usuario preservados: login `9801920`/`17763fa`, talles `d35145f`; b1 en `e22a459` y H4.6a en `0f084ec` (last version).

## Hitos y dependencias

| Hito | Alcance y componentes | Aceptación | Estado |
| --- | --- | --- | --- |
| H0 / P0 | Identidad conservadora reutilizable; autenticidad POST Meta; versión de despliegue. Engine, security, index. | Dirección/orden no colisionan; firma válida/tampered/missing; GET intacto; regresiones relevantes. | Implementado y verificado localmente |
| H1 / P1 | Contrato OperationPlan v1, dominio SKU/atributos tipados/unidades/precios, motor determinista y adapter PostgreSQL. | Contrato cerrado; tenant desde contexto autorizado; efectos exactos; rollback, concurrencia, idempotencia, resultados persistidos. | Implementado para todas las operaciones de inventario; verificado localmente |
| H2 / P2 | Ingresos resueltos de WhatsApp y panel al mismo ejecutor. | Única escritura add_stock por núcleo, sin segunda inferencia de nombre; outbox y lote atómicos; regresiones. | Implementado; verificado localmente |
| H3 / P3 | Borradores/preguntas con IDs y parches; intérprete IA desacoplado. | Correcciones parciales sin reextraer; errores técnicos tipados; replay y respuestas tardías seguras. | Entrada ordinaria, consultas y drafts/patches compartidos verificados localmente |
| H4 / P4 | Ventas, reservas, atributos, selectores/conjuntos y confirmaciones; retirar escritores anteriores. | Estado/respuesta exactos, stock insuficiente explícito; selección congelada y confirmación versionada. | Implementación local integrada; compatibilidad histórica al mismo núcleo conservada hasta piloto H5 |
| H5 | Comparación pipelines, evaluación real, piloto y limpieza final. | Corpus reservado, métricas completas, SHA desplegado, aislamiento, sin escritores duplicados. | Gemini y migración remota verificados; audio, despliegue y piloto pendientes |

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
- El escritor de tablas completas ya fue retirado. Conservar por ahora el bloqueo compartido
  entre inventario, cuentas, pedidos y metadatos; reducirlo solo con pruebas de concurrencia.
- Conservar fuente, evidencias, claims, control de versión y outbox. Migrar etapas sin
  reinterpretar mensajes ya aplicados ni descartar borradores activos.

## Pruebas y migración

- Referencia inicial: motor 48; PostgreSQL aislado 42; audio largo y borrados aprobados.
  Los dos fallos históricos de presentación de River quedaron corregidos el 2026-10-18;
  ver cierre al final del registro. Última validación integrada: 323 PG/HTTP, 151 puras,
  10 casos sintéticos del evaluador, 50 regresiones del motor y build aprobados.
  Edge chat/audio, revisión universal y recuperación legacy aprobados al cierre H4.5e;
  familias aprobadas en su hito. Proveedores reales sin configurar.
- Cada hito: pruebas puras/contratos, PG temporal cuando aplica, regresiones de consumidores,
  estado final y respuesta. Build/typecheck no sustituyen integración.
- Migración PostgreSQL aditiva/repetible, probada en base temporal antes de producción.
- Commit por hito integrado; cambios previos checkpoint separado para no perder trabajo.
- Rollback de código conserva tablas/historial. No usar el parser antiguo como supuesto
  rollback seguro si puede aplicar por nombre; suspender capacidad afectada ante fallo.
- Sin acceso externo: avanzar localmente; documentar evaluación LLM, backup recuperable,
  configuración META_APP_SECRET, despliegue y smoke productivo como pendientes concretos.

## Próximo paso exacto

H5 siguiente: configurar GROQ_API_KEY o VOICE_TRANSCRIPTION_API_KEY para audio real.
La migración remota universal ya está aplicada y comprobada; no repetir bootstrap global
para resolver esa incidencia. Usuario indicó explícitamente que no necesita backup:
no volver a bloquear la continuación con ese requisito ni declarar restauración validada.
Gemini ya completó
el corpus de 10 casos tras corregir instrucciones; mantener ese resultado como muestra
acotada, no como aceptación del piloto. Completar después login/webhook y envío real Meta,
despliegue SHA/readiness y piloto texto/audio con confirmación/reintento en entorno aislado.
Tras el piloto y sin propuestas/lotes antiguos pendientes, retirar adaptadores históricos
de /api/state/apply y reanudación legacy. Hoy usan el mismo núcleo; no son otro escritor.
El usuario configuró .env.local y confirmó que la base contiene datos reales. Autorizó
continuar sin backup: migración acotada confirmada, datos preservados. Smoke de borrador
real dentro de una transacción revertida; no hubo mensajes enviados. No desplegar
ni confundir conexiones API con aceptación del piloto. No reauditar ni duplicar escritores.

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

- H4.3 (2026-10-17): `sku.deactivate` en el mismo OperationPlan v1/planner/adapter. Requiere
  SKU existente, revisión, permiso y motivo. Conserva cantidades/precios/identidad e historial;
  movimiento de auditoría con deltas cero y recibo con estado/revisión/producto persistidos.
  Unidades reservadas rechazan el lote entero. Inactivo no admite ventas/ingresos/ajustes ni
  cambios de catálogo; creación idéntica queda bloqueada. Reactivación explícita pendiente.
- H4.3: DELETE individual/batch solo confirma selección de bajas (tipo y alcance exactos).
  Retirados SQL DELETE anteriores y rama delete_product por nombre del escritor histórico.
  Snapshots operativos excluyen inactivos; snapshots internos del reemplazo/pedidos conservan
  filas archivadas. Pedidos legacy rechazan efecto de stock en SKU inactivo y no lo recrean.
  Alta manual todavía legacy agregó guarda transaccional contra identidad archivada.
- H4.3: panel captura IDs, exige motivo, muestra preview antes de confirmar y conserva
  referencia tras 503 o refresh fallido; selección obsoleta requiere revisión explícita.
  WhatsApp propone baja sin acciones aplicadas y exige código de 8 dígitos hexadecimales
  ligado a selección/negocio/remitente. Código explícito intercepta antes del diálogo de
  ingresos; no toma un “sí” como autorización. Cancelar invalida esa selección en PostgreSQL.
  Core, recibo, historial, selección aplicada y outbox de confirmación comparten transacción.
  Confirmar/cancelar concurrentes se serializan. Replay conserva recibo aun tras vencer.
- H4.3: preview Meta demasiado extenso se rechaza sin truncar miembros; recibo largo usa
  resumen de cantidad exacta y conserva detalle completo en base. No hubo llamadas a Meta
  de producción ni proveedores LLM reales; se probó firma HTTP contra servidor local.
- H4.3 verificado: 124 checks PostgreSQL/HTTP, 32 de suite pura y 50 del motor. Incluye
  carreras venta/baja y confirmar/cancelar, rollback de movimiento/outbox, reservas, ámbito,
  selección obsoleta, historial intacto, guardas legacy y DELETE con recibo. Meta firmado
  prueba solicitud/confirmación/reentrega, remitente ajeno, cancelación y revisión obsoleta.
  Build y Edge de bajas, inventario completo y edición de modelos aprobados; audio largo
  y parsing de borrados también. Revisión independiente backend sin hallazgos P1/P2.
- H4.3 límites: no hay purga física ni UI de reactivación/archivo. Altas con stock inicial,
  efectos de pedidos y finanzas aún no migrados. Conservar bloqueo amplio hasta retirarlos.
  River mantiene los dos fallos conocidos; IA real y despliegue siguen pendientes.

- H4.4a (2026-10-17): `sku.create` reutiliza OperationPlan v1, planner y adapter PG.
  Solo target nuevo explícito, initialStock con disponibles/reservados enteros no negativos,
  motivo y precio initialize opcional. Cero deja movimiento de auditoría cero, sin cantidad
  ficticia. Permiso inventory:create y, si hay reservado inicial, también inventory:reserve.
  Identidad activa duplicada o archivada rechaza el lote; atributos/unidad son identidad.
- H4.4a: retirados INSERT propios de createProductRecord/createProductModelRecords.
  productCreationAdapter traduce las rutas compatibles al contrato cerrado: operationId
  obligatorio, números omitidos cero, null/cadenas/fracciones rechazados, máximo 100 variantes.
  Unidad/atributos tipados/moneda preservados. Contexto autorizado del backend; payload no
  elige negocio. Recibo, producto creado, movimientos e historial comparten transacción.
  Replay retorna productos originales incluso tras ventas/ingresos posteriores.
- H4.4a: create_product es evento de historial derivado del recibo, no comando de escritura
  ni salida admitida del parser. Modelo sigue siendo lote de SKU, sin entidad de familia:
  se retiró la restricción SQL por tipo/modelo; API admite variantes únicas adicionales,
  conservando validación de identidad en núcleo. El panel conserva su guarda de nuevo modelo.
- H4.4a: panel captura payload/UUID para SKU, variante y modelo; 503 o refresh fallido
  mantienen el intento incluso después de hidratar inventario. Editar/cancelar genera otro
  intento; formulario bloqueado durante envío. Historial muestra alta y balances exactos.
  Fixtures/seed de productos pasan IDs explícitos; no se ejecutó seed contra base real.
- H4.4a verificado: 134 checks PostgreSQL/HTTP, 39 tests de suite pura y 50 del motor.
  Incluye creación cero/positiva/reservada, lotes atómicos, carreras por ID e identidad,
  permisos/ámbitos, rollback SQL, replay congelado y contratos HTTP reales. Build aprobado;
  Edge de altas (con prueba de tipos de atributos), inventario, ajustes, conjuntos y bajas
  aprobados. Edge usa API simulada. Revisión independiente: corregidas validación de nombre
  antes de coerción y unión de atributos frontend; sin otros hallazgos backend pendientes.
- H4.4a límites: pedidos/reemplazo legacy aún escriben stock y requieren bloqueo amplio;
  finanzas, intérprete universal y esquemas de familias configurables pendientes. No se
  desplegó ni evaluó IA real. River conserva las dos fallas conocidas del registro anterior.

- H4.4b (2026-10-17): pedidos registran product_id, revision y stock_posting_json (ingreso
  neto vigente: SKU, cantidad, unidad). Conseguido significa aprovisionamiento: entrar suma;
  salir/borrar retira exactamente lo registrado del SKU original. Cambiar cantidad aplica
  diferencia neta; cambiar SKU revierte y recibe atómicamente. Sin stock suficiente se
  rechaza todo; no recorta ni registra ventas/ingresos financieros ficticios.
- H4.4b: stock.withdraw amplía el mismo OperationPlan/planner/adapter; exige SKU existente,
  cantidad positiva, motivo y permiso propio. No admite precios ni afecta reservado.
  orderOperations planifica transiciones; orderPostgres ejecuta pedido + núcleo + historial
  en una transacción. order_operations guarda solicitud normalizada y resultado inmutable
  incluso si no cambia stock o se borra el pedido. Replay precede a existencia/revisión;
  IDs internos reservados y locks ordenados impiden colisión con operaciones externas.
- H4.4b: POST pide operationId; PUT/DELETE también expectedRevision. Creación conseguida
  exige SKU explícito; pendientes pueden ser texto libre. Clientes/proveedores se validan
  dentro del negocio. Pedido histórico conseguido sin procedencia no se reinterpreta.
  Borrar cliente con pedidos se rechaza; fusiones/bajas de proveedor invalidan revisiones.
- H4.4b: retirados ensureProduct, applyPedidoEstadoStockEffect, resolución aproximada de
  pedidos y reemplazo completo de productos/clientes/proveedores. La última rama financiera
  actualiza solo deuda, sin tocar inventario ni pedidos; todavía requiere H4.4c.
  WhatsApp/panel adaptan pedidos al mismo ejecutor; nombres solo seleccionan un pedido único
  con igualdad conservadora antes de escribir. IDs de SKU propuestos por IA se descartan;
  pedido sin SKU vinculado necesita selección explícita, no nueva inferencia al conseguirlo.
- H4.4b: lotes de pedidos y outbox atómicos, recibos congelados y proyección común en
  operationResults para eventos Meta. Panel conserva cuerpo/UUID/revisión tras 503 y refresh
  fallido; retry permanece visible tras hidratar otro estado. Elegir SKU o revisar conflicto
  abre un intento nuevo; controles bloqueados durante envío. Seed actualizado, no ejecutado.
- H4.4b verificado: 145 checks PostgreSQL/HTTP, 43 tests puros y 50 del motor. Carreras,
  rollback de movimiento/outbox (incluidos clientes creados), cambios de cantidad/SKU,
  replay tras borrado, aislamiento y revisiones indirectas cubiertos. HTTP real con JWT y
  Meta firmado valida ingreso/replay y reversión insuficiente terminal. Build y Edge de
  pedidos e inventario aprobados; Edge usa API simulada. Revisión arquitectónica independiente
  señaló borrado indirecto, procedencia neta y orden de locks, corregidos y probados.
- H4.4b límites: conciliación histórica aún sin UI/contrato, finanzas todavía legacy,
  intérprete universal/esquemas configurables y evaluación/despliegue pendientes. No se
  cambió configuración productiva ni se llamó a proveedores reales. No declarar C completa.

- H4.4c (2026-10-17): accountOperations implementa account.charge/payment/adjust/transfer
  con la misma envoltura OperationPlan v1, validación cerrada y dominio puro propio.
  No duplica Inventory Engine. Cliente explícito, motivo, importes enteros seguros; ajustes
  y transferencias requieren revisión. Pago excesivo rechaza todo, sin truncar ni sobregirar.
  Unidad legacy-money conserva los importes históricos sin inventar moneda/conversión.
- H4.4c: accountPostgres guarda recibo, deltas, revisiones e historial en una transacción;
  replay vuelve antes de consultar saldo actual. BIGINT y account_revision aditivos en
  clientes; account_operations/account_movements conservan auditoría. Solo este adapter
  cambia saldos de cuentas. Creación de clientes inicia en cero; cargos/ajustes explícitos
  reemplazan deuda inicial o PUT directo. Metadatos ya no sobrescriben deuda concurrente.
- H4.4c: retirado calculateProductDebt y el último bucle financiero legacy; ningún cargo
  usa precio de catálogo ni fallback al primer cliente. Adapters panel/WhatsApp resuelven
  igualdad conservadora única antes de ejecutar por ID; IDs de cliente del LLM ignorados.
  API autenticada POST /api/accounts/operations; recibos alimentan respuesta y evento Meta.
  Outbox comparte commit; rechazo de pago en Meta queda terminal tras reentrega.
- H4.4c: clientMergePostgres transfiere saldo, mueve pedidos/avanza sus revisiones, une
  notas y elimina origen atómicamente. Padre/transferencia tienen recibos; locks internos
  reservados evitan colisiones y replay funciona tras borrar origen y cambiar saldos.
  POST /api/clients/merge exige operationId y revisiones de ambas cuentas. Panel captura
  cuerpo/revisiones, conserva retry tras 503 e hidratación y muestra los saldos a trasladar.
  Borrar cliente con saldo o pedidos se rechaza; errores de clientes son visibles en panel.
- H4.4c verificado: 154 checks PG/HTTP y 46 tests puros, build y Edge de cuentas aprobados.
  Cubre pagos concurrentes, balances finales, transferencias, ámbito/permisos, revisiones,
  importes explícitos, rollback de ledger/outbox y fusión tras transferencia/movimiento de
  pedidos/borrado. HTTP real prueba contrato, JWT, rutas antiguas cerradas y Meta firmado
  con pago/replay/rechazo terminal. Edge prueba fusión con 503/origen desaparecido, conflicto
  y controles de envío. Regresiones del motor siguen en 50; sin proveedor real ni despliegue.
- H4.4c límites: no es contabilidad multimoneda ni créditos negativos; saldos históricos
  inválidos requieren conciliación. CRUD de metadatos, conciliación de pedidos, planes
  mixtos entre dominios, intérprete universal y familias configurables siguen pendientes.

- H4.4d (2026-10-17): conciliación histórica individual en orderOperations/orderPostgres,
  sin nuevo escritor ni tabla. POST /api/pedidos/:id/reconcile exige operationId, revisión
  del pedido y reconciliation con SKU/revisión/fingerprint, disponibles/reservados vistos,
  cantidad/unidad, motivo y confirmed=true. Verifica igualdad con lo persistido y disponible
  suficiente para atribuir toda la cantidad; solo pedidos conseguidos sin posting previo.
- H4.4d: registra stock.adjust con balance idéntico (delta cero) y liga posting en la misma
  transacción. No atribuye recibos antiguos por nombre ni vuelve a recibir mercadería.
  Después se puede revertir el pedido con stock.withdraw exacto; cambios concurrentes,
  SKU ajeno/inactivo, balances forjados o falta de confirmación rechazan todo.
- H4.4d: OrderReconciliationForm presenta SKU/motivo, revisión congelada, balances y cantidad
  a atribuir; checkbox explícito antes de confirmar. Cambiar revisión crea intento nuevo.
  Pendiente de respuesta conserva cuerpo/UUID/consentimiento; retry sigue disponible tras
  hidratar posting aplicado y desmontar el formulario. Pedido sin conciliar no puede usar
  botones de reversión. Decisión humana queda en request_json y motivo del movimiento cero.
- H4.4d verificado: 158 checks PostgreSQL/HTTP, 47 tests puros, build y Edge de pedidos con
  conciliación aprobados. Prueba replay concurrente y tras cambios/borrado, cero exacto,
  reversión posterior, aislamiento, stale/fingerprint/cantidades alteradas y rollback al
  persistir el vínculo después del movimiento. HTTP real con JWT prueba confirmación y
  revisión; Edge verifica preview sin escritura, checkbox, 503 y retry tras hidratar.
- H4.4d límites: requiere revisión humana; no certifica un ingreso histórico desconocido.
  No se concilió ningún dato real. Conciliaciones masivas/WhatsApp, CRUD de metadatos,
  composición entre dominios, intérprete universal y esquemas configurables aún pendientes.

- H4.4e0 (2026-10-17): retirado transactionService.ts completo (490 líneas) y API/acción
  APPLY_EXTERNAL_PROPOSAL de AppStore. Búsqueda de consumidores confirmó que solo el store
  lo importaba; no había llamadas activas. Se eliminó así el motor local con resolución
  aproximada, creación implícita, recortes de stock y deuda, pedidos/borrados divergentes.
  El panel conserva confirmación HTTP, snapshot persistido y borrador recuperable.
- H4.4e0 verificado: build y Edge de inventario y panel-draft-recovery aprobados tras borrar
  el módulo. Cubre 503+recarga con mismo ID/una escritura, cancelación, ámbito de negocio y
  actor, snapshot inválido, propuesta concurrente y cuota de almacenamiento. rg no encuentra
  transactionService/applyExternalProposal/applyConfirmedActions/APPLY_EXTERNAL_PROPOSAL
  en src/scripts. Suites backend siguen en 158 checks PG/HTTP y 47 tests puros; sin cambios
  backend en este retiro. No ejecutar tests que solo reproduzcan código eliminado.

- P0 de lecturas (2026-10-17): getStateSnapshot delega a lectura estricta en una transacción
  REPEATABLE READ READ ONLY; inventario, cuentas, pedidos e historial comparten snapshot.
  Retirados catch/fallback vacío y normalización con escrituras ocultas durante lectura.
  Un fallo de conexión/arranque o SELECT se propaga; GET /api/state responde 503 genérico
  STATE_UNAVAILABLE sin arrays vacíos ni detalles SQL. El panel conserva su estado anterior.
- P0 de lecturas verificado: 160 checks PG/HTTP. Incluye conexión de arranque fallida seguida
  de recuperación exacta y fallo real de tabla durante GET con recuperación de stock 7.
  Suites puras permanecen en 47 y motor en 50; build y Edge ya aprobados en e0, sin cambios
  frontend aquí. Consultas de WhatsApp/ingresos también usan la lectura estricta compartida.

- H4.4e1a (2026-10-17): partyOperations/partyPostgres usan OperationPlan v1 cerrado para
  client.create/supplier.create, individual o lote atómico. party_operations conserva
  hash/plan/actor/recibo inmutable; historia se proyecta desde filas persistidas. Cliente
  inicia con saldo cero; no hay movimientos de stock/cuenta. HTTP exige operationId,
  deriva negocio/actor y rechaza campos desconocidos; replay devuelve original incluso
  tras editar/borrar, sin resucitar entidad. Migración aditiva/repetible con RLS.
- H4.4e1a: pedidos compatibles crean participantes por el mismo ejecutor dentro de su
  transacción; IDs order-party reservados y lock compartido antes de resolver evitan la
  doble creación concurrente por igualdad exacta. Fallo de outbox revierte también recibos
  de participantes. Panel y pedidos retienen cuerpo/UUID ante 503/refresco fallido, muestran
  errores, bloquean doble envío y renuevan intento solo al editar o cancelar explícitamente.
- H4.4e1a verificado: 171 checks PG/HTTP, 50 tests puros y 50 regresiones del motor; build,
  Edge party-create-ui y order-ui aprobados. Incluye concurrencia, ámbito/permisos antes
  de replay, deuda prohibida, campos cerrados y fallos inducidos de recibo/segunda entidad/
  nombre/deuda persistidos con rollback total. Edge usa API simulada y PG base temporal.
- H4.4e1a límites: los intentos UI viven en memoria del componente (no sobreviven recarga
  completa); recibos backend son persistentes. PUT/baja/fusión proveedor siguen pendientes
  de migración, igual que composición universal y familias; no declarar H4/H5 terminados.

- H4.4e1b (2026-10-17): client.update/supplier.update usan el mismo contrato party v1,
  patch cerrado name/notas, target explícito y metadataRevision BIGINT independiente del
  saldo/accountRevision. Revisión obligatoria, incremento incluso si patch no cambia valor,
  CAS y recibo exacto antes de existencia actual. Doble target en lote se rechaza entero.
  PUT autenticados ya no escriben directamente; campos desconocidos/deuda quedan cerrados.
- H4.4e1b: metadatos y pago concurrentes conservan ambos efectos; metadataRevision no avanza
  por cuenta ni accountRevision por notas. Fusiones legacy avanzan metadataRevision para
  invalidar ediciones previas. El panel captura revisión al abrir editor, cuerpo/UUID al
  enviar, conserva retry global tras hidratación/borrado y exige revisión explícita si
  cambia el borrador sobre una entidad actualizada. No sobrescribe automáticamente un 409.
- H4.4e1b verificado: 182 checks PG/HTTP y 52 tests puros; build y Edge party-edit-ui,
  party-create-ui y client-account-ui aprobados. Incluye replay concurrente, ganador único
  de cambios distintos, pago simultáneo, aislamiento, lote crear/editar con rollback,
  triggers de divergencia y recibo fallido, replay después de otra edición/baja y merge.
  Motor permanece en 50 regresiones de e1a. No desplegado ni evaluado con LLM real.

- H4.4e1c (2026-10-17): bajas client.delete/supplier.delete y supplier.merge por party v1,
  IDs/motivo/revisiones obligatorios y recibos que sobreviven al borrado. Cliente exige
  también accountRevision vigente, saldo cero y ausencia de pedidos. Proveedor se elimina
  desligando pedidos o se fusiona trasladándolos y uniendo notas, sin tocar stock/postings.
  Los recibos enumeran exactamente IDs, vínculo y revisiones resultantes de los pedidos.
- H4.4e1c: movePartyOrders verifica RETURNING completo contra el estado previo (incluidas
  fechas/qty/posting), permitiendo solo vínculo+revisión. Fusión de clientes ahora verifica
  metadatos y saldos; conserva replay de recibos históricos con hash original. Transfiere
  saldo por accountPostgres, mueve pedidos por helper verificado y cambia notas/baja origen
  por partyPostgres con childreceipt reservado. Falla cualquiera: rollback de toda la transacción.
  Solo partyPostgres escribe entidades/metadatos; solo accountPostgres cambia sus saldos.
- H4.4e1c: panel conserva cuerpos/IDs/revisiones de bajas/fusiones tras 503 o refresco
  fallido, mantiene retry fuera de las tarjetas borradas y exige revisar para nuevo intento.
  Explica que baja proveedor conserva pedidos sin vínculo y fusión une notas/traslada pedidos.
  Cuenta+metadatos se capturan juntos al fusionar clientes; controles bloquean doble envío.
- H4.4e1c verificado: 198 checks PG/HTTP, 54 tests puros; build y Edge party-delete-merge-ui,
  party-create-ui, party-edit-ui y client-account-ui aprobados. Incluye competencia/replay,
  guards financieros/pedidos, IDs ajenos, revisiones vencidas, legacy replay y fallos SQL de
  recibo/fechas/qty/posting con rollback total. Revisión independiente enfocada sin hallazgos.
  Sin despliegue/LLM real; fusión limita notas a 8000 caracteres, nunca las trunca.

- H4.5a (2026-10-17): POST /api/operations acepta OperationPlan v1 homogéneo de inventario,
  cuentas o entidades. universalOperations selecciona dominio y reutiliza sus validadores;
  universalPostgres solo orquesta adaptadores existentes, sin lógica de stock/cuenta nueva.
  universal_operations guarda padre/plan/hash/actor/recibo; childreceipts universal-child
  son internos y se escriben en la misma transacción. Reutilizar ID entre dominios por esta
  entrada produce conflicto. Proyección de eventos desenvuelve el recibo de dominio.
- H4.5a: autorización antes de replay, tenant por backend, IDs internos no invocables desde
  rutas de dominio y mismo orden de locks. Plan mixto/acción desconocida se rechaza antes
  de escribir; guard de selección revisada conserva restricciones previas. HTTP no habilita
  stock.withdraw. Inventario registra historia por callback compartido; cuentas/party ya
  la registran dentro de sus adaptadores. Las rutas anteriores siguen siendo compatibles.
- H4.5a seguridad: registradas también order_operations, account_operations/account_movements
  e inventory_selections en RLS/revocación a roles cliente, junto a universal_operations.
  Migración repetida conserva datos; lectura/backend continúan con su rol autorizado.
- H4.5a verificado: 215 checks PG/HTTP y 57 tests puros, build aprobado; tres dominios,
  root/child receipts concurrentes, cambios/borrado posteriores, colisiones, aislamiento,
  permisos, selección obligatoria y fallo SQL padre que revierte efectos/ledger/historia.
  Revisión independiente sin hallazgos concretos. Edge de CRUD sigue aprobado en e1c.
- H4.5a límites: entrada común no equivale a intérprete universal terminado. No compone
  dominios ni pedidos/client.merge en un solo plan; canales/parser aún usan adapters
  compatibles. Idempotencia raíz global aplica a esta entrada, no reconcilia IDs ya usados
  en endpoints históricos de dominios distintos. No desplegado ni probado con LLM real.

- H4.2b1 (2026-10-17): selecciones congeladas admiten stock.adjust con balances absolutos
  parciales y motivo. El mismo planner calcula finalAvailable/finalReserved por SKU y unidad
  en preview; no hay escritura de stock hasta confirmar digest/actor/TTL. Campo omitido
  conserva saldo observado; nuevos SKU no se incorporan y cambio de revisión/fingerprint
  rechaza todo. Se mantienen guards de ajuste masivo directo en APIs de dominio/universal.
- H4.2b1: StockSetAdjustmentForm permite elegir 1–100 SKU, muestra antes/después y unidad,
  exige consentimiento antes de confirmar y conserva referencia ante 503/refresco fallido.
  Cambiar borrador invalida preview/consentimiento; 409 exige nueva revisión explícita.
  Se bloquea doble envío. El servicio rechaza previews con saldos finales forjados o campos
  que no coinciden con lo solicitado. Formularios previos de selección siguen compatibles.
- H4.2b1 verificado sobre el estado del usuario d35145f: build, 60 tests puros, 228 checks
  PostgreSQL/HTTP y 50 regresiones de motor aprobados. Edge stock-set-adjustment-ui e
  inventory-selection-ui aprobados. SQL prueba rollback de movimiento/recibo/historia/
  estado de selección; HTTP prueba scopes, confirmación concurrente, freeze y replay.
- H4.2b1 recuperabilidad: código fue guardado por el usuario en e22a459; sus commits de
  login 9801920/17763fa y talles d35145f se conservaron. Validación final incluye esos
  cambios. test-river-stock-query mantiene dos fallas previas de representación
  (Camiseta Camisetas River), con los tres productos correctos; casos nuevos de talles
  pasan. No presentar esa suite como aprobada. No se verificó login contra Meta real.
- Pendiente global: conversación de conjuntos para otros verbos, intérprete/composición
  universal, familias/esquemas configurables y H5 externo. La reingeniería completa sigue
  abierta. Intentos UI de este formulario viven en memoria; recibos/selecciones son
  persistentes. No hubo despliegue ni evaluación LLM real en este cierre.

- H4.2b2 (2026-10-17): inventoryMetaSelections generaliza comandos BAJA/CAMBIO/AJUSTE,
  vista completa con cambios o balances antes/después/unidad y motivo; jamás trunca revisión.
  Nuevos inventoryMetaSelectionPostgres y meta_selection_commands guardan resultado terminal
  de cada comando y outbox en el mismo commit. SAVEPOINT revierte efectos parciales incluso
  ante PERSISTED_EFFECT_MISMATCH antes de guardar un rechazo; fallos SQL revierten todo.
- H4.2b2: preparar usa IDs grounded por backend y misma mutación para el conjunto; mezcla
  de tipos/valores se rechaza explícitamente. Preview y respuesta comparten transacción.
  Confirmación actor/negocio/código/tipo/TTL apunta a selección persistida, sin nuevo match.
  Repetir mensaje reproduce primer recibo; nuevo ID puede confirmar selección aplicada sin
  volver a ejecutar. Cancelar y confirmar se serializan. IDs conversacionales reservados.
- H4.2b2: index usa contexto único por mensaje, resume preview persistido antes del parser
  y dirige update_product al flujo revisado. Aliases de bajas y rutas del panel conservan
  compatibilidad. Prefijo de consultas queda en primer outbox; conflicto de destinatario/
  contenido rechaza la transacción en vez de enviar una respuesta ajena a lo aplicado.
- H4.2b2 verificado: 238 checks PG/HTTP, 68 pruebas puras y build aprobados. HTTP firmado
  demuestra precio cero pendiente -> CONFIRMAR CAMBIO -> precio/historia/evento exactos.
  SQL prueba saldo SET individual/múltiple, concurrencia, rechazo terminal, cancelación,
  scope/tipo/expiración, outbox fallido y trigger de efecto divergente con rollback.
  La prueba anterior de dos aclaraciones ahora usa candidatos realmente ofrecidos, confirma
  un solo movimiento y verifica todos los SKU; no depende de IDs aleatorios de dos variantes.
- H4.2b2 límites: conjuntos con efectos diferentes o ficha+saldo se revisan por separado;
  selección desde texto aún depende del adapter grounded existente. No es todavía el
  intérprete universal. No hubo proveedor/WhatsApp real ni despliegue en este hito.

- H4.5b1 (2026-10-17): universalOperations admite bloques contiguos de inventario/cuentas/
  entidades en el orden declarado. Cada dominio aparece una vez; reentrada se rechaza con
  UNSUPPORTED_OPERATION_ORDER. Todos los bloques se normalizan/autorizan antes de escribir;
  IDs únicos tanto crudos como normalizados. No hay referencias implícitas a entidades nuevas.
- H4.5b1: universalPostgres ejecuta cada bloque por su adapter existente dentro de una sola
  transacción; child IDs privados por raíz/dominio/ordinal, recibos ordenados e historia
  común. Fallo del último bloque o del recibo padre revierte stock/cuenta/entidades y todos
  los recibos/movimientos previos. Pago seguido de baja permite revisión financiera futura
  explícita; invertir el orden rechaza saldo positivo. No reordena silenciosamente acciones.
- H4.5b1: forma/hash/replay homogéneos anteriores se conservan. Hash mixto incluye bloques
  y orden; cambiar un importe o reordenar con mismo ID es conflicto. Guard de selección
  masiva sigue vigente. El resultado mixto expone receipts por bloque y proyección existente.
- H4.5b1 verificado: 247 checks PG/HTTP y 75 pruebas puras; revisión independiente enfocada
  sin hallazgos. Incluye triple dominio, concurrencia, replay tras cambios, scopes/permisos,
  validación previa, rollback por falla tardía/SQL padre, orden y colisión. Build de b2
  conversacional sigue vigente, sin cambios frontend aquí. Sin despliegue/LLM real.
- H4.5b1 límites: cada recibo refleja el punto de ejecución de su bloque. Reentradas,
  aliases a entidades recién creadas, pedidos y client.merge aún no están en esta entrada.
  Las rutas compatibles conservan esas capacidades; no declarar intérprete/composición
  universal completos por esta ampliación.

- H4.5b2 (2026-10-17): order.create/update/delete/reconcile usan el mismo envelope universal.
  Normalización delegada a orderOperations; cada bloque/ítem delega exclusivamente a
  orderPostgres e Inventory Engine existentes. Permisos derivados de stock solo existen
  en el contexto interno de pedidos: stock.withdraw público sigue prohibido.
- H4.5b2: recibos raíz/bloque/ítem, expectedRevision, postings y reconciliación histórica
  conservan semántica. Lotes homogéneos o mixtos son atómicos; fallos SQL del padre/bloque
  revierten pedidos, stock, historial, ledger y recibos. Replay precede lectura del catálogo.
- H4.5b2 verificado: 255 checks PostgreSQL/HTTP y 81 pruebas puras aprobados; revisión
  crítica independiente sin hallazgos. Incluye concurrencia, múltiples pedidos, reversión,
  aislamiento, permisos, revisión obsoleta y reproducción tras borrar/cambiar entidades.
  Sin cambios frontend en este hito; build anterior sigue vigente. Sin despliegue/LLM real.
- Pendiente: intérprete/conversación universales, familias persistentes, migración de
  consumidores y validación H5. Este checkpoint no cierra la reingeniería completa.

- H4.5c1 (2026-10-17): universalIntentInterpreter usa proveedor inyectable y salida cerrada
  propuesta/pregunta, diferenciando invalid/unavailable. El modelo no recibe tenant/actor/
  permisos/operationId ni puede emitir precondiciones. Backend fija revisiones/fingerprints
  y verifica IDs ofrecidos/evidencia literal antes de validar el contrato universal.
- H4.5c1: universal_drafts y universal_draft_commands persisten revisión, versión, digest,
  TTL y primera respuesta por requestId/actor/negocio. Preparar no muta inventario; confirmar
  ejecuta el mismo motor y guarda estado applied en su transacción. Replay concurrente y
  posterior a cambios devuelve recibo original; fallo de guardado revierte todos los efectos.
  IDs draft-operation reservados a confirmar. RLS/revocaciones agregadas a ambas tablas.
- H4.5c1: preguntas/respuestas viajan como historial estructurado, separado del texto de
  evidencia del usuario. Catálogo usa identidad SQL cruda y snapshot coherente, sin nombres
  de presentación ni historial innecesario. Revisión legible se genera en backend y persiste.
- H4.5c1 panel: chat ofrece Revisar operación; modal recupera referencia e intentos por
  tenant/actor, conserva IDs ante respuesta incierta, muestra revisión completa, requiere
  consentimiento nuevo tras recuperación y permite cancelar borradores vencidos. Aplicado
  con refresco fallido muestra el resultado persistido y reintenta solo la lectura.
- H4.5c1 verificado: 265 checks PG/HTTP, 92 pruebas puras, build y Edge universal-draft-ui
  aprobados. Revisión independiente encontró pérdida de pregunta; corregida y probada con
  pregunta/respuesta estructuradas que no autorizan evidencia del asistente. Identidad cruda,
  aislamiento, CAS, rollback del estado final y replay sin proveedor incluidos.
- H4.5c1 límites: canal WhatsApp anterior conserva adapters; entrada nueva del panel es
  explícita. Correcciones de planes listos requieren cancelar/nuevo borrador hasta c2.
  Selecciones masivas mantienen su flujo revisado; reentradas, aliases nuevos y pago+baja
  dependiente se rechazan conservadoramente. Catálogo/texto acotados se rechazan completos,
  nunca se truncan. Proveedores en pruebas simulados; no hay evaluación real ni despliegue.

- H4.5c2 (2026-10-17): respuestas a revisiones listas usan patches por itemId. No permiten
  agregar, borrar, reordenar ni cambiar tipo/ID de acciones; target y attributes se reemplazan
  enteros, otros campos se fusionan conservando lo no corregido. Evidencia del parche debe
  pertenecer exclusivamente a la nueva respuesta; ítems intactos conservan su evidencia.
- H4.5c2: backend valida plan previo antes del proveedor, renueva precondiciones desde
  snapshot coherente y genera otra revisión completa. Pregunta intermedia conserva plan,
  evidencia y revisión anteriores, bloqueando confirmar hasta resolverla. Versión/CAS y
  comandos inmutables serializan correcciones simultáneas y compiten seguro con confirmar.
- H4.5c2 panel: Corregir revisión conserva borrador e intento entre recargas, exige nuevo
  consentimiento y oculta confirmar mientras se edita. Volver a revisión consulta el estado
  y puede abandonar solo el parche; una respuesta tardía queda protegida por versión.
- H4.5c2 revisión independiente encontró y se corrigieron dos defectos: limpieza recursiva
  quitaba atributos legítimos expected_lifespan y Volver a revisión quedaba atrapado tras
  error. Ahora se quitan solo precondiciones de target/destination/reconciliation; atributos
  expected*/source se preservan y admiten corrección. Fallos 4xx de parche liberan su intento.
- H4.5c2 verificado: 269 checks PG/HTTP, 99 pruebas puras, build y Edge universal-draft-ui
  aprobados, incluidos rollback de cambio de versión/comando, corrección aplicada con
  respuesta perdida, error 422/503 sin persistir, concurrencia, cero y conservación de otros
  ítems. Revisión final de ambos fixes sin hallazgos nuevos. Proveedores simulados.
- H4.5c2 límites: no cambia el tipo ni la cantidad de ítems del plan mediante corrección;
  nueva intención independiente requiere otro borrador. Familias, migración del canal
  WhatsApp al servicio universal y evaluación real/H5 continúan pendientes.

- H4.6a (cierre 2026-10-18): productFamilySchemas define esquema cerrado con atributos
  tipados, requeridos, estados, unidad, enumeraciones y política de atributos adicionales.
  product_family_schemas publica versiones inmutables por expectedVersion; recibos
  product_family_operations conservan idempotencia y rollback. RLS/revocaciones incluidas.
- H4.6a: SKU referencia family:{id,version} explícita. Identidad incorpora family.id,
  no su versión; fingerprint sí incorpora versión. Productos sin familia conservan hash
  anterior (fixture contrastado con HEAD previo). Publicar v2 no migra registros actuales.
  Asociar/actualizar versión requiere sku.update con revisión; no hay detach ni conversión.
- H4.6a: el mismo Inventory Engine valida unidad/atributos de la versión exacta y conserva
  familia en SQL/recibos. Selecciones usan el mismo planner y schemas del negocio. Las APIs
  de creación/edición, adapters de stock e intérprete universal propagan la referencia;
  catálogo de interpretación incluye schemas del mismo snapshot y revisión legible los nombra.
- H4.6a: revisión independiente encontró familia descartada por skuFromAction; corregida,
  con regresiones para ingreso confirmado/resuelto y binding. La versión declarada debe
  coincidir con la fijada en SKU al consumir/ingresar: cambiarla exige edición explícita.
- H4.6a verificado: 279 checks PG/HTTP, 116 pruebas puras, 50 regresiones del motor y build
  aprobados. Incluye concurrencia/versiones, rollback de recibos y metadatos corruptos,
  schema tenant ajeno, upgrade explícito, replay tras cambios y selección congelada.
  Código guardado por el usuario en 0f084ec; no se reemplazó su commit. UI configurable
  aún pendiente en b. Proveedores reales y despliegue siguen sin verificar.

- H4.6b1 (2026-10-18): panel Familias y atributos publica versiones inmutables y crea SKU
  desde el esquema elegido. Revisión y consentimiento separados para publicar/crear;
  tipos, requeridos, estados, unidades y enumeraciones configurables, sin categorías fijas.
  Referencia exacta de familia/versión conservada; publicar una versión no migra SKU.
- H4.6b1: borrador/intento/éxito persistidos por tenant/actor antes del envío. Doble lock,
  reintentos inciertos con mismo ID/cuerpo, consentimiento nuevo tras recuperación;
  rechazo definitivo exige leer datos actuales antes de preparar otro ID. Éxito con fallo
  de refresco reintenta solo lecturas. Stock/precio enteros, cero/false y unidad desconocida
  conservados; nombres accesibles, protección de callbacks tardíos y claves duplicadas.
- H4.6b1 verificado: build y Edge product-family-ui aprobados. Incluye nueva versión
  concurrente durante retry de SKU v1, 409/publicación con nueva revisión y publicación
  confirmada con fallo de lectura. Asignación/edición de SKU existente sigue en b2.
  Sin despliegue ni proveedores reales. Configuración local comprobada solo por presencia:
  no hay claves Gemini/Groq/Meta ni conexión PostgreSQL remota en este entorno.

- H4.5d1 (2026-10-18): WhatsApp acepta REVISAR OPERACION <instrucción>, RESPONDER
  OPERACION <código> <corrección>, CONFIRMAR OPERACION <código> y CANCELAR OPERACION
  <código>. Comparte intérprete, universal_drafts, revisión y ejecutor del panel; el código
  identifica la versión vigente dentro del mismo tenant/actor. Prefijo malformado no pasa
  al parser anterior. No se crean escritores ni resoluciones por nombre durante ejecución.
- H4.5d1: universal_meta_commands congela resultado por mensaje/actor/texto. Replay precede
  catálogo/proveedor también en webhook (catálogo legacy ahora perezoso). LLM fuera de TX;
  lock raíz antes del borrador/dominio, CAS compartido, SAVEPOINT revierte efectos ante
  rechazo de negocio antes de guardar respuesta terminal. SQL/outbox fallido revierte todo.
  Namespace universal-meta: reservado frente a APIs públicas de borradores.
- H4.5d1: revisión completa hasta 3500 caracteres; exceso rechaza sin guardar borrador
  parcial. Recibos muestran hechos persistidos y resumen exacto si exceden el límite;
  corrección conserva ítems, cero/false/unidades. Respuestas tardías/código anterior o
  ambiguo no confirman otra revisión. RLS y revocaciones incluyen tabla nueva.
- H4.5d1 verificado: 294 checks PG/HTTP, 124 pruebas puras y 50 regresiones del motor
  aprobados. Incluye webhook firmado real con proveedores ausentes, texto/audio antes
  de catálogo, confirmación mixta concurrente, replay tras borrar catálogo, rollback de
  comandos/outbox, rechazo inmutable tras reposición, expiry/cancel y límites de revisión.
  Revisión independiente corrigió catálogo anticipado; se mantiene la decisión H4.5b2:
  stock.withdraw directo público prohibido, solo derivado internamente de pedidos.
- H4.5d1 límites: entrada universal explícita; mensajes ordinarios y consultas conservan
  consumidores anteriores durante migración. No simula sustitución total ni calidad LLM
  real. No se configuró ni desplegó Meta/PG remoto. River mantiene dos fallos históricos
  de representación ya registrados; no se declara toda la suite histórica en verde.

- H4.6b2 (2026-10-18): Familia de SKU existente selecciona ID explícito y versión exacta,
  revisa antes/después y envía solo familia/atributos a PUT existente con motivo, revisión
  y fingerprint congelados. Unidad base debe coincidir; cambios de tipo/unidad del atributo
  requieren otro valor explícito. Adicionales se conservan por defecto; schema cerrado
  exige quitar cada extra explícitamente. Cero/false/estados/unidades se preservan.
- H4.6b2: persistencia de intento/snapshot por tenant/actor antes de HTTP; retry incierto
  mismo DTO/ID incluso tras recarga. 409/rechazo exige releer y consentir antes de ID nuevo;
  se puede descartar explícitamente solo un intento definitivo. Éxito durable permite
  preparar otro cambio; refresco fallido reintenta lecturas, sin nueva escritura.
- H4.6b2: revisión encontró metadata de presentación distinta del recibo crudo, texto libre
  canonizado por backend y campos extra en adjustment recuperado. Corregidos: no se usa
  presentación como oráculo de metadata, texto se canoniza antes de revisión/envío y DTO
  cerrado rechaza campos ocultos. La comparación del resultado valida familia/atributos,
  stock/precio/unidad/nombre/revisión exactos; foco/Escape y callbacks de otro scope protegidos.
- H4.6b2 verificado: build y Edge product-family-assignment-ui, 8 escenarios aprobados.
  Incluye dos cambios sucesivos, retry/recarga, conflicto/relectura, éxito/lectura fallida,
  extra cerrado con eliminación explícita, unidad incompatible, cambio tipo/unidad sin
  arrastre silencioso y almacenamiento adulterado bloqueado. APIs simuladas; contratos
  PG/HTTP de edición/familias siguen cubiertos en los 294 checks ya aprobados, sin cambio SQL.

- H5a preparación (2026-10-18): corpus universal sintético de 7 casos con oráculo semántico
  ordenado: convertidores de dirección inversa, ambigüedad, ingreso/cuenta, pedido, familia
  con cero/false, precio cero y referencia inventada. Conserva multiplicidad/IDs/unidades/
  precios/atributos; motivos permiten conceptos equivalentes. No confunde unavailable con
  una abstención correcta y respeta prohibición de stock.withdraw público.
- H5a: `npm run test:universal-evaluation` verifica el evaluador con proveedor simulado
  y errores intencionales (swap de ID, cantidad positiva incorrecta, cero/false, duplicación,
  orden y fallo del proveedor). `npm run eval:universal:live` usa el proveedor real, registra
  kind/reason, exactitud, latencia, traza y usage reportados, sin inventar costos. Solo texto
  sintético; no abre PostgreSQL ni envía WhatsApp. Reporte generado excluido de Git.
- H5a verificado: self-test aprobado, importación del comparador sin ejecutar CLI y guard
  --live sin credenciales sale 2 sin reporte ni llamada. Modos live/simulado excluyentes.
  NO se ejecutó evaluación real ni se considera H5 terminado. Usuario confirmó entorno
  externo aún sin configurar; credenciales, backup productivo, deploy y piloto pendientes.

- Cierre de consultas (2026-10-18): corregida duplicación de tipo en consulta agrupada
  (Camiseta Camisetas River). Se excluyen del modelo únicamente tokens singular/plural
  del tipo ya mostrado; no se agrega una regla de River/indumentaria ni se altera selección,
  identidad almacenada o escritores. Una consulta genérica tampoco restaura el año/modelo
  que solo propuso el parser. Regresión adicional con motores verifica catálogo sin mutar.
- Cierre verificado: test:river-stock-query, voice-catalog-grounding, 124 pruebas puras,
  50 regresiones del motor y nueva ejecución completa de 294 checks PG/HTTP aprobados.
  Los fallos de River mencionados en registros históricos anteriores ya no están pendientes.
  Reingeniería global aún parcial: entrada ordinaria/consultas universales, migración final
  de consumidores y retirada segura de intérpretes compatibles siguen en H4.5d2; evaluación
  real, backup/restauración remotos, despliegue y piloto en H5 requieren entorno configurado.

## Continuación sin repetir investigación

- Rama: `codex/architecture-c-foundation`. H0 `aa0cebe`, H1 `88400cd`, H2 `fdb03ed`,
  H3.1 `f56b500`, H3.2 `b3e031f`; consultar `git log` para checkpoints siguientes.
- H4.0 `aa64aba`; H4.1 `c484e1c`; H4.2a `27824d5`; H4.3 `ef2d58c`.
- H4.4a `844b29b`; H4.4b `bf812ee` (incluye checkpoint parcial `600373f`); H4.4c `ba251e6`.
- H4.4d `cf25ea2`; H4.4e0 `2fd5c3e`; lectura consistente `8581240`; e1a `f34ea14`; e1b `848632c`; e1c `ffa7809`; H4.5a `bed1336`; H4.2b1 `e22a459` (usuario), cierre documental: git log.
  No volver a diseñar la política de aprovisionamiento/conciliación.
- Checks base: `npm run test:inventory`, `npm run test:voice-stock-batches`,
  `npm run test:voice-stock-postgres`; este último crea y elimina PostgreSQL temporal.
- Frontend: `npm run test:inventory-ui` y `npm run test:panel-draft-recovery`.
- Ventas/ajustes/conjuntos: `npm run test:sales-ui`, `npm run test:inventory-adjustments-ui`
  y `npm run test:inventory-selection-ui`.
- Bajas: `npm run test:inventory-deactivation-ui`; incluido en test:inventory y PG/HTTP.
  Edge local; APIs/proveedores simulados. Ninguna de estas pruebas valida IA real.
- Altas: `npm run test:inventory-create-ui`; contrato y rollback incluidos en suites pura/PG.
- Familias/altas configurables: `npm run test:product-family-ui` (Edge con APIs simuladas).
- Familia/atributos de SKU existente: `npm run test:product-family-assignment-ui`.
- Evaluador universal: `npm run test:universal-evaluation`; calidad real requiere
  `npm run eval:universal:live` con claves configuradas (sin claves: exit 2, sin reporte).
- Consultas agrupadas/regresión histórica: `npm run test:river-stock-query`.
- Pedidos: `npm run test:order-ui`; transacciones/HTTP/Meta en test:voice-stock-postgres.
- Ajustes de conjunto: `npm run test:stock-set-adjustment-ui`; usa preview/confirm compartidos.
- Metadatos: `npm run test:party-create-ui`, `npm run test:party-edit-ui` y
  `npm run test:party-delete-merge-ui`; PG/HTTP incluidos en suite compartida.
- Cuentas: `npm run test:client-account-ui`; contratos/dominio en test:inventory y PG/HTTP/Meta
  en test:voice-stock-postgres. Edge usa API simulada, no valida proveedores reales.
- Producción: falta verificar configuración privada, backup/restauración recuperable,
  ejecutar migración controlada, comprobar SHA/readiness y piloto aislado. No desplegado.

### H4.5d2a y d2b — consultas y entrada ordinaria del panel (2026-10-18)

- Contrato de consulta separado, cerrado y autorizado para inventario, pedidos y cuentas.
  El modelo selecciona IDs ofrecidos; el backend devuelve hechos de un snapshot RR con
  `observedAt`. Selección vacía no se amplía; cantidades se agrupan por unidad. Consultas
  respondidas quedan congeladas, no admiten confirmación/corrección como mutación y su
  recuperación revalida permisos. WhatsApp conserva límite de respuesta sin truncar hechos.
- El compositor principal del panel usa borradores universales para texto y transcripción.
  Texto durable por negocio/actor antes del envío; revisión existente no se sobrescribe,
  reintentos conservan IDs y los borradores legacy guardados mantienen su recuperación.
  Una consulta muestra la respuesta sin botones de confirmación ni efectos de inventario.
- Verificado: 303 checks PostgreSQL/HTTP, 139 pruebas puras, build y Edge universal-chat-ui,
  universal-draft-ui y panel-draft-recovery aprobados. Incluye snapshot concurrente, replay
  tras cambios del catálogo, aislamiento, respuesta extensa y rollback de consulta Meta.
- Pendiente inmediato H4.5d2c: mensajes ordinarios de WhatsApp al mismo flujo universal,
  conservando replay y recuperación de conversaciones antiguas; permitir conjuntos/bajas
  solamente mediante revisión completa persistida y confirmación verificable. Después,
  retirar creación de operaciones por consumidores legacy y completar corpus universal.
- No se validaron proveedores externos ni despliegue. El usuario confirmó que todavía
  no están configurados. H5 mantiene evaluación real, backup/restauración remotos y piloto.

### H4.5d2c — WhatsApp ordinario y conjuntos revisados (2026-10-19)

- Texto/audio transcrito nuevo usa el mismo intérprete, snapshot, revisión y ejecutor del
  panel. Eliminado del webhook el ejecutor posterior de acciones del parser anterior.
  Fallo del proveedor es terminal para ese mensaje y no habilita fallback ni escrituras.
- Recuperación previa al proveedor: claim liga mensaje a negocio/remitente, outbox y
  recibo ya comprometidos se devuelven sin reinterpretar, también antes de meta_events.
  Lotes antiguos solo se reanudan; un mensaje nuevo no crea otro lote legacy. Ready se
  finaliza antes de continuar; preguntas cerradas y comandos BAJA/CAMBIO/AJUSTE conservados.
- Borrador universal permite bajas y cambios/ajustes multisku solo con capacidad interna
  y namespace reservado draft-operation. APIs públicas conservan selección revisada
  obligatoria. Revisión backend debe cubrir exactamente todos los ítems en orden, tanto
  al persistir como al confirmar. Miembros, versiones y fingerprints quedan congelados.
- Verificado: 319 checks PostgreSQL/HTTP, 141 pruebas puras y build aprobados. Conjuntos
  concurrentes aplican una vez; stock reservado y miembro obsoleto rechazan todo; fallo SQL
  final revierte efectos/recibos; altas posteriores no amplían el conjunto. HTTP firmado
  cubre entrada nueva, consultas congeladas, confirmación y rechazos sin claves externas.
- Corpus sintético ampliado de 7 a 10 casos: inventario con unidades distintas/cero/false,
  pedidos pendientes/todos y saldo cero. Oráculo compara consultas y hechos completos;
  self-test rechaza cambios de cantidades/unidades, ampliación vacía e inyección de acciones.
  Esto valida el evaluador, no calidad de un proveedor real.
- Próximo paso exacto: H4.5e indicado al inicio. No eliminar compatibilidad transaccional
  necesaria para borradores históricos ni declarar H5 realizado sin entorno externo.

### H4.5e — retiro del parser duplicado y audio privado (2026-10-19)

- Eliminado voiceParserService.ts y método de parsing del navegador. /api/voice/parse
  autenticado devuelve 410 sin catálogo, proveedor ni propuesta. Las entradas principales
  ya usan interpretación/revisión universal. Se conservan únicamente adapters del mismo
  núcleo para formularios tipados y recuperación de propuestas/lotes existentes.
- Panel envía bytes a /api/voice/transcribe con JWT; backend y Meta comparten transcripción.
  Credenciales VOICE_TRANSCRIPTION_API_KEY/GROQ_API_KEY privadas; sin claves/configuración
  del proveedor en el frontend. MIME permitido, 12 MiB, texto máximo 12000, timeout y
  errores sanitizados; audio no se interpreta ni ejecuta en esta frontera.
- Descarga Meta limitada incluso sin Content-Length; transcripción guardada antes de la
  interpretación y reutilizada al reintentar. No se persiste audio en almacenamiento web.
  apiClient conserva Authorization al enviar un Content-Type binario personalizado.
- Revisión independiente encontró recuperación fallida si el cuerpo WhatsApp tenía espacios
  exteriores: extractMetaMessages los quitaba y el replay comparaba el cuerpo crudo.
  Corregido con la misma normalización y regresión en inventario/cuenta/pedido; texto
  distinto sigue rechazado. Sin otros hallazgos concretos en la revisión enfocada.
- Cierre verificado: 321 checks PostgreSQL/HTTP, 151 pruebas puras, 50 regresiones del
  motor, build, evaluador sintético de 10 casos y Edge universal-chat-ui (incluye audio),
  universal-draft-ui y panel-draft-recovery aprobados. Bundle sin endpoints/claves de
  proveedores. HTTP cubre 401/400/413/415/503 y parser retirado, sin efectos de inventario.
- Implementación principal integrada y recuperable. H5 NO está completado: faltan calidad
  real LLM/transcripción, Meta real, backup/restauración remota, despliegue y piloto. No se
  atribuyen estas validaciones a mocks. El retiro definitivo de compatibilidad histórica
  se hará después de validar el piloto y agotar los borradores activos, sin borrar recibos.

### H5 inicial — evaluación real y conexiones (2026-10-19)

- .env.local configurado por el usuario; nunca se copiaron secretos al repositorio/reporte.
  El evaluador ahora usa la misma precedencia local que el backend (override:true) para no
  usar claves viejas heredadas del shell. Reporta preguntas de aclaración en casos sintéticos.
- HTTPS inicial rechazado por UNABLE_TO_VERIFY_LEAF_SIGNATURE en Node. Resuelto usando
  `node --use-system-ca scripts/evaluate-universal-corpus.js --live`, con certificados de
  Windows y verificación TLS activa. No se desactivó TLS ni se cambiaron claves del usuario.
- Primer corpus real: 7/10. Hallazgos: salePrice copiado sin pedirlo; alta con familia con
  campos de sku.create mezclados en stock.receive; consultas de estados solapados mal
  interpretadas. Se aclararon contratos generales en el prompt: precio declarado, campos
  cerrados por tipo, atributos tipados con cero/false y alcance/estado por cada consulta.
  Corpus y oráculo permanecieron intactos. Iteración intermedia 8/10; casos dirigidos y
  evaluación completa final 10/10 con Gemini gemini-3.5-flash-lite (sin fallback Groq).
- Validación final REAL: 10 casos sintéticos, todos aprobados; latencia observada 795-2795 ms
  por caso en esa ejecución. Reporte local ignorado scripts/test-results-universal-live.json.
  Es una muestra acotada; no valida aún calidad en piloto ni conversaciones reales de clientes.
- Meta REAL: HTTP 200 al leer número por ID; ID coincide y hay número/nombre verificado en
  respuesta. No se enviaron mensajes. PostgreSQL REAL: conexión y transacción READ ONLY,
  versión 17.6; 20/21 tablas esperadas presentes, RLS activo en las presentes. Falta
  universal_meta_commands y CHECK de universal_drafts todavía excluye answered.
- Usuario confirmó datos reales: no se ejecutó migrateDatabase, DDL ni mutaciones sobre
  esa base. Próxima migración requiere backup restaurado/verificado en otra base. pg_dump
  y pg_restore no están disponibles en PATH; no sustituir respaldo por un export incompleto.
- Audio real pendiente: GROQ_API_KEY y VOICE_TRANSCRIPTION_API_KEY siguen vacíos. Meta
  lectura y Gemini no sustituyen transcripción, webhook entrante, login y piloto completos.
- Regresiones tras cambios: 151 pruebas puras, evaluador simulado y 321 checks PostgreSQL/
  HTTP en base temporal aislada aprobados. No se usó la base real para esas escrituras.

### H5b — migración remota autorizada sin backup (2026-10-19)

- El usuario dispensó explícitamente el backup: «no pasa nada con el backup. no es
  necesario». Esa instrucción reemplaza el requisito operativo anterior de esta sesión.
  No se creó backup ni se afirma restauración verificada; no volver a pedir lo dispensado.
- Agregados inspector y migrador acotados: server/universalSchemaMigration.js y
  scripts/migrate-universal-conversation.js. --check predeterminado solo lectura;
  --apply usa transacción, timeout/bloqueo acotados, SQL existente de borradores y Meta,
  RLS/revocación a PUBLIC/anon/authenticated y verificación posterior antes de commit.
- No se ejecutó el bootstrap global ni la normalización de owners. Huellas y cantidades
  de tablas de negocio, recibos y tablas universales existentes comparadas dentro de la
  transacción: preservadas. Hashes, datos reales y credenciales no se imprimen ni guardan.
- 323 checks PG/HTTP en base temporal aprobados. Pruebas nuevas simulan esquema antiguo,
  permisos API indebidos, borrador existente, answered/comandos válidos, repetición segura
  y fallo inyectado después de DDL que revierte tabla, CHECK y permisos al estado anterior.
- Aplicación REAL --apply aprobada: creada universal_meta_commands, CHECK actualizado
  para answered, RLS y permisos completos. --check en conexión nueva: ready=true,
  missingTables=[], answeredSupported=true, rlsEnabled=true, apiRolesRevoked=true.
- Smoke REAL combinado: Gemini con catálogo sintético público; borrador answered, comando,
  replay idempotente y respuesta outbox coincidente en PostgreSQL remoto. Transacción
  revertida al final; comprobado cero filas de prueba restantes y cero mensajes enviados.
- Comandos recuperables: npm run db:check:universal y npm run db:migrate:universal. No
  repetir bootstrap ni migrar otra base por inferencia. Pendiente H5: audio con clave,
  entrada/salida Meta y login desde despliegue, SHA/readiness y piloto completo.
