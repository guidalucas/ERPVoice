# FullMatch Studio — aceptación del alcance local autorizado

Resultado: implementadas y verificadas localmente las etapas 0–4 dentro del alcance autorizado. No representa una habilitación productiva ni un ecommerce transaccional.

## Funcionalidad entregada

- Fundaciones: inspección sin bootstrap, migraciones explícitas/repetibles, identidad comercial, política monetaria confirmada por negocio, autorización/aislamiento y recibos deterministas.
- Studio privado: entrada React independiente, sesión existente, fichas/pendientes/vínculos revisados, borradores recuperables, galería/portada/enfoque y estados de preparación.
- Fotografías: bytes reales validados, orientación/EXIF, derivadas privadas, intentos/leases, reintentos, control de integridad y mantenimiento con inspección/purga explícita y período de gracia.
- Historias: cinco plantillas, PNG/JPG 1080x1920, snapshot inmutable, stock/precios/moneda vigentes, última unidad veraz y promociones exactas con vigencia.
- Catálogo: publicación separada de preparación/inventario, HTML responsive/SEO, búsqueda/filtros, URLs estables, contacto configurado y contrato público con allowlist. Ocultar/deshabilitar revoca accesos posteriores también a fotos.
- Automatización local: selección múltiple, un Canvas secuencial, ZIP acotado, mismos UUID/snapshots al reanudar y biblioteca que distingue preparación de solicitudes de descarga.
- Evolución comercial: carrito por catálogo, presupuesto orientativo de solo lectura y revisión ante cambios antes del pase explícito a WhatsApp. No crea pedidos, cobros, recibos ni reservas.
- Continuidad: supervisor externo Windows, sesión CLI exacta, bloqueo/heartbeat/STOP, backoff y simulaciones sin iniciar otro Codex en este chat.

## Evidencia final ejecutada

- `npm run test:inventory`: **165/165**.
- `npm run test:commerce`: **26/26** (dominio, imágenes reales, promociones y continuidad simulada).
- `npm run test:voice-stock-postgres`: **383 verificaciones** con PostgreSQL descartable, autenticación HTTP real y claves JWT aleatorias del fixture, independientes de secretos configurados.
- `npm run test:commerce:browser`: **17 recorridos** en Edge, escritorio y viewport móvil. Incluye pérdida de respuesta, nueva ficha/talle/foto/historia, PNG/JPG reales, catálogo anónimo/SEO/revocación, promoción, ZIP descomprimido y medido, reanudación, cambio de stock, biblioteca y carrito con cambio de precio/disponibilidad.
- `npm run build:studio` y `npm run build`: **correctos**, con Vite 6.4.4 y TypeScript.
- `git diff --check`: **correcto**.

Las capturas se inspeccionaron visualmente y están en `.fullmatch-runtime/browser/`, junto con archivos PNG/JPG/ZIP de DEMO. Los logs de prueba están en `.fullmatch-runtime/`; ese directorio no entra en Git. Los procesos/base/archivos temporales se cierran y eliminan solamente dentro de sus rutas verificadas. El pase a WhatsApp fue interceptado en el navegador; no se contactó ni se envió un mensaje a ninguna cuenta real.

El código comercial/catálogo no escribe saldos/precios de inventario ni hidrata `/api/state`. Los tests comparan filas/huellas y verifican que migraciones, preparación/exportación y consulta no generen movimientos, pedidos o reservas. Las tres migraciones se aplicaron únicamente en bases aisladas; el servidor no las ejecuta desde una petición HTTP productiva.

## Dependencias y límites verificados

La revisión detectó y corrigió dependencias del runtime: Sharp 0.35.5, Express compatible y sus dependencias HTTP. Se verifica firma JPEG/PNG/WebP antes de invocar loaders nativos. La auditoría del runtime reportó **cero** vulnerabilidades después de esas correcciones. Las actualizaciones compatibles de tooling dejaron ocho avisos exclusivamente de desarrollo en cadenas Tailwind/glob/watch/parser: uno moderado y siete altos, ninguno crítico. Se conservó la versión mayor de Tailwind; no se ejecutó `npm audit fix --force` ni se presenta la auditoría completa como cero.

La aceptación móvil usa viewport de navegador, no certifica cada dispositivo/iOS. Descargas PNG/JPG/ZIP fueron verificadas; compartir nativo depende del navegador/sistema y no abrió una interfaz real de compartir durante QA.

Los archivos finales de historias se generan en cliente; la biblioteca guarda snapshots y metadatos de eventos, no una copia hospedada ni prueba de entrega/publicación. La revalidación reduce ofertas desactualizadas; no elimina una venta posterior a validar/descargar y no reserva stock.

## Habilitación productiva pendiente, fuera de la ejecución autorizada

- Verificar recursos/entorno actuales, runtime compatible, backup y restauración, rol de servidor y despliegue separado.
- Confirmar negocio/propietario real, moneda y escala. No se convirtieron importes ni se corrigieron los `XXX` históricos automáticamente.
- Revisar/aplicar migraciones y habilitar perfil/política comercial con los hechos reales confirmados.
- Configurar/probar bucket **privado**, credenciales exclusivamente de servidor, cuotas y recuperación. El adaptador Supabase está implementado, pero no fue conectado a un recurso real durante este trabajo.
- Confirmar WhatsApp de ventas, activos de marca, dominios y orígenes permitidos. Las identidades/contactos de prueba son DEMO.
- Validar el acceso WhatsApp y el flujo productivo con la cuenta existente antes del piloto.
- Autorizar por separado publicación Meta, tokens/app/permisos y capacidades de Stories. La preparación quedó deshabilitada; ver META_PREPARATION.md.
- Decidir por separado pagos, pedidos/reservas productivos, logística y proveedor/checkout. No se conectó una pasarela ni se creó un servicio pago.

No hubo push, despliegue, migración productiva, conexión de cuentas ni publicación real. El supervisor está preparado y simulado, **no ejecutándose**; su recuperación de cuota real no se afirma verificada. El código local completo queda en la rama `codex/fullmatch-studio`, con hitos versionados y checkpoint persistente.

Operación: STUDIO_OPERATIONS.md. Continuidad externa: CONTINUITY.md. Especificaciones incrementales: STAGE_2_CONTRACT.md, STAGE_3_CONTRACT.md y STAGE_4_CONTRACT.md.

Último hito de código validado: `e05a2f3`. Hitos anteriores: `e92484b` (fundaciones), `ad3ac88` (Studio privado), `2da4c0c` (catálogo) y `1d63a74` (automatización local). El checkpoint queda `COMPLETED` para este alcance local, con todos los controles externos anteriores pendientes de habilitación real.
