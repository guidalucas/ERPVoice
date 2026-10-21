# IMPLEMENTACIÓN AUTÓNOMA Y CONTINUA — FULLMATCH STUDIO

## 1. Rol y objetivo principal

Actuá como arquitecto de software senior y desarrollador full-stack responsable de implementar FullMatch Studio sobre el repositorio actual de Stocky (ERPVoice).

**ESTÁS AUTORIZADO A COMENZAR LA IMPLEMENTACIÓN REAL. NO QUIERO OTRO PLAN TEÓRICO.**

Tu misión es desarrollar progresivamente todas las etapas del proyecto, integrarlas, probarlas y avanzar de forma autónoma hasta completar los objetivos establecidos.

No te detengas al terminar una etapa. Si finalizás la Etapa 0, comenzá inmediatamente la Etapa 1. Cuando completes la Etapa 1, continuá con la 2, y así sucesivamente.

Trabajá sin solicitar confirmación para cada cambio ordinario de código, prueba, archivo o decisión técnica reversible que esté dentro del alcance aprobado.

El proyecto tiene que poder continuar durante múltiples sesiones y períodos de disponibilidad de Codex, conservando su progreso aunque se interrumpa el contexto o se alcance el límite de uso.

## 2. Documentación obligatoria

Localizá y leé:

- `AUDITORIA_STOCKY_FULLMATCH.md`
- `FULLMATCH_STUDIO_DISENO_FUNCIONAL.md`
- `PLAN_TECNICO_FULLMATCH_STUDIO_ETAPAS_0_1.md`

También inspeccioná el código vigente y las instrucciones `AGENTS.md` que correspondan.

Estos documentos constituyen la referencia principal de arquitectura, funcionalidades, invariantes y criterios de aceptación.

Prioridad ante conflictos:

1. Seguridad, preservación de datos y restricciones explícitas de este encargo.
2. Estado verificado del código actual.
3. Plan técnico aprobado.
4. Diseño funcional.
5. Auditoría histórica como evidencia del estado anterior.

Las diferencias deben documentarse, no resolverse mediante suposiciones peligrosas.

El plan de Etapas 0 y 1 es detallado. Para las Etapas 2 y posteriores, desarrollá especificaciones técnicas incrementales basadas en la arquitectura y en el diseño funcional.

## 3. Implementación progresiva

### ETAPA 0 — Preparación técnica

Implementá las fundaciones necesarias:

- Verificación de entornos y configuración.
- Inspección de SKU y calidad de datos.
- Modelo de identidad comercial.
- Migraciones comerciales incrementales.
- Política monetaria por negocio.
- Frontera entre inventario y dominio comercial.
- Autorización y aislamiento por negocio.
- Preparación de contratos y pruebas.
- Separación controlada del bootstrap SQL cuando corresponda.

No conviertas moneda ni alteres datos reales sin verificar su significado.

Las migraciones deben probarse primero en una base aislada. No ejecutes modificaciones de producción automáticamente.

Si necesitás confirmación de un dato comercial real, continuá desarrollando con fixtures o datos de prueba y registrá el bloqueo de habilitación productiva.

**Al completar los criterios de aceptación de Etapa 0, avanzá directamente a Etapa 1.**

### ETAPA 1 — FullMatch Studio privado

Implementá:

- Aplicación React independiente con entrada propia.
- Autenticación reutilizando el backend actual.
- Listado de productos comerciales.
- SKU pendientes de catalogar.
- Creación y edición de fichas.
- Asociación explícita entre fichas y SKU.
- Administración de fotografías.
- Galería y portada.
- Estados internos de preparación.
- Tres plantillas iniciales de historias.
- Editor con previsualización.
- Exportación PNG/JPG de 1080 × 1920.
- Revalidación de precios y disponibilidad.
- Recuperación ante errores de operaciones comerciales.

Utilizá la identidad visual de FullMatch Casacas:

- Azul marino `#001A4D`.
- Naranja `#FF6A00`.
- Diseño moderno, premium, responsive y fácil de utilizar.

No dupliques el stock ni generes un segundo sistema de inventario.

La primera versión debe permitir elegir una camiseta existente, completar su ficha con fotografías y generar una historia sin volver a escribir precio, nombre o talles.

**Cuando la Etapa 1 esté funcional, probada y sus criterios de aceptación estén cumplidos, continuá automáticamente con la Etapa 2.**

### ETAPA 2 — Catálogo comercial público

Implementá la plataforma pública reutilizando las fichas comerciales de la Etapa 1.

Debe incluir:

- Catálogo accesible sin login.
- Listado de productos.
- Fotografías.
- Talles y versiones.
- Precios y moneda.
- Disponibilidad proveniente de Stocky.
- Buscador y filtros.
- Fichas individuales compartibles.
- URLs estables.
- Contacto comercial por WhatsApp.
- Diseño responsive y SEO básico.
- Estados de publicación independientes del inventario.
- Endpoints públicos con respuestas restringidas a datos comerciales.

No reutilices `/api/state` públicamente ni expongas datos operativos.

No implementes todavía pagos reales si no existe una decisión comercial y técnica validada.

**Al finalizar la Etapa 2, avanzá automáticamente a la 3.**

### ETAPA 3 — Automatización de contenidos

Implementá las funcionalidades compatibles con la arquitectura existente:

- Generación de historias por lotes.
- Selección múltiple de productos.
- Plantillas adicionales.
- Historial o biblioteca de contenidos.
- Novedades y últimas unidades.
- Promociones simples.
- Mejoras en exportación y experiencia móvil.
- Preparación de integración con Meta cuando sea viable.

Evaluá las capacidades oficiales de Instagram antes de implementar publicación automática.

No publiques contenido real, no conectes cuentas externas ni programes publicaciones reales sin autorización explícita del usuario.

Si la integración Meta queda bloqueada por permisos o requisitos externos, completá las funcionalidades locales y continuá con el trabajo independiente.

**Después continuá con la Etapa 4.**

### ETAPA 4 — Evolución comercial

Evaluá la conveniencia de integrar un proveedor de ecommerce o ampliar FullMatch Studio.

Podés desarrollar componentes no transaccionales, prototipos, carrito local y un flujo de pedidos sin pagos reales cuando sean útiles y estén suficientemente especificados.

No habilites cobros, reservas productivas, pasarelas reales ni envíos automáticos sin la correspondiente autorización.

Si una decisión comercial impide completar una funcionalidad, registrala y continuá con las restantes.

El objetivo es entregar la máxima funcionalidad verificable posible, sin incorporar riesgos innecesarios.

---

## 4. Regla fundamental: continuidad automática entre etapas

NO consideres una etapa completada por el simple hecho de haber escrito código.

Al terminar cada hito:

1. Ejecutá las pruebas correspondientes.
2. Revisá regresiones de Stocky.
3. Corregí los errores introducidos.
4. Verificá los criterios de aceptación.
5. Actualizá el estado persistente del proyecto.
6. Registrá los cambios y las decisiones.
7. Continuá con la próxima tarea pendiente.

Cuando todos los criterios de una etapa estén satisfechos, comenzá automáticamente la siguiente sin necesitar un nuevo mensaje mío.

No detengas el desarrollo para redactar un informe extenso si todavía existen tareas implementables.

Los informes deben ser breves y secundarios a la implementación.

## 5. Persistencia de progreso entre sesiones

Desde el comienzo creá y mantené:

`docs/fullmatch/IMPLEMENTATION_STATE.md`

Debe registrar:

- Etapa actual.
- Hito actual.
- Última tarea completada.
- Tareas pendientes.
- Archivos modificados.
- Cambios arquitectónicos importantes.
- Pruebas ejecutadas y sus resultados.
- Problemas detectados.
- Bloqueos externos.
- Próxima acción concreta.
- Último commit local validado, si existe.
- Estado general: `IN_PROGRESS`, `PAUSED_QUOTA`, `BLOCKED`, `COMPLETED`.

También mantené:

`docs/fullmatch/TASKS.md`

Con un checklist granular y actualizado de las tareas de todas las etapas.

Y:

`docs/fullmatch/DECISIONS.md`

Con decisiones técnicas relevantes, sus motivos y alternativas descartadas.

Estos archivos serán el mecanismo principal de recuperación ante pérdida del contexto de conversación.

Actualizalos después de cada tarea significativa y antes de cualquier interrupción controlada.

No guardes secretos ni datos privados en ellos.

## 6. Reanudación después de interrupciones

Al comenzar una nueva sesión:

1. Inspeccioná el estado real del repositorio.
2. Leé `IMPLEMENTATION_STATE.md`, `TASKS.md` y `DECISIONS.md`.
3. Compará el progreso documentado con los archivos y pruebas.
4. Identificá operaciones incompletas.
5. Recuperá el último estado consistente.
6. Continuá desde la primera tarea pendiente verificable.

No vuelvas a realizar toda la auditoría si ya fue completada y el estado no cambió.

No dupliques migraciones, tablas, SKU, imágenes ni operaciones.

No supongas que un paso se completó únicamente porque figura en el documento: comprobalo cuando sea importante.

No descartes trabajo existente ni uses `git reset --hard` para simplificar una recuperación.

## 7. Agotamiento de límites de Codex

Quiero utilizar la disponibilidad incluida en mi plan de Codex sin comprar créditos ni restablecimientos adicionales.

Cuando detectes que el límite de uso impide continuar:

- No trates el límite como un error de programación.
- No cambies de cuenta ni de proveedor para eludirlo.
- No utilices una API de pago como respaldo.
- Conservá todos los archivos y cambios ya realizados.
- Registrá el último estado verificable.
- Indicá cuál es la siguiente tarea.
- Finalizá limpiamente el turno si no es posible continuar.

El estado debe quedar preparado para reanudarse cuando vuelva a haber disponibilidad.

**IMPORTANTE:** sé que una instrucción al modelo no garantiza que el proceso se reactive por sí solo. Necesito una solución de ejecución externa para eso.

## 8. Implementar un mecanismo local de continuidad en Windows

Como utilizo Windows y puedo dejar la computadora encendida, quiero que investigues y prepares un mecanismo local de ejecución continua.

Priorizá Codex CLI con autenticación existente de ChatGPT, sin introducir costos de API.

Verificá la versión instalada y las funciones realmente disponibles antes de elegir los comandos.

Si la CLI es compatible, implementá un script PowerShell, por ejemplo:

`scripts/fullmatch-autocontinue.ps1`

El mecanismo debe:

1. Ejecutar trabajos de Codex utilizando el repositorio actual.
2. Recuperar la sesión correcta mediante su ID persistido.
3. Leer el checkpoint del proyecto antes de reanudar.
4. Permitir que Codex trabaje y termine turnos de forma controlada.
5. Si quedan tareas, iniciar la siguiente continuación.
6. Detectar una limitación de cuota a partir de información confiable.
7. En ese caso, suspender nuevas invocaciones.
8. Reintentar cuando llegue la disponibilidad, respetando los límites oficiales.
9. Si no puede determinar la hora exacta de renovación, utilizar consultas espaciadas, nunca intentos constantes.
10. Continuar con la primera tarea pendiente cuando el servicio vuelva a estar disponible.
11. Terminar automáticamente si todos los criterios están completados.
12. Detenerse si hay un bloqueo que requiera intervención humana.

Requisitos del supervisor:

- Usar solo interfaces y comandos oficiales disponibles.
- No depender de scraping del panel de límites.
- No eludir restricciones de uso.
- No comprar créditos, activar planes ni cambiar cuentas.
- No almacenar credenciales en los logs.
- Guardar logs con rotación y tamaño acotado.
- Evitar sesiones duplicadas mediante exclusión mutua.
- Evitar procesos Codex superpuestos.
- No reintentar indefinidamente errores de autenticación, permisos, tests o configuración.
- No clasificar cualquier error HTTP como cuota agotada.
- Usar permisos limitados al workspace.
- Disponer de un mecanismo claro para detenerse.
- No registrar tareas persistentes del sistema ni modificar el inicio de Windows sin mi autorización.

Validá el supervisor mediante simulaciones de fin de turno, interrupción, límite de uso, error de autenticación y finalización del proyecto. No consumas deliberadamente la cuota para probarlo.

Si el entorno dispone de Goals de Codex, podés aprovecharlos para continuidad entre turnos, pero no los confundas con un mecanismo garantizado de recuperación después de agotarse la cuota.

Si no hay soporte fiable para reanudar automáticamente, documentá la limitación y dejá funcionando al menos una reanudación manual de una sola orden.

No afirmes que el supervisor funciona hasta verificarlo realmente.

**No inicies un segundo Codex desde dentro de una sesión Codex que ya esté implementando el proyecto.** Prepará el supervisor para que pueda iniciarse separadamente de forma segura, y documentá cómo activarlo una sola vez.

## 9. Git y checkpoints

Trabajá sobre una rama dedicada de implementación, preservando cualquier cambio previo del usuario.

Realizá commits locales por hitos funcionales cuando las pruebas correspondientes pasen.

No hagas push, merges a ramas protegidas ni despliegues sin autorización.

Antes de cada cambio importante:

- Revisá el estado de Git.
- Preservá modificaciones ajenas.
- Limitá el alcance.
- Ejecutá pruebas relevantes.

No crees commits que aparenten finalizar funcionalidades incompletas.

Una tarea puede quedar en progreso, pero debe ser recuperable.

## 10. Restricciones de seguridad

No modificar producción automáticamente.

No ejecutar migraciones destructivas.

No normalizar precios reales sin validación.

No borrar datos existentes.

No exponer información interna de Stocky.

No utilizar credenciales en código fuente.

No deshabilitar autenticación ni controles de seguridad para facilitar pruebas.

No alterar los contratos actuales de inventario sin regresiones verificables.

No activar servicios pagos.

No crear publicaciones reales de Instagram sin autorización.

Si una operación requiere consentimiento, acceso externo o confirmación comercial, registrá el bloqueo y avanzá con otra tarea independiente.

## 11. Criterios de calidad

Priorizá:

1. Funcionalidad terminada.
2. Consistencia con Stocky.
3. Seguridad y aislamiento.
4. Tests útiles.
5. Código mantenible.
6. Experiencia de usuario.
7. Simplicidad arquitectónica.

No construyas microservicios, colas, cachés distribuidas o nuevas bases de datos sin una necesidad comprobada.

No confundas avances documentales con funcionalidades implementadas.

No afirmes que un test pasó si no fue ejecutado.

No declares lista una integración que utiliza solamente mocks.

## 12. Instrucción final de ejecución

**COMENZÁ AHORA.**

Primero verificá el repositorio, los documentos y el estado de Git.

Prepará el registro persistente de tareas y el mecanismo de continuidad.

Después iniciá inmediatamente la implementación de Etapa 0.

Trabajá de manera incremental, verificable y autónoma.

Cuando termines una etapa, seguí con la siguiente.

Cuando termine un turno y todavía quede trabajo, continuá mediante el mecanismo disponible.

Cuando se agote la cuota, conservá el estado y dejá que el supervisor externo gestione la espera y la reanudación, si está verificado y activo.

No vuelvas a empezar de cero después de una interrupción.

No te detengas únicamente porque el primer MVP funciona: continuá con las etapas posteriores hasta completar el alcance técnicamente autorizado y verificable.

Considerá el proyecto completo únicamente cuando estén satisfechos los criterios acordados de todas las etapas implementables, las pruebas relevantes y la documentación de operación.

**Tu prioridad es implementar software real, conservar el progreso y avanzar de manera sostenida sin supervisión continua, dentro de los límites técnicos, de uso y seguridad establecidos.**