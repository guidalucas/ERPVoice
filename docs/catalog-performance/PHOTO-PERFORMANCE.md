# Primera carga de fotos del catálogo

11 de noviembre de 2026. Candidato preparado sobre `6444d97`, la versión observada en producción al tomar la muestra. La medición anterior registró 1.137 ms en Sharp y 187 ms en almacenamiento para un detalle WebP sin caché.

La ficha y las imágenes ahora consultan catálogo, publicación, variantes, precios, stock y metadatos en un solo `SELECT`. PostgreSQL proporciona un snapshot coherente para la sentencia, por lo que estas lecturas eliminan los comandos separados de `BEGIN` y `COMMIT`. La misma validación de disponibilidad comercial y de alcance por comercio se aplica antes de responder 200 o 304. [Aislamiento de transacciones de PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html)

El detalle WebP usa esfuerzo 2 con calidad 80 y el límite de 960 × 1200. Su ETag tiene una versión propia para revalidar la representación nueva. Los bytes inmutables pueden permanecer una hora en la caché del proceso, con el límite existente de 32 MiB. El servidor comprueba el estado público y la identidad del producto antes de acceder a esos bytes. [Opciones WebP de Sharp](https://sharp.pixelplumbing.com/api-output/#webp)

## Mediciones

- **Transformación de fotos.** Cuatro másteres JPEG públicos se procesaron localmente en memoria. Cinco repeticiones por foto y nivel de esfuerzo, después de calentar cada configuración. Cambiar de esfuerzo 4 a 2 redujo las medianas individuales entre 33 % y 48 %. El peso aumentó entre 1,7 % y 2,3 %. El PSNR frente a la referencia redimensionada bajó entre 0,32 y 0,41 dB. Se eligió ese punto para contener el aumento de bytes en móvil. [Muestras de codificación](image-encoding-benchmark.json)
- **Lectura de fichas.** La misma base PostgreSQL descartable respondió a ambas versiones con datos idénticos. Cinco comandos SQL pasaron a uno. Las medianas sin demora añadida fueron 8,0 y 3,1 ms. Con 60 ms simulados por comando fueron 311,6 y 76,8 ms. [Muestras de lectura](read-roundtrips-benchmark.json)
- **Revalidación de fotos.** Cinco comandos pasaron a uno. Las medianas fueron 7,3 y 4,5 ms sin demora añadida, y 310,5 y 77,6 ms con 60 ms simulados. El almacenamiento de prueba rechaza cualquier lectura durante el 304. [Muestras de revalidación](read-roundtrips-benchmark.json)

La demora de 60 ms aproxima el orden de magnitud observado en las fases de transacción de producción. Las cifras resultantes miden el servicio local y su ahorro de comandos. El tiempo de carga que verá el visitante se medirá con el candidato publicado.

## Verificación y publicación

Pasaron el build, 25 tests de dominio, imágenes, presentación y tiempos, y las pruebas de catálogo y pedidos con PostgreSQL local. La prueba HTTP verifica que se sirvan bytes cacheados sin codificación, que un 304 haga una sola consulta y que deshabilitar el catálogo, ocultar el producto o invalidar su precio bloquee la foto. También verifica el aislamiento, la galería, el zoom y los pedidos.

La rama `codex/catalog-photo-performance` contiene el candidato. La publicación en `main` requiere la autorización indicada para este catálogo. Después de publicar, verificar el SHA y repetir el recorrido móvil y desktop con una etiqueta nueva. En las respuestas de detalle y de imagen, comprobar la cantidad de consultas y registrar `encode` cuando haya una transformación real.

Comandos de reproducción de las mediciones locales y del recorrido posterior a la publicación.

```powershell
node --use-system-ca scripts/benchmark-catalog-image-encoding.mjs
node scripts/benchmark-catalog-read-roundtrips.mjs --base=6444d97
node --use-system-ca scripts/measure-catalog-performance.mjs --production --label=production-photo-after --runs=3
```

El primer comando toma las rutas de fotos de `production-after.json`. La muestra de este informe se seleccionó con `--source=production-followup` a partir de la medición posterior al despliegue anterior.
