# Validación real de producción del catálogo — 9 de noviembre de 2026

**Conclusión:** se eliminó la espera de varios segundos al volver al catálogo y el TTFB del listado bajó aproximadamente un 90 %. La navegación sucesiva observada está por debajo de un segundo. La primera carga móvil y las fotos todavía tienen margen: el LCP móvil mediano fue 2,44 s, con una observación de 2,564 s, y las imágenes visibles de una ficha con fotos tardaron 2,464 s en el primer recorrido de esa ficha.

Se confirmó que **`0e069a34020bbca731152208f486a901565aff34` ya estaba publicado al comenzar esta revisión**. `/api/health` devolvió ese SHA antes y después de las mediciones, y el JavaScript público incluye la optimización. No se inició otro despliegue, no se pushearon cambios nuevos a main y no se cambiaron inventarios, planes ni servicios. Los ajustes nuevos descritos abajo siguen locales y requieren autorización para publicarse.

## Evidencia y método

- [production-before.json](production-before.json): línea base histórica, una repetición por viewport, conservada sin modificar.
- [production-after.json](production-after.json): **108 muestras**, tres repeticiones por viewport, contra el mismo commit publicado durante toda la medición.
- [production-comparison.json](production-comparison.json): comparación reproducible de los **26 escenarios históricos por dispositivo** —13 escenarios en cada uno de los dos viewports— y diez combinaciones adicionales de escenario/dispositivo para caché e imágenes.
- [production-probes.json](production-probes.json): 36 sondas secuenciales de endpoints públicos, con revalidaciones adicionales de imágenes.
- [production-database.json](production-database.json): evidencia del intento de diagnóstico SQL, bloqueado por validación TLS, sin ejecutar consultas.

Se repitieron inicio, tres fichas y sus vueltas, búsqueda Barcelona, filtros de categoría/equipo/versión, visita repetida y recarga. Las rutas de página de los 26 casos históricos coinciden. Las tres primeras fichas actuales no tienen foto principal; por eso se agregaron recorridos explícitos a la ficha publicada de Boca con fotos, su recarga y su revisita caliente.

Se mantuvieron Edge headless y los parámetros originales: desktop 1440 × 900; móvil 390 × 844, DPR 2, CPU ×4, latencia emulada 80 ms y descarga/subida 200.000/100.000 bytes/s. Versión actual del navegador: 157.0.4341.42. La línea base no registró su versión de Edge. No se falsificó una equivalencia de versiones ni de carga del servidor.

Cada repetición abre un contexto nuevo con caché del navegador vacía. Las revisitas calientes mantienen ese contexto. **“Frío” se refiere al navegador**: no se reinició Render, no se purgaron sus cachés ni se forzó una suspensión. El estado del servidor y de su caché de imágenes no estuvo controlado. Los recorridos y sondas fueron secuenciales, sin prueba de carga concurrente.

Las cifras siguientes comparan la observación histórica con la **mediana de tres observaciones nuevas**, no percentiles de campo. El p95 por escenario nuevo es el máximo observado de tres muestras. El catálogo y el tráfico pueden haber cambiado entre sesiones; la comparación no aísla experimentalmente todas las variables de producción.

## Resultados antes → después

### Escritorio

- TTFB inicial del listado: **7.412 → 670 ms**, aproximadamente 91 % menos. Máximo nuevo: 673 ms.
- Listado visible inicial: **8.380 → 1.626 ms**.
- LCP inicial: **8.136 → 1.600 ms**; máximo nuevo: 2.432 ms.
- Primera ficha visible: **1.226 → 874 ms**. Segunda: **1.175 → 849 ms**. Tercera: **1.186 → 858 ms**.
- Primera vuelta al listado visible: **7.294 → 52 ms**. Las siguientes: **11.997 → 52 ms** y **7.654 → 47 ms**.
- La revalidación del listado sigue ocurriendo: TTFB de la primera vuelta **6.792 → 609 ms**. Pintar el snapshot en 52 ms no significa que la consulta de actualización haya terminado en ese tiempo.
- Requests de la primera ficha: **7 → 2**. Primera vuelta: **8 → 2**, incluyendo una solicitud de prefetch que puede seguir en vuelo. No hay una nueva solicitud de documento en estas navegaciones.

### Móvil simulado

- TTFB inicial del listado: **7.389 → 725 ms**, aproximadamente 90 % menos. Máximo nuevo: 740 ms.
- Listado visible inicial: **9.126 → 2.514 ms**.
- LCP inicial: **9.052 → 2.440 ms**; máximo nuevo: **2.564 ms**. El objetivo de 2,5 s no se cumple en todas las muestras.
- Primera ficha visible: **1.387 → 906 ms**. Segunda: **1.289 → 861 ms**. Tercera: **1.199 → 881 ms**. Máximos nuevos: 910, 881 y 911 ms, respectivamente.
- Primera vuelta al listado visible: **7.405 → 94 ms**. Las siguientes: **7.362 → 86 ms** y **6.762 → 102 ms**.
- TTFB de la actualización de la primera vuelta: **6.847 → 614 ms**. El snapshot se muestra antes de esa actualización.
- Primera ficha: **6 → 1 request**. Primera vuelta: **9 → 1 request**. En las navegaciones se usa HTML por `fetch`; no se vuelve a descargar el documento, CSS y JS compartidos.
- Búsqueda visible: **2.320 → 925 ms**. Filtro de categoría: **8.698 → 1.997 ms**. Equipo: **2.181 → 1.447 ms**. Versión: **2.607 → 1.539 ms**. Los filtros históricos se ejecutan con `page.goto`, como antes, y por eso incluyen una navegación de documento. Las pruebas locales verifican además los formularios con navegación cliente.
- Recarga de ficha visitada: **1.872 → 1.376 ms**. Transferencia en esa ventana: **57.165 → 2.618 bytes**.

### Frío y caliente, imágenes y API

- Listado mediante navegación de documento con caché caliente: **TTFB 601 ms desktop / 618 ms móvil**; visible 1.449 / 1.518 ms. No equivale al regreso por snapshot.
- Ficha con fotos, primera entrada por enlace: contenido visible en **865 ms desktop / 904 ms móvil**. Las imágenes visibles —incluida la principal, con decodificación y dos frames— están listas en **1.486 / 2.464 ms**. Máximos: 2.411 / 2.536 ms. Esta medición es una cota para la disponibilidad conjunta de las imágenes visibles, no un evento independiente exacto de primera pintura de cada foto.
- Reabrir la misma ficha en caliente: visible **876 / 890 ms**; imágenes visibles listas **895 / 911 ms**. En ese recorrido se registra una sola request de HTML y ninguna nueva request de imagen.
- Recarga de la ficha con fotos: imágenes listas **1.312 / 1.406 ms**; se verifican revalidaciones 304 y aproximadamente 4,1 KB transferidos en la ventana, sin volver a descargar los cuerpos de las fotos.
- Sondas directas de una foto real: master JPEG **900 × 1600, 354.060 bytes**; detalle WebP **675 × 1200, 187.880 bytes**, aproximadamente 47 % menos. Miniatura JPEG **30.637 bytes** frente a WebP **28.750 bytes**, aproximadamente 6 % menos. Son representaciones distintas; no se promete que WebP reduzca todas las fotos en un porcentaje fijo.
- Logo PNG **400 × 400 / 53.488 bytes** y portada JPEG **1600 × 791 / 113.572 bytes** suman 167 KB de cuerpos. Siguen siendo una parte importante de la primera descarga. La carga inicial móvil medida pasó de **185.469 a 216.532 bytes** en su ventana, y desktop de **185.891 a 187.399 bytes**: **la reducción del 60 % observada en la fixture local no se reproduce en el inicio real de este comercio**. Las ventanas incluyen solicitudes de imágenes que pueden comenzar o terminar en un paso vecino; no se atribuye toda esa diferencia a una única causa.
- No se observan llamadas a endpoints JSON de productos/configuración durante estos enlaces: el servidor entrega el HTML y las imágenes se solicitan a `/api/catalog/v1/.../images/...`. `dataApiRequests` separa las APIs de datos de `imageApiRequests`; contar solo JSON no significa que no haya tráfico al backend.
- Se verificaron respuestas **304 sin cuerpo** para logo, portada, thumbnail JPEG/WebP, detalle WebP y master en las tres repeticiones de las sondas. Se mantuvieron los controles de publicación y preparación antes de reutilizar la foto.

El archivo histórico no registró tiempos independientes de decodificación/pintura de imágenes ni tiempos por cada request. **No se inventa un “antes” para `imageReadyMs`**. El nuevo medidor agrega esos datos; `visibleMs` mantiene la misma secuencia de acción, selector y dos frames. `settledMs` ahora incluye decodificación adicional y no se usa como comparación estrictamente equivalente.

Los valores LCP/FCP/TTFB nativos pertenecen al documento. En una navegación cliente pueden conservar los valores anteriores. La comparación usa el TTFB de la request real de HTML (`navigationTtfbMs`) y no reutiliza el TTFB del documento previo. LCP se compara solo cuando existe una nueva navegación de documento.

No hubo errores JavaScript ni respuestas HTTP de error registradas. Hay 18 registros de prefetch todavía sin respuesta al cerrar su ventana; se conservan como incompletos, sin contarlos como errores ni adjudicarles un TTFB. Las requests y bytes por paso pueden incluir trabajo de la pantalla anterior. No se certificó INP de campo.

## Investigación de la latencia restante

Sondas desde este equipo, sin emulación móvil; medianas de tres observaciones:

- `/api/health`: TTFB **192 ms**. Script estático: **191 ms**.
- Configuración JSON: **396 ms**. Listado JSON: **677 ms**. Listado HTML: **625 ms**. Detalle JSON: **538 ms**.
- Logo y portada: TTFB **726 / 801 ms**. Incluso al revalidar con 304: **663 / 785 ms**.
- Thumbnail WebP: TTFB **526 ms**, 304 **530 ms**. Detalle WebP: TTFB **584 ms**, 304 **524 ms**. Master JPEG: TTFB **535 ms**, 304 **521 ms**.

Las rutas dinámicas cuestan más que las rutas sin lectura de inventario y las imágenes todavía necesitan autorización aun con 304. Eso es evidencia de latencia que queda en la ruta dinámica, **no una medición aislada del tiempo de PostgreSQL**. No se resta el tiempo de health para declarar el resto como SQL ni se identifica al pool como causa sin medirlo.

Se revisó Express: las rutas usan el pool compartido; las transacciones de catálogo son de solo lectura; listado usa cuatro SELECTs, detalle/imágenes tres, además de BEGIN/COMMIT. No se crea una conexión/pool nuevo por imagen. El timeout configurado es 10 s; un timeout no indica por sí mismo que se agote el pool. Las facetas y la configuración siguen leyéndose en vivo, sin cambiar consistencia para acelerar la medición.

Se detectó una conexión candidata en el archivo local de configuración y se intentó un diagnóstico con `BEGIN READ ONLY`, límites de sentencia y planes de lectura. La conexión falló con **`SELF_SIGNED_CERT_IN_CHAIN` antes de ejecutar SQL**. No se desactivó la validación de certificados. Por lo tanto no se obtuvieron EXPLAIN de producción, esperas de locks, estadísticas de consultas ni uso de conexiones. Esa configuración tampoco pudo confirmarse como la misma base que usa el proceso de Render.

No hay conector MCP de Render habilitado, CLI autenticado ni API key disponible. No se pudieron leer CPU, memoria, región, reinicios, métricas del proceso ni estadísticas del pool en Render. **No hay evidencia suficiente para atribuir el remanente a falta de CPU/RAM, distancia geográfica, suspensión o saturación del pool**, ni para recomendar un cambio de plan.

## Regresiones y cambios preparados, todavía sin publicar

Se reprodujo un fallo nuevo con un test determinista: el CTA “Explorar catálogo” navega a `#coleccion`, pero el listener de `popstate` trataba ese cambio de hash como una navegación remota, reconstruía la página y podía devolver el scroll arriba.

La corrección mantiene los hashes en el documento actual, sin pedir HTML otra vez, y conserva el comportamiento de los enlaces a fichas. Pasó en desktop y móvil. Se incrementa la versión del script a `catalog.js?v=2` para que el navegador no conserve la versión anterior durante su TTL.

También se preparó instrumentación **Server-Timing limitada al catálogo**, para que el próximo despliegue permita medir las fases reales sin instalar servicios ni exponer SQL/identificadores:

- `total`: preparación de la respuesta en el proceso Express, hasta `res.end`; excluye el tiempo posterior de transferencia al visitante.
- `db`: duración cliente de las consultas y su cantidad. Incluye transporte a PostgreSQL; no es exclusivamente tiempo del motor SQL.
- `db_setup`: adquisición de cliente y, en transacciones, BEGIN. **No equivale exclusivamente a espera del pool.**
- `db_finalize`: finalización de la transacción/liberación después del callback.
- `storage`, `encode` y `render`: carga del archivo privado, transformación y renderizado HTML, cuando ocurren. Un 304 de producto no debería incluir storage/encode.

La instrumentación conserva AsyncLocalStorage por request para no mezclar métricas entre visitas o comercios y no modifica el runtime global de base de datos. Las pruebas verifican resultados, aislamiento, errores y que las imágenes 304 hagan tres consultas pero no lean almacenamiento ni codifiquen.

Los cambios de ejecución están únicamente en `server/catalog/assets/navigation.js`, `server/catalog/render.js`, `server/catalog/router.js`, `server/commerce/catalogService.js` y el nuevo `server/catalog/timing.js`. Las demás modificaciones son tests, medidores, resultados y documentación. No hay nuevas dependencias, migraciones, cambios de inventario ni de infraestructura.

## Pruebas repetidas

Pasaron en la copia aislada basada en `0e069a3`:

- `npm run build` y `npm run build:studio`.
- Los 22 tests de dominio, imágenes y presentación pública.
- `node scripts/test-catalog-performance.mjs`: 3/24 productos, límites de consultas, stock/precios vivos, aislamiento, caché, imágenes, navegación, filtros, búsqueda, scroll y personalización. Se repitió después de agregar Server-Timing y verificó el 304 instrumentado.
- `node scripts/test-catalog-order.mjs`: galería, teclado, zoom, persistencia, pedido, cambios de precio y stock, y WhatsApp interceptado localmente. Se repitió con la instrumentación preparada.
- `node scripts/test-catalog-minimal-publication.mjs`: publicación sin fotos, productos genéricos y adición posterior de imagen.
- `node scripts/test-catalog-navigation.mjs`: test que falló antes de la corrección y pasó después, para CTA/anclas, historial y enlaces de producto en ambos viewports.
- `node --test scripts/test-catalog-timing.js`: tres tests de tiempos, concurrencia y errores.
- `git diff --check`.

Las pruebas que modifican productos se ejecutaron **solamente en PostgreSQL temporal local**. La medición pública y las sondas usan GET; no se agregaron pedidos, no se enviaron mensajes y no se escribieron datos reales.

## Próximo despliegue y pendientes separados

**Requiere autorización del usuario:** publicar la corrección del CTA y Server-Timing. Los cambios están en una copia aislada y una rama de catálogo; no se incluyeron los pendientes ajenos del directorio principal. No se pusheará a main ni se activará un despliegue antes de esa autorización.

Después de publicarlo: comprobar el nuevo SHA en health, repetir el recorrido con otra etiqueta para conservar esta evidencia, revisar Server-Timing por endpoint y confirmar el CTA en producción. `production-after.json` de esta validación describe exclusivamente `0e069a3`, no la corrección local.

Mejoras de **código** todavía evaluables con la evidencia actual:

1. Reducir las representaciones de logo y portada para móvil; hoy suman 167 KB y se entregan a 400/1600 px. Verificar calidad y ahorro con las fotos reales antes de implementarlo.
2. Revisar prefetch por hover al restaurar un listado: se observaron solicitudes que quedan en vuelo sin una visita posterior. Su costo está registrado, no se asumió que fueran navegación necesaria.
3. Con Server-Timing en vivo, separar autorización/consultas, espera inicial, carga de archivo y codificación para decidir el siguiente cambio. Evitar cambiar el pool por intuición.

Pendientes de **acceso/infraestructura**, sin causa diagnosticada ni cambios solicitados:

- Conectar Render con permisos de lectura para CPU/RAM, eventos de despliegue y latencias internas.
- Obtener una cadena de certificados confiable y confirmar la identidad de la base del servicio antes de consultar estadísticas y planes de producción en READ ONLY.
- Verificar región/latencia entre proceso, base y almacenamiento solamente con esa información. No se propusieron planes pagos ni se alteró alojamiento.

Reproducción del recorrido publicado y del resumen:

```powershell
node --use-system-ca scripts/measure-catalog-performance.mjs --production --label=production-followup --runs=3
node --use-system-ca scripts/probe-catalog-production.mjs --source=production-followup --label=production-followup-probes
node scripts/compare-catalog-production.mjs --after=production-followup --probes=production-followup-probes --output=production-followup-comparison
```

Sin opciones, el comparador usa `production-before.json`, `production-after.json` y `production-probes.json`. Los argumentos del ejemplo conservan esos archivos y generan una nueva comparación. No reemplazar la línea base. Su SHA-256 del texto, normalizado a LF, queda registrado para detectar modificaciones accidentales.
