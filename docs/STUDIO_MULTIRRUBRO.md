# Stocky Studio multirrubro — implementación local

## Relevamiento y reutilización

El rubro existe en `auth_users.business_category` y el perfil autorizado de Stocky lo entrega en la sesión. No se agregó otro campo de rubro ni se usa para imponer un diseño.

`product_family_schemas` define familias versionadas con unidad y atributos tipados. Los SKU referencian `family_id`/`family_version`; sus valores están en `products.attributes_json`. Una familia es un contrato de inventario, no una categoría comercial.

`products.product_type` y `product_model` contienen el tipo y modelo del SKU. El catálogo deriva sus categorías de los tipos de los SKU activos vinculados. No se creó otra categoría editable ni otro sistema de atributos. La edición de los datos específicos sigue realizándose en Stocky.

Los campos comerciales deportivos y su índice de identidad se conservan para las fichas actuales, pero ya no son requisitos universales de preparación. Los vínculos con SKU siguen siendo explícitos, con revisión y huella verificadas. `brand_preset=fullmatch_v1` queda como metadato de compatibilidad del esquema y recibos; no dirige la presentación universal.

La marca existente está en `commerce_profiles.appearance`, con logo, portada, colores y textos; las imágenes están en `commerce_brand_assets`, aisladas por negocio. Se reutilizaron formulario, vista previa, endpoints, permisos y guardado. No se duplicaron campos, tablas ni pantallas de configuración.

## Presets opcionales sobre la configuración actual

En **Configuración → Identidad visual**, el selector **Diseño del catálogo** agrega únicamente `appearance.preset`:

- **Actual** (`classic` o campo ausente): composición existente con mejoras compartidas.
- **Editorial**: tipografía expresiva, dos columnas y fotografías grandes.
- **Catálogo técnico**: cabecera compacta, búsqueda destacada y especificaciones legibles.
- **Comercio de proximidad**: tarjetas compactas y acceso rápido a categorías.

Cambiar el preset conserva colores, textos, fotos, logo, catálogo y publicaciones. Se puede volver a Actual sin repetir el alta del negocio. Clientes anteriores que omiten `preset` al guardar conservan el valor elegido. Se validan los valores permitidos, revisión, permisos y recibos idempotentes.

Studio tiene identidad de software propia, con acento violeta, navegación clara y cabecera compacta. El comercio aparece como contexto autorizado. Los colores del negocio quedan en su tienda, historias y vista previa.

La tienda usa tokens CSS y texto blanco/negro según luminancia. La portada se compone junto al texto para proteger su contraste; la vista previa utiliza un fondo opaco bajo el texto. Los presets determinan composición, no rubro ni marca.

## Productos, filtros e historias

Las presentaciones utilizan `size` cuando existe y el nombre del SKU cuando falta. Se conserva `size` en el contrato de consultas para mantener compatibilidad. No se alteran identificadores ni huellas físicas. Presentaciones ambiguas siguen bloqueadas y requieren revisión de vínculos.

Las unidades se leen del inventario. Se proyectan únicamente atributos conocidos de una lista pública explícita: marca, modelo, medidas, material, potencia, capacidad, contenido, presentación, sabor, color y talle. No se publican atributos arbitrarios, como notas de proveedor, ni estados desconocidos o no aplicables. Este conjunto conservador no reemplaza ni duplica los esquemas de familia existentes.

Los filtros públicos provienen del catálogo publicado completo de cada negocio, independientemente de búsqueda y paginación. Equipo y versión solo aparecen con datos reales. Consultas, SEO y estados vacíos usan lenguaje genérico; las fichas admiten ausencia de fotografías y no inventan detalles técnicos.

Una ficha puede prepararse y publicarse sin fotografía, manteniendo las verificaciones de stock, dinero, identidad y permisos. **Una historia requiere portada real**, selección disponible y revalidación antes de descargar. El renderizador 5 agrega etiquetas y unidades de presentación; snapshots anteriores mantienen su proyección semántica y renderizadores compatibles. Cambiar solo el preset del catálogo no invalida historias; cambiar marca o inventario relevante sí.

## Actualización mínima y explícita

Los presets usan el JSON de la migración 4 y no requieren DDL. La migración **5** retira solo la restricción heredada que exigía identidad de fútbol para cualquier ficha preparada; conserva datos, campos, índices de identidad, RLS y claves foráneas por negocio.

Revisar con `npm run commerce:universal:schema:check`; aplicar explícitamente con `npm run commerce:universal:schema:apply`, usando `COMMERCE_DATABASE_URL`. Los destinos remotos conservan el requisito `--allow-remote-database`. El bundle SQL incluye versiones 1–5. No hay migraciones al abrir Studio ni al guardar ajustes. Sin versión 5, preparar una ficha genérica informa que el servicio necesita actualizarse.

No se desplegó ni migró producción.

## Evidencia reproducible

- `npm run test:commerce:presentation`: presets, ausencia de talle/foto, unidades, stock, dinero, identidad, privacidad y escape HTML.
- `npm run test:studio:multirubro`: PostgreSQL temporal, indumentaria/ferretería/kiosco, clientes anteriores, persistencia y selección desde Configuración, aislamiento, filtros completos, consultas, escritorio 1440 px/móvil 390 px, PNG de 1080 × 1920, snapshots v4 e inventario intacto.
- `npm run test:studio:branding`: permisos, persistencia, imágenes aisladas, vista previa, catálogo y exportación con marca.
- `npm run test:studio:templates`: cinco plantillas, encuadre, precios largos, texto escapado, exportación y versiones anteriores.
- `npm run test:commerce:sql`: instalación/repetición/rollback, preservación de datos y permisos.
- `npm run test:commerce:browser` y `npm run test:commerce:onboarding`: regresiones de los flujos existentes.

Capturas y exportaciones locales en `.fullmatch-runtime/multirubro/`, `.fullmatch-runtime/branding/` y `.fullmatch-runtime/browser/` (ignoradas por Git). Ferretería y kiosco usan datos y arte rotulados de prueba exclusivamente en bases temporales.

No se agregó editor visual libre ni controles independientes para tipografía, botones o densidad: se resuelven con los presets. No se generan agrupaciones permanentes automáticamente. Las cantidades de consulta mantienen el contrato entero existente (1–10 por presentación); no se implementó venta fraccionaria ni pagos, reservas o envíos.
