# Rendimiento del catálogo público — 9 de noviembre de 2026

Estado al cerrar la auditoría inicial: cambios implementados y comprobados localmente, todavía sin confirmar el despliegue. Producción se midió únicamente en lectura. No se modificaron inventarios reales, servicios de Render, planes ni costos.

**Actualización:** la validación posterior confirmó el commit en producción y comparó mediciones públicas reales. Ver [validación de producción](PRODUCTION-VALIDATION.md) y [production-after.json](production-after.json). Ese informe distingue la versión publicada de las correcciones que siguen pendientes de autorización.

## A. Diagnóstico y arquitectura

Studio es React 18/TypeScript con Vite. El catálogo público tiene una arquitectura distinta: Express renderiza HTML en `server/catalog/render.js`, con CSS y JavaScript pequeños, sin descargar React. Antes, cada enlace y formulario hacía una navegación completa. Reescribirlo como una SPA de React no era necesario.

Las páginas `/c/:shop`, `/c/:shop/p/:slug` y `/c/:shop/pedido` usan `server/commerce/catalogService.js`. Las APIs correspondientes son `/api/catalog/v1/:shop`, `/products`, `/products/:slug`, `/products/:slug/images/:imageId`, `/brand-assets/:id` y el POST `/inquiry-preview`. El listado tiene paginación por slug, 24 productos por defecto y un máximo de 48.

PostgreSQL contiene configuración en `commerce_catalogs` y `commerce_profiles`; publicaciones en `commercial_publications`; fichas en `commercial_products`; vínculos en `commercial_product_skus`; inventario, precios y disponibilidad en `products`; moneda en `inventory_money_policies`; y metadatos de fotos en `commercial_product_images`. Las lecturas públicas mantienen transacciones de solo lectura con aislamiento repeatable read y una proyección explícita de campos públicos.

### Causas comprobadas, por impacto

1. **Consultas secuenciales N+1 en el listado.** Después de buscar las fichas se ejecutaba `readProductDetail` para cada una: ficha, SKUs, imágenes y política monetaria. Medición real con tres productos: **15 SELECTs**. La fórmula del código anterior era `3 + 4 × productos`, por lo que una página de 24 implicaba 99 SELECTs; este último número es derivado del código, no una medición anterior con 24 productos. En producción el TTFB del listado fue **7,41 s desktop / 7,39 s móvil**. Al volver se observaron TTFB entre **6,14 y 7,21 s**, por lo que la lentitud no aparece solamente en la primera visita.
2. **Recargas completas y recursos repetidos.** Las fichas disparaban 6 requests y volver al listado 8 en la fixture local. Cada vuelta repetía lecturas de catálogo, tema e imágenes. Se observaron estas recargas tanto en frío como en recorridos sucesivos.
3. **Imágenes sin reutilización HTTP efectiva.** El middleware aplicaba `no-store` también a imágenes y tema. Una muestra real de producción tiene miniatura JPEG de **270 × 480 / 30.637 bytes**, y master de **900 × 1600 / 354.060 bytes**, ambos con `no-store`. Existía ETag automático, pero sin permitir almacenar y revalidar el recurso. Cada solicitud de foto recorría la ficha completa y luego buscaba las claves de almacenamiento y descargaba el archivo privado.
4. **Detalle descargaba el master; el diálogo oculto también tenía un `src`.** El procesamiento de subida ya producía JPEG master de hasta 2400 px y miniatura de hasta 480 px: no se estaban enviando los originales sin procesar. Faltaba una representación intermedia y evitar cargar el zoom hasta abrirlo. Los archivos están en almacenamiento local solo para desarrollo o en un bucket privado Supabase en producción; se entregan a través del servidor, sin exponer claves ni credenciales.
5. **Recursos estáticos sin compresión en la implementación local.** CSS y JS representaban una parte grande de los bytes iniciales. La solución comprime exclusivamente esos recursos públicos con las bibliotecas de Node que ya existen.

Evidencia: [línea base local](before.json), [recorrido de producción](production-before.json), [muestra de imágenes de producción](production-images-before.json). Los tiempos de producción son observaciones desde este equipo, no tiempos exclusivos del motor SQL. Las categorías/equipos utilizados por el recorrido de producción son valores fijos de prueba; no se presenta ese recorrido como una validación exhaustiva de sus datos reales.

## B. Cambios implementados

- `server/commerce/publicProductRepository.js`: carga SKUs, fotos y política monetaria de toda la página en una única consulta con agregados independientes; conserva orden de variantes y fotos, validación de identidad, moneda, disponibilidad y las mismas reglas de preparación de Studio. No multiplica filas mediante un join entre galerías y variantes.
- `server/commerce/catalogService.js`: reutiliza las filas de fichas obtenidas, elimina el N+1, consulta la moneda una vez por lote y elimina lecturas redundantes de fotos. El listado queda en **4 SELECTs** y detalle/imágenes en **3**. La prueba verifica 4 con tres y también con 24 productos. Cada consulta y clave de caché está acotada al comercio.
- `server/catalog/assets/navigation.js`: mejora progresiva de enlaces y formularios con `fetch`, History API, eliminación de solicitudes simultáneas idénticas y restauración de filtros/scroll. Conserva el contenido anterior durante la carga. Las páginas completas y los enlaces siguen funcionando sin JavaScript. Pedido y WhatsApp conservan sus rutas y validación existentes. Actualiza título, canonical, metadatos, marca y tema en cada navegación.
- `server/catalog/assets/cart.js`: reinicializa controles al navegar y elimina el listener/las solicitudes de una página anterior. Conserva galería, zoom, teclado, precios por presentación, pedido local separado por comercio y revalidación del pedido antes de ir a WhatsApp.
- `server/catalog/render.js`: usa miniaturas WebP de 480 px y detalle WebP de hasta 960 × 1200; mantiene el master para ampliar. No descarga el master del diálogo antes de abrirlo. Prioriza la imagen principal, mantiene lazy loading fuera de las primeras tarjetas y versiona el tema por revisión del perfil.
- `server/catalog/mediaCache.js`: caché LRU de bytes, hasta **32 MiB / 128 entradas / 5 minutos**, con solicitudes idénticas agrupadas, hasta 4 trabajos de almacenamiento/codificación concurrentes y 64 pendientes. No retiene permisos ni datos de inventario; los errores no se cachean. El límite devuelve indisponibilidad temporal si se satura, en vez de acumular trabajo sin límite.
- `server/catalog/router.js`: imágenes, marca y tema con `private, no-cache` y ETag. **Se comprueba publicación y preparación actuales antes de responder 304**, incluso cuando el navegador presenta un ETag válido. No se permite que una caché compartida entregue fotos de un comercio deshabilitado.
- `server/catalog/staticAssets.js`: agrupa cart/navegación en un solo script y prepara Brotli/gzip una vez por proceso. Recursos públicos de código y CSS: `public, max-age=3600`, ETag y `Vary: Accept-Encoding`. No hay dependencias nuevas.
- `scripts/test-catalog-performance.mjs`, `scripts/measure-catalog-performance.mjs`, `scripts/summarize-catalog-performance.mjs`, `scripts/catalog-http-checks.js` y scripts de `package.json`: regresiones y mediciones reproducibles.

### Consistencia e invalidación

Las APIs JSON, HTML y cotizaciones conservan `no-store`. No hay caché del servidor de stock, precios, configuración, facetas ni resultados de consultas: cada lectura ve el inventario dentro de su snapshot transaccional. Esta decisión evita introducir invalidadores incompletos ante los distintos escritores del inventario.

El navegador conserva hasta seis listados pequeños en memoria durante **10 segundos**, solo para pintar el regreso inmediatamente; **siempre solicita y aplica una versión actual**. No persiste estas páginas en localStorage y no reutiliza snapshots de fichas. Un prefetch por intención puede reutilizar HTML durante **dos segundos**, sin descargar fotos por adelantado; se desactiva con ahorro de datos o conexión 2G. Los pedidos se vuelven a cotizar en el servidor antes de contactar por WhatsApp. Como con el HTML anterior, una página abierta no recibe actualizaciones en tiempo real sin una nueva lectura.

Los bytes de imagen se identifican por comercio, clave privada inmutable, hash, variante y formato; cambios de imagen generan otra identidad. Ocultar/eliminar una foto, invalidar la identidad de un SKU, deshabilitar el comercio o retirar una publicación bloquea la lectura antes de consultar esa caché. El almacenamiento de imágenes del navegador debe revalidarse, y un 304 no vuelve a descargar el archivo privado. Los cambios visuales incrementan la revisión del perfil y cambian la URL del CSS del tema; se verificó que marca y colores cambien al volver durante una navegación cliente.

## C. Comparación medida

Playwright con Edge headless, PostgreSQL temporal local y tres productos con imágenes sintéticas. Tres contextos independientes por viewport y versión, **78 muestras antes + 78 después**. Móvil: 390 × 844, DPR 2, CPU ×4, latencia emulada 80 ms, descarga 200.000 bytes/s y subida 100.000 bytes/s. No equivale a un teléfono real ni al inventario completo de producción.

Medianas móviles, antes → después:

- Listado inicial visible: **916 → 707 ms**. FCP: **820 → 584 ms**. LCP: **1.068 → 596 ms**; p95 observado de LCP después: 612 ms.
- Primera ficha visible: **600 → 388 ms**. Requests: **6 → 2**; bytes: **36.494 → 16.966**.
- Segunda ficha: **321 → 265 ms**. Tercera ficha: **335 → 271 ms**.
- Primera vuelta al catálogo visible: **358 → 81 ms**; p95 observado después: 116 ms. Tiempo hasta completar la revalidación/las imágenes y la espera de medición: **769 → 364 ms**. Requests: **8 → 1**; bytes: **40.834 → 7.533**.
- Búsqueda: **380 → 303 ms**. Requests: **6 → 1**.
- Recarga de ficha visitada: **475 → 347 ms**; bytes: **36.494 → 6.980**. Las solicitudes de imágenes pueden seguir apareciendo como revalidaciones: no se afirma que desaparezcan todas las requests.
- Transferencia inicial total: **105.317 → 42.311 bytes**, aproximadamente 60 % menos. El listado inicial sigue haciendo 8 requests en esta fixture.

Medianas desktop:

- Listado inicial visible: **196 → 139 ms**.
- Primera ficha: **201 → 128 ms**.
- Primera vuelta: **145 → 64 ms**, con cero nuevas solicitudes de documento.
- Segunda ficha: **101 → 59 ms**.

Backend local medido directamente, después de comprobar el esquema:

- Listado de tres productos: **15 → 4 SELECTs**, SQL acumulado mediano **11,34 → 3,68 ms**; servicio completo **13,89 → 5,03 ms**.
- Detalle: **6 → 3 SELECTs**, SQL acumulado mediano **3,62 → 2,40 ms**; servicio completo **4,57 → 3,49 ms**.
- El test adicional llena una página de 24 productos y verifica que el listado sigue usando **4 SELECTs**. Los contadores excluyen `BEGIN`/`COMMIT` y la inspección de esquema que ocurre una vez por instancia; las duraciones del servicio incluyen su transacción.

Se guardó `EXPLAIN (ANALYZE, BUFFERS)` del listado en los JSON locales. En esa fixture pequeña no hay evidencia para justificar nuevos índices. Ya existen índices únicos de catálogo/slug, producto `(owner_phone, slug)`, vínculos de SKU, publicaciones visibles y galerías por comercio/producto. No se alteraron migraciones existentes ni se agregó DDL durante solicitudes HTTP.

### Límites de la medición

`visibleMs` mide acción → selector visible + dos frames; **no significa imagen totalmente decodificada**. `settledMs` además espera carga de imágenes visibles, fin de revalidación cliente y 150 ms para recoger observadores. No se usa un `networkidle` global que incluya recursos fuera del viewport. Los bytes provienen de CDP `Network.loadingFinished` e incluyen encabezados; los tiempos incluyen la automatización.

TTFB, FCP y LCP nativos pertenecen al documento. Tras una navegación cliente el registro nativo continúa mostrando los valores del documento anterior; el resumen **solo compara esas métricas para carga inicial y recarga**, y utiliza `visibleMs` para las navegaciones cliente. No debe interpretarse el campo `lcp` repetido de los archivos crudos como un LCP de cada navegación cliente.

Event Timing y long tasks fueron registrados. La distribución observada del máximo de interacción del documento tiene p95 56 ms después, pero **es un indicador de laboratorio, no una medición certificada de INP**: no se afirma que INP de usuarios reales sea menor de 200 ms. Tres repeticiones son una muestra pequeña; el p95 por escenario corresponde al máximo de esas tres observaciones. Los valores de producción son una observación por viewport, sin percentiles estadísticamente robustos ni una comparación posterior al despliegue.

Datos completos: [resumen con p50/p95](summary.json), [antes](before.json), [después](after.json). Los escenarios incluyen inicio, tres fichas sucesivas con vueltas, búsqueda, categoría/equipo/versión, visita repetida y recarga.

## D. Pruebas

Pasaron:

- `node --test scripts/test-commerce-domain.js scripts/test-commerce-images.js scripts/test-commerce-presentation.js`: **22 tests**; identidad, moneda, permisos, límites de imágenes, exposición pública y productos genéricos.
- `npm run test:catalog:performance`: consultas constantes con 3/24 productos; paridad de DTO y preparación con el lector privado; paginación; filtros y búsqueda literal; productos sin fotos; precios/stock actuales; WebP y dimensiones; 304 vacío; revocación de imágenes previamente cacheadas; aislamiento entre comercios; agrupación, expiración, expulsión y límites de concurrencia de caché; compresión; navegación desktop/móvil, filtros, scroll, History API, personalización y navegación sin JS.
- `npm run test:catalog:order`: galería desktop/móvil, anterior/siguiente, thumbnails, zoom y teclado; carrito persistente; enlaces heredados; WhatsApp interceptado localmente; reconfirmación de cambios de precio y bloqueo al agotarse el stock.
- `npm run test:commerce:minimal-publication`: creación genérica, conservación de metadatos, publicación sin fotos/almacenamiento, reintentos y agregar una foto posteriormente. Una ejecución inicial falló al comprobar la descripción de un formulario privado de Studio; la repetición completa pasó. No se cambió ese formulario como parte de esta optimización.
- `npm run build:studio` y `npm run build`: compilación TypeScript y bundles de producción correctos.
- `git diff --check`: sin errores de whitespace.

No se ejecutó toda la suite de inventario ni pruebas de carga. El repositorio ya contenía modificaciones ajenas al catálogo al empezar; se conservaron.

## E. Render, pendientes y reproducción

La URL pública responde desde Render y el catálogo SSR se monta en el mismo proceso Express que las APIs. El repositorio no contiene un Blueprint `render.yaml` ni configuración verificable de plan/región. No hay herramientas MCP de Render habilitadas ni CLI `render` instalado en este entorno; por eso **no se verificaron CPU/RAM, plan, suspensión, región, métricas internas, pool de producción ni ubicación de PostgreSQL/Supabase**. No se atribuye la demora a esas causas sin evidencia. `server/dbRuntime.js` usa un pool `pg` reutilizado y `connectionTimeoutMillis=10000`; no abre un pool por imagen. No se cambió globalmente ese pool sin métricas que lo justifiquen.

Pendientes que requieren un despliegue o acceso adicional:

1. Desplegar el código y repetir el recorrido de producción con los mismos dispositivos/condiciones. **Los resultados locales no garantizan LCP <2,5 s en producción**. Guardar `production-after.json`; no comparar los tiempos locales con los de producción como si fueran la misma población.
2. Con acceso de lectura a Render y PostgreSQL: revisar p50/p95, CPU/RAM, esperas del pool y `pg_stat_statements`; analizar el plan real con el volumen del comercio. Verificar co-ubicación servidor/base/storage antes de proponer moverlos o aumentar el plan.
3. Si la codificación WebP en el primer acceso consume CPU apreciable, generar derivados durante la subida o una tarea de mantenimiento explícita. No se transformaron ni migraron fotos reales en esta tarea.
4. Evaluar caché de facetas/configuración solo si las métricas posteriores lo justifican y se cuenta con invalidación de todos los escritores. Para una primera visita, el servidor todavía consulta datos vivos y autoriza cada foto.

Reproducción local sin tocar la base real:

```powershell
npm run test:catalog:performance
npm run test:catalog:order
node scripts/measure-catalog-performance.mjs --label=current --runs=3
```

La fixture crea PostgreSQL y almacenamiento descartables y no usa las URLs de bases reales para sus operaciones. Requiere Edge/Playwright y permiso para procesos y conexiones localhost. Los archivos `before.json` y `after.json` conservan la evidencia de esta intervención; usar otra etiqueta para nuevas mediciones.

Después de desplegar, recorrido público secuencial de lectura, una repetición por viewport y sin enviar mensajes:

```powershell
node scripts/measure-catalog-performance.mjs --production --label=production-after --runs=1
```

Para regenerar el resumen de los archivos históricos locales y la línea base pública:

```powershell
node scripts/summarize-catalog-performance.mjs
```

Para validar INP real, usar datos de campo o una sesión específica de Performance con Event Timing y suficientes interacciones; para solicitudes SQL de producción, usar métricas autorizadas del servidor/base. No inferir esos tiempos restando TTFB del navegador.
