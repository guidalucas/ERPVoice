# FullMatch Studio: evaluación contra el plan original

Fecha: 21/10/2026. Código revisado: `c18838c`, rama local `codex/studio-deploy-access`.

**Actualización posterior:** se implementaron el alta autoservicio y los cierres de código descritos en [SELF_SERVICE_IMPLEMENTATION.md](SELF_SERVICE_IMPLEMENTATION.md). Este informe conserva el diagnóstico anterior; F04/F05 y la aceptación en dispositivos/producción continúan pendientes. No interpretar sus descripciones de faltantes de código como el estado posterior a esa implementación.

## Dictamen

Hay una base funcional amplia: fichas, fotos, historias individuales y por lotes, catálogo y consulta agrupada. No corresponde declarar cerrado el plan original de Etapas 0 y 1: quedan obligaciones monetarias, flujos de interfaz y aceptación productiva pendientes. El estado histórico `COMPLETED` describe la entrega local con fixtures; no demuestra estos criterios completos y su afirmación de que no quedan tareas independientes es demasiado amplia.

El siguiente hito debe ser cerrar Etapa 0 y el piloto de Etapa 1, conservando lo ya construido en Etapas 2 y 3. Pagos, envíos y publicación Meta no tienen prioridad sobre ese cierre.

## Fuentes y límites de esta revisión

- Contrato principal: [plan técnico de Etapas 0 y 1](../../PLAN_TECNICO_FULLMATCH_STUDIO_ETAPAS_0_1.md), especialmente §§0.3, 13, 16 y 17 dentro de sus secciones 5, 13, 16 y 17.
- Diseño: [diseño funcional](FULLMATCH_STUDIO_DISENO_FUNCIONAL.md); se contrastó también con el archivo original aportado en Documents.
- Alcance posterior: [encargo de implementación](IMPLEMENTATION_BRIEF.md) y contratos de [Etapa 2](STAGE_2_CONTRACT.md), [Etapa 3](STAGE_3_CONTRACT.md) y [Etapa 4](STAGE_4_CONTRACT.md).
- Evidencia de uso aportada en este chat: ingreso a Studio, SKU pendientes, foto cargada y bloqueos de identidad/dinero; consulta SQL que mostró 50 variantes con `XXX`. Moneda ARS y precios en pesos enteros fueron confirmados por el propietario.
- La corrección de esas 50 variantes quedó preparada. No hay en esta revisión confirmación de que el usuario la haya ejecutado ni de una publicación pública real completada.
- No se modificó ni inspeccionó de nuevo la base productiva durante esta evaluación. La inspección remota anterior falló por verificación TLS. No se debe presentar el reporte como una certificación de producción.
- Los 383 controles PostgreSQL, 165 pruebas de inventario, 26 de comercio y 17 recorridos de navegador pertenecen a la aceptación local documentada. Los cuatro recorridos de despliegue y doce controles SQL se ejecutaron después, en esta conversación, con datos de prueba. Esta evaluación no vuelve a correr esas suites.

## Estado por etapa

- **Etapa 0: parcial.** Están implementadas fundaciones, aislamiento, política monetaria, migraciones e inspecciones. Falta cerrar prevención de nuevas monedas desconocidas, el método de corrección exigido y las verificaciones reales de recuperación/datos piloto.
- **Etapa 1: funcional pero parcial.** Hay fichas, fotos, historias y recuperación. Faltan partes explícitas del recorrido desde Pendientes, mensajes accionables, actualización de datos y cierre del piloto con casos reales.
- **Etapa 2: implementada y probada localmente; aceptación productiva pendiente.** Catálogo SSR, filtros, URLs, fotografías, publicación separada y consulta pública existen. En las capturas del usuario aún no se había superado la preparación de la ficha para publicar.
- **Etapa 3: implementada dentro del contrato local.** Lotes ZIP, reanudación, cinco plantillas, promociones e historial de snapshots/eventos. Publicación Meta está deshabilitada deliberadamente. La biblioteca no hospeda los PNG/JPG finales; esa limitación está documentada.
- **Etapa 4: evolución no transaccional entregada.** Hay carrito de consulta y pase a WhatsApp. Pedidos cobrables, pagos, reservas y logística siguen condicionados a una decisión comercial y autorización separada; no constituyen un incumplimiento del alcance autorizado.

## Hallazgos y criterios de cierre

### F01 · P0 · Moneda en las altas y ediciones del panel — falta original

El plan §0.3 exige que los nuevos formularios envíen moneda explícita desde la política del negocio. El formulario individual y por modelo arma cuerpos con `price` sin `priceCurrency`. El adaptador crea una acción con moneda `XXX` cuando no viene informada. La política ya confirmada puede rechazar esas altas: normalizar las filas viejas no corrige este recorrido.

Evidencia: [formulario](../../src/components/dashboard/ProductsAbmPanel.tsx), [adaptador](../../server/productCreationAdapter.js), [validación monetaria](../../server/inventoryMoneyPolicy.js) y [persistencia](../../server/inventoryPostgres.js).

Cerrar con moneda visible y explícita en la solicitud inicial individual/por modelo, conservada en sus reintentos; ediciones de precio coherentes; errores claros. Probar negocio ARS habilitado, negocio sin política, cuerpo antiguo pendiente y replay histórico sin cambiar su hash ni resultado.

### F02 · P0 · Política monetaria en propuestas por voz — cierre no demostrado

El plan exige congelar la moneda antes de confirmar. El intérprete contempla moneda ISO y pide aclaración, pero no recibe una política de negocio explícita en su proyección de contexto. Los adaptadores legacy todavía contienen defaults `XXX`. El core valida la moneda después del replay, lo cual está bien, pero eso por sí solo no acredita el recorrido completo por voz. No se afirma que toda entrada por voz falle.

Evidencia: [intérprete](../../server/universalIntentInterpreter.js), [adaptador legacy](../../server/stockOperationAdapter.js) y [núcleo transaccional](../../server/inventoryPostgres.js).

Cerrar con pruebas de alta/ingreso y edición por voz en negocio habilitado: moneda tomada de configuración confirmada o aclaración explícita, cuerpo congelado antes de confirmar, rechazo de inconsistencias y replay inmutable. Revisar también voz del panel, WhatsApp y operaciones compuestas.

### F03 · P0 · Corrección XXX mediante SQL directo — desviación del plan

El plan §0.3 exige `sku.update` con IDs, revisiones y motivo a través del núcleo. El generador administrativo preparado en este chat usa `UPDATE products` y registra un recibo `maintenance.currency_confirmed` en `commercial_operations`. Sus pruebas acreditan aislamiento, preservación de importes/saldos, revisión incrementada y repetición; no lo convierten en una operación del núcleo de inventario ni en su recibo normal.

Evidencia: [generador de corrección](../../scripts/generate-commerce-currency-sql.js), [plan, corrección de XXX](../../PLAN_TECNICO_FULLMATCH_STUDIO_ETAPAS_0_1.md) y [ejecutor de inventario](../../server/inventoryPostgres.js).

Cerrar reemplazando el procedimiento recurrente por una selección revisada y operaciones `sku.update`, con autorización, revisión, idempotencia y auditoría del núcleo. Si el SQL ya se aplicó, verificar el estado y documentar el mantenimiento existente: no fabricar recibos retroactivos ni reescribir el historial.

### F04 · P0 · Datos reales y piloto comercial — aceptación pendiente

El plan pedía mapa revisado de camisetas, moneda inequívoca y piloto completo. La evidencia real mostró 50 variantes `XXX`, una ficha sin identidad completa y precio pendiente. Tener el script preparado y suites con fixtures preconfigurados no confirma que el inventario real ya esté normalizado ni que la camiseta haya sido publicada.

Evidencia: capturas del usuario, [reglas de preparación](../../server/commerce/readiness.js), [prueba de navegador](../../scripts/test-commerce-browser.js) y [aceptación histórica](FINAL_ACCEPTANCE.md).

Cerrar con una camiseta real de extremo a extremo: SKU y talles revisados, moneda/precio correctos, foto real, ficha preparada, historia descargada y catálogo accesible sin sesión. Verificar después una venta/reserva real o controlada y su reflejo correcto, sin descontar reservas dos veces.

### F05 · P0 · Backup y restauración comprobada — evidencia pendiente

El plan §0.1 exige restaurar una copia y definir recuperación de fotografías. No encontré un registro ejecutado de restauración real de base ni de recuperación del bucket. Las bases temporales de tests no sustituyen esa prueba. Esta ausencia de evidencia no demuestra que el proveedor carezca de backups.

Evidencia: [plan técnico, protección de la operación](../../PLAN_TECNICO_FULLMATCH_STUDIO_ETAPAS_0_1.md) y [límites de aceptación](FINAL_ACCEPTANCE.md).

Cerrar verificando recurso, retención y permisos; restauración de base en destino aislado y recuperación de objetos/fotos; registro del resultado y procedimiento sin sobrescribir producción activa.

### F06 · P1 · Pendientes debe iniciar el trabajo sobre SKU seleccionados — falta original

El plan §§13.2–13.3 exige Crear ficha o Vincular a existente sobre SKU exactos. Actualmente Pendientes lista variantes y ofrece un botón global que abre un formulario vacío; la creación manda `skuLinks: []`. Luego se debe abrir otra pestaña para volver a localizar y seleccionar los talles. No existe esa acción contextual desde cada selección de pendientes.

Evidencia: `PendingList`, `ProductEditor.save` y `openVariants` en [Studio](../../src/studio/Studio.tsx).

Cerrar con selección de variantes desde Pendientes, creación de borrador con los seleccionados o elección de ficha existente, prellenado revisable de datos conocidos y confirmación explícita. Sugerencias nunca deben asociar por nombre sin revisión. Convertir todos los pendientes en fichas automáticamente o por IA no era una obligación del MVP.

### F07 · P1 · Bloqueos y campos requeridos accionables — falta de experiencia

La interfaz resume `MONEY_UNCONFIRMED` como “Confirmá moneda y escala”, aunque también representa moneda distinta en el SKU o importe inválido. `IDENTITY_INCOMPLETE` no identifica qué campos faltan; solo el título está marcado como requerido en el formulario. La captura del usuario demuestra que guardar una foto y un título no hace evidente cómo completar la preparación.

Evidencia: [readiness](../../server/commerce/readiness.js), [validación de dinero](../../server/inventoryMoneyPolicy.js), `Fields`, `blockerLabels` y `ProductEditor` en [Studio](../../src/studio/Studio.tsx).

Cerrar con causas diferenciadas, campos pendientes identificados, navegación a la sección concreta y mensajes que indiquen qué se corrige en Stocky. Mantener el bloqueo de publicación ante datos inválidos.

### F08 · P1 · Refresco y regreso a Stocky — falta original

El plan §§13.5–13.7 pide actualización al recuperar foco, refresco ligero de disponibilidad de la ficha cada 30 segundos mientras sea visible, refresco manual y enlace Abrir en Stocky. Los componentes inspeccionados cargan al montar y después de acciones; no implementan esos listeners/polling ni el enlace operativo en la ficha. La revalidación de exportación del servidor sí existe y sigue siendo necesaria.

Evidencia: efectos de [Studio](../../src/studio/Studio.tsx) y comprobaciones de [StoryEditor](../../src/studio/StoryEditor.tsx).

Cerrar con consultas comerciales acotadas, sin `/api/state`, sin sobreescribir borradores ni superponer respuestas. Una modificación externa de stock/precio debe verse o advertirse sin obligar a descubrirla al descargar. El enlace debe llevar a una ruta real de Stocky.

### F09 · P1 · Puesta en marcha de otro negocio — mejora operativa / alcance adicional

La habilitación actual se hace con scripts de perfil/política. Eso explica la necesidad de asistencia técnica; no es un alta autoservicio terminada. Sin embargo, el plan original permitía acceso inicial solo al dueño habilitado, preparación externa de moneda y difería SaaS. Un onboarding universal sin SQL no puede presentarse retrospectivamente como obligación completa de ese MVP.

Evidencia: [alcance incluido/diferido del plan](../../PLAN_TECNICO_FULLMATCH_STUDIO_ETAPAS_0_1.md), [configuración actual](../../src/studio/Studio.tsx), [generador de habilitación](../../scripts/generate-commerce-business-sql.js).

Para el objetivo nuevo de atender usuarios desde cero: asistente de negocio/marca/moneda/contacto, política confirmada y activación autorizada desde interfaz; infraestructura y migraciones siguen siendo responsabilidad del operador. Probar dos negocios nuevos y aislamiento. No requiere añadir suscripciones o facturación SaaS para resolver el alta básica.

### F10 · P1 · Piloto, medición y aceptación desde estado vacío — cierre original pendiente

Los recorridos actuales parten de negocio/perfil/política ya preparados o API simulada. Cubren fallos e integridad importantes, pero no acreditan el alta completa que está revelando las fricciones actuales. El objetivo de exportar desde ficha preparada en menos de un minuto y la experiencia de compartir en un teléfono real tampoco tienen medición/aceptación registrada.

Evidencia: [fixture](../../scripts/fullmatch/seedFixture.js), [navegador comercial](../../scripts/test-commerce-browser.js), [despliegue](../../scripts/test-studio-deployment.mjs) y [aceptación](FINAL_ACCEPTANCE.md).

Cerrar con caso piloto reproducible, datos reales revisados, dos dispositivos objetivo y cronometraje desde ficha preparada; pruebas de altas individuales/por modelo/voz con política activa y de correcciones desde Stocky; publicación anónima y cambio posterior de disponibilidad. Diferenciar aceptación del negocio existente de un onboarding nuevo agregado al alcance.

### F11 · P2 · Panel y ayudas del diseño funcional — parcial, no bloqueo central

La lista tiene búsqueda, estado interno y selección para historias. El diseño funcional también proponía contadores útiles, filtros de publicados/sin fotos y búsqueda por dimensiones comerciales; el backend admite más filtros que la interfaz expone. El generador inicia siempre con plantilla Stock disponible, sin la recomendación contextual descrita en el diseño.

Evidencia: [diseño funcional, panel y reglas inteligentes](FULLMATCH_STUDIO_DISENO_FUNCIONAL.md), [lista](../../src/studio/Studio.tsx), [generador](../../src/studio/StoryEditor.tsx) y [consultas](../../server/commerce/productService.js).

Cerrar según prioridad de uso: filtros y contadores veraces; sugerencias basadas en hechos comprobables; conservar parámetros al cambiar diseño. No convertir ejemplos ilustrativos de la maqueta en cantidades reales ni inventar una fecha de ingreso.

## Lo ya construido que debe conservarse

- Un backend/base y un único stock; Studio no hidrata `/api/state`.
- Separación de preparación privada, publicación pública y disponibilidad calculada.
- Vínculos explícitos por propietario/ID y autorización owner-only.
- Fotos privadas, validación/procesamiento, portada/enfoque, intentos recuperables y mantenimiento.
- Cinco plantillas, PNG/JPG 1080×1920, snapshots y revalidación de ofertas.
- Catálogo público SSR y DTO limitado, búsqueda/filtros, consulta agrupada y WhatsApp.
- Lotes secuenciales, ZIP acotado, reanudación y promociones sin cambiar precios de Stocky.
- Build conjunto y enlace desde Stocky agregados después de la primera entrega; pruebas de sesión en escritorio/móvil.

## Diferencias documentadas y funciones posteriores

- Los snapshots se guardan en recibos de `commercial_operations`, no en una tabla independiente. La decisión está registrada; no es un faltante por cambiar un nombre de tabla del diseño.
- La biblioteca conserva snapshots/eventos y reconstruye contenido; no hospeda una colección de PNG/JPG finales. El contrato de Etapa 3 lo declara. Si se necesita un archivo descargable permanente entre dispositivos, acordarlo como ampliación.
- Meta automático, programación real, pagos, pedidos transaccionales, reservas de ecommerce, envíos y sincronización Empretienda continúan como decisiones o integraciones futuras.
- El editor de marca libre, carga de logos por usuario y facturación SaaS no eran requisitos de V1. Sí queda confirmar el preset/logo/fuente reales y dispositivos del piloto.

## Orden recomendado

1. **Cerrar moneda e inventario:** F01–F03; no perpetuar `XXX` ni usar SQL directo como flujo regular. Confirmar el estado de la corrección ya preparada y preservar su historial si fue aplicada.
2. **Completar recorrido comercial:** F06–F08; desde Pendientes hasta preparar/publicar, con causas y correcciones accesibles.
3. **Cerrar operación y aceptación real:** F04, F05 y F10; backup recuperable, camiseta real, exportación y catálogo público, cambio de stock y móvil.
4. **Si se adopta el objetivo de nuevos usuarios:** F09, asistente de activación y moneda sin SQL por usuario.
5. **Pulir productividad y decidir ampliaciones:** F11 y biblioteca de archivos; después evaluar Meta y checkout según necesidad.

## Criterio para volver a declarar el MVP cerrado

El comercio puede cargar una variante nueva por los canales soportados con moneda inequívoca, verla en Pendientes, crear o completar una ficha con sus talles, corregir los bloqueos desde interfaces claras, subir fotos, generar una historia correcta en el tiempo objetivo y publicar un catálogo consultable por clientes. Puede repetir/reanudar sin duplicados, ver cambios de Stocky y recuperar base/fotos. La configuración inicial del operador y las decisiones comerciales deben estar documentadas y verificadas; una lista de tareas marcada como terminada o una suite con fixtures no sustituye esa aceptación.

Esta evaluación agrega documentación. No cambia la aplicación, el checkpoint histórico, variables alojadas ni datos de producción.
