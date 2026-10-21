# Etapa 2 — contrato incremental de publicación y catálogo

Estado: implementación local sobre el hito privado validado `ad3ac88`. No habilita publicaciones, migraciones ni dominios productivos.

## Modelo y autorización

`commerce_catalogs` tiene un catálogo por negocio, UUID técnico, slug público único e inmutable, `public_enabled=false` inicial, revisión y autoría. Referencia al perfil comercial existente por negocio. Habilitarlo es una acción explícita del propietario; requiere WhatsApp de ventas confirmado en el perfil.

`commercial_publications` referencia la ficha mediante `(owner_phone, commercial_product_id)`. Su estado `hidden/published`, revisión, fechas y autoría son independientes de `draft/ready/archived` y del inventario. Sin fila, una ficha está oculta con revisión cero. Publicar exige ficha preparada y validación comercial vigente. Agotarse no despublica una ficha válida: se muestra sin disponibilidad. Archivar, romper vínculos o invalidar moneda/foto hace que la proyección pública deje de mostrarla.

Las dos tablas se agregan mediante migración explícita versión 2, probada en PostgreSQL aislado. Se aplican relaciones compuestas, RLS y revocación de privilegios de roles web. No se cambia el checksum de la migración 1 ni se ejecuta DDL desde HTTP.

## Contratos privados

- `GET /api/commerce/v1/catalog`: configuración del catálogo del propietario.
- `PUT /api/commerce/v1/catalog`: crear/configurar con `operationId`, `expectedRevision`, `slug`, `publicEnabled`.
- `GET /api/commerce/v1/products/:id/publication`: estado/revisión de publicación.
- `PUT /api/commerce/v1/products/:id/publication`: publicar/ocultar con `operationId`, `expectedRevision`, `expectedProductRevision`, `status` y motivo.

Reutilizan autenticación, ámbito del negocio, recibos deterministas y conflictos de revisión. Configuración y publicación no aceptan precios, saldos ni IDs de propietario del navegador.

## Contratos públicos

- `GET /api/catalog/v1/:shop`: marca, contacto de ventas y configuración pública mínima.
- `GET /api/catalog/v1/:shop/products`: búsqueda literal, filtros de equipo/temporada/versión/manga/equipación y cursor de slug. Máximo 48 resultados por página.
- `GET /api/catalog/v1/:shop/products/:slug`: ficha comercial pública y galería autorizada.
- `GET /api/catalog/v1/:shop/products/:slug/images/:imageId`: binario derivado privado, servido por backend solamente si catálogo y ficha continúan publicados/válidos.

La respuesta se construye mediante allowlist explícita: slug/título/descripción, identidad comercial, fotos/alt, precio monetario exacto, talles y disponibilidad booleana. No incluye teléfono del propietario, SKU IDs/huellas/revisiones, cantidades internas, reservas, costos, claves de almacenamiento, recibos ni clientes/pedidos/historial. El WhatsApp es exclusivamente el contacto comercial configurado.

Se comprueba publicación y preparación también en fotos y enlaces directos. Catálogo deshabilitado, ficha oculta o negocio deshabilitado responden 404. Los datos se consultan en transacción read-only consistente. Se usa `no-store` para impedir que un caché conserve fotografías retiradas o datos revocados.

## Interfaz pública y SEO

El catálogo se renderiza en el backend para entregar título, descripción y contenido útil sin depender de JavaScript ni agregar otro runtime. Rutas estables: `/c/:shop` y `/c/:shop/p/:slug`. Reutiliza las mismas fichas/fotos de Studio. HTML/CSS propios responsive con identidad FullMatch; búsqueda y filtros mediante GET, ficha con galería/talles/precio y contacto por WhatsApp.

Metadatos sociales y JSON-LD se derivan exclusivamente de la proyección pública. Canonical absoluto se agrega solo cuando existe un origen público configurado explícitamente; no se confía en un Host arbitrario. HTML y JSON de scripts se escapan por contexto. Una CSP limita recursos al propio servicio y no permite scripts inline de aplicación.

La decisión de SSR evita depender de reglas de rewrite o duplicar la aplicación privada. El backend puede servir estas rutas detrás del dominio público que se confirme posteriormente. No se crea un despliegue ni se conecta una cuenta externa durante esta etapa.

## Aceptación

Verificar migración repetible y aislamiento; publicaciones explícitas/replay/conflictos; ocultación instantánea de HTML, JSON y medios; inventario vigente sin descontar reservas otra vez; moneda inválida/identidad obsoleta sin exposición; búsqueda literal y paginación acotada; ausencia de campos operativos en contratos públicos; HTML escapado; SEO y navegación PC/móvil; no consultas a `/api/state`; regresión privada/Stocky.
