# Alta autoservicio y cierre de recorridos comerciales

Implementación local del 21/10/2026, sobre `codex/studio-deploy-access`. Incluye el alcance adicional de que el propietario configure su negocio por su cuenta. No incluye despliegue ni modificaciones productivas.

## Recorrido del propietario

1. Iniciar sesión en Stocky mediante WhatsApp y abrir **FullMatch Studio**, o entrar directamente en `/studio.html`.
2. Si falta configurar el negocio, completar nombre comercial, rubro si todavía no se eligió, WhatsApp comercial opcional, moneda ARS/UYU/USD y confirmación de precios en unidades enteras. El ejemplo `65000 = $65.000` debe corresponder a sus datos; el asistente no convierte importes.
3. Activar el espacio comercial. La respuesta perdida se puede reenviar con el mismo cuerpo e identificador. No se requieren scripts por negocio.
4. Si hay inventario anterior con `XXX`, ir a **Configuración → Revisar moneda del inventario anterior**. Seleccionar los SKU cuyos importes ya correspondan a la moneda elegida, revisar la vista previa y confirmar. Las otras monedas/importes inválidos se revisan en Stocky.
5. En **Pendientes**, seleccionar hasta 100 talles de una misma camiseta y elegir **Crear ficha y vincular** o **Vincular a una ficha existente**. El título sugerido y los vínculos siguen siendo revisables; no se deduce la identidad comercial por similitud del nombre.
6. Completar los campos que indique la ficha, cargar fotos y preparar. Generar la historia. Para atender clientes, configurar por separado el identificador del catálogo, habilitarlo y publicar cada ficha.

El contacto es opcional para activar el espacio privado. Para que el catálogo pueda recibir consultas se necesita un WhatsApp de ventas válido. El preset comercial continúa siendo FullMatch; el editor libre de marca y los pagos no forman parte de esta ampliación.

## Contratos incorporados

- `GET /api/commerce/v1/setup`: configuración propia del propietario, accesible antes de habilitar el dominio. Devuelve perfil, política monetaria, `enabled` y `needsSetup`.
- `POST /api/commerce/v1/setup`: activación/configuración inicial con `operationId`, `expectedProfileRevision`, `expectedPolicyRevision`, `brandName`, `salesWhatsapp`, `currency` y `confirmedMajorInteger:true`. Las revisiones iniciales son cero cuando el recurso no existe.
- `GET /api/commerce/v1/money-policy`: proyección mínima de la política del negocio autenticado, también para miembros que cargan inventario.
- `GET /api/commerce/v1/money-review?cursor=...`: hasta 100 variantes propias con moneda distinta de la política, con importes visibles e indicación de cuáles admiten confirmar `XXX`.
- La revisión utiliza los endpoints existentes `POST /api/inventory/selections` y `POST /api/inventory/selections/:id/confirm`, con `sku.update`, moneda explícita, motivo, IDs y revisiones congeladas por el núcleo. No utiliza SQL de mantenimiento ni recibos comerciales como sustituto de la auditoría de inventario.
- `GET /api/commerce/v1/products/:id/availability`: lectura acotada para mantener disponibilidad/precios/bloqueos al recuperar foco y cada 30 segundos con la ficha visible. No incluye el borrador de texto ni hidrata `/api/state`.
- La lista admite filtros `photos=missing|ready` y `publication=hidden|published`, junto con las dimensiones ya disponibles. Los contadores corresponden a consultas del negocio, no a ejemplos de la maqueta.

La ficha permite actualizar manualmente y abrir una ruta real de inventario (`/?section=productos`). La actualización de stock no pisa campos sin guardar. Si cambió la revisión comercial en otra pantalla, bloquea la edición/publicación/exportación hasta revisar los datos actuales. Los bloqueos de preparación identifican los campos de identidad pendientes y distinguen política ausente, moneda distinta e importe inválido.

## Persistencia y límites de autoridad

No se agregaron tablas ni migraciones. Se usan `commerce_profiles`, `inventory_money_policies` y `commercial_operations` para la activación, y las selecciones/operaciones existentes para corregir moneda.

La activación autentica al propietario real, vuelve a comprobar su pertenencia, serializa intentos y verifica revisiones. La transacción guarda perfil, política y recibo juntos. No permite autoactivar un perfil deshabilitado por el operador ni reemplazar una moneda ya confirmada. Los miembros no pueden configurar un negocio ni seleccionar el propietario desde el cuerpo HTTP.

Las altas individuales y por modelo consultan la configuración y envían moneda explícita en el primer cuerpo. El cuerpo queda congelado en sus reintentos, incluso si cambia la configuración entre ellos. Las ediciones de precio conservan también su cuerpo pendiente. El núcleo consulta la política después de buscar el recibo histórico; el replay no cambia por una activación posterior. La primera confirmación monetaria y los efectos nuevos de inventario usan el mismo orden de bloqueo de productos.

Las propuestas por voz del flujo universal reciben la política confirmada y congelan moneda antes de persistir la propuesta. Ante una moneda incompatible se pide aclaración; no se convierten importes. Un alta sin precio comienza en cero con la moneda confirmada; una venta sin precio explícito no inventa `salePrice`. Panel y WhatsApp comparten ese límite. Las pruebas nuevas usan respuestas del intérprete controladas, no certifican un proveedor LLM productivo.

Los generadores SQL anteriores permanecen como antecedentes de mantenimiento. Si ya se ejecutó una corrección administrativa, se conserva su recibo; no se reconstruye un historial ficticio.

## Validación local

- Build conjunto de Stocky y Studio con TypeScript y Vite.
- 165 pruebas de inventario y 383 verificaciones PostgreSQL existentes.
- 17 recorridos comerciales existentes con fotos/exportaciones reales de fixture, catálogo anónimo, lotes y consultas.
- 8 recorridos nuevos de autoservicio en PostgreSQL aislado y HTTP/UI reales: miembros/autoridad, configuración móvil, respuesta perdida, dos negocios con monedas distintas, activaciones concurrentes, perfil deshabilitado, corrección `XXX` por núcleo, replay histórico, altas individual/modelo, creación y vínculo desde Pendientes, foto/historia/catálogo, filtros y refresco sin pérdida del borrador.
- Pruebas de creación del panel con moneda explícita y reintentos conservados tras activación/cambio de configuración.
- 42 pruebas focalizadas de dominio/intérprete, incluidas dos nuevas de moneda en propuestas de panel/WhatsApp.
- Cuatro verificaciones de despliegue local: propietario/miembro en escritorio/móvil.

El recorrido automatizado desde ficha preparada hasta PNG tardó menos de un segundo en el fixture local observado. Es una medición de laboratorio con viewport móvil; no garantiza esa latencia en producción ni acredita compartir nativo en un teléfono.

Comandos nuevos: `npm run test:commerce:onboarding` y `npm run test:commerce:money-voice`. Los tests crean bases/usuarios de prueba descartables, no usan cuentas ni datos productivos. Las capturas quedan en `.fullmatch-runtime/browser/`, fuera de Git.

## Qué queda para aceptar en producción

Desplegar frontend y backend actualizados. No se agregaron variables de Vercel/Render: se reutilizan base, autenticación, orígenes y Storage privado documentados en [DEPLOYMENT.md](DEPLOYMENT.md). Las tres migraciones comerciales deben existir una vez por instalación; el onboarding no crea infraestructura ni buckets.

Siguen pendientes la camiseta real con el propietario, la comprobación del estado de sus variantes históricas, el acceso al catálogo real y compartir desde los dispositivos objetivo. También falta ejecutar y registrar una restauración de base **y fotografías** en recursos aislados; el [procedimiento de recuperación](RECOVERY_RUNBOOK.md) deja los pasos y el registro exigido. Este trabajo no ejecuta esos cambios productivos ni declara cerrada esa aceptación externa.
