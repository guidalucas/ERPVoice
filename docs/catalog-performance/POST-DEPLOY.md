# Despliegue autorizado y validación posterior

El usuario autorizó publicar los dos commits preparados. Se pushearon a `main` y se confirmó que producción sirve **`6444d97a0a6e6598b3aa23d1bc6e72d853ab4afb`**. La nueva versión se observó el 9 de noviembre de 2026 a las 22:26 de Uruguay (01:26 UTC del día 10).

No se cambiaron inventarios, esquema, planes, variables ni servicios. No se reinició ni purgó manualmente el servidor. No hubo un segundo despliegue para generar estos resultados.

## Qué se comprobó

- SHA esperado en `/api/health`, HTTP 200, y la misma versión antes y después de las mediciones.
- HTML con `catalog.js?v=2` y encabezados Server-Timing en las respuestas reales.
- Apertura de ficha y regreso al catálogo sin recarga de documento, en escritorio y móvil; sin errores JavaScript en el smoke test.
- El CTA está oculto en la configuración actual del comercio. No se cambió esa configuración para probarlo: su corrección pasó los tests locales en ambos viewports, y el código corregido está publicado, pero no se pudo accionar un CTA visible en este comercio.
- 108 muestras de navegación y 36 sondas secuenciales de endpoints, con revalidaciones adicionales de imágenes. No se registraron errores HTTP/request en los datos completos del recorrido.

## Resultado real antes → versión desplegada

Mismas condiciones de navegador que en la comparación anterior: escritorio 1440 × 900; móvil 390 × 844, DPR 2, CPU ×4, latencia 80 ms y descarga/subida 200.000/100.000 bytes/s. Tres repeticiones nuevas por viewport, frente a una observación histórica por viewport.

- **TTFB inicial del listado:** escritorio **7,412 → 0,661 s**; móvil **7,389 → 0,582 s**.
- **Primera ficha visible:** escritorio **1,226 → 0,878 s**; móvil **1,387 → 0,896 s**.
- **Segunda/tercera ficha:** escritorio **0,863 / 0,859 s**; móvil **0,889 / 0,885 s**.
- **Primera vuelta al catálogo visible:** escritorio **7,294 s → 49 ms**; móvil **7,405 s → 92 ms**. El snapshot se muestra antes de terminar la revalidación; esos milisegundos no son el tiempo de la consulta del inventario.
- **LCP inicial:** escritorio **8,136 → 1,612 s**, máximo nuevo 2,124 s; móvil **9,052 → 2,396 s**, máximo nuevo **2,484 s**. Son tres muestras por viewport: no garantizan un p75/p95 de usuarios reales menor de 2,5 s.
- **Ficha con fotos:** imágenes visibles listas en **1,324 s desktop / 2,417 s móvil** en el escenario de primera visita de cada contexto; al revisitar en caliente, **0,894 / 0,903 s**.
- Los tiempos son compatibles con la mejora ya observada en `0e069a3`; no aparece una regresión material de navegación en esta muestra tras publicar la corrección y la instrumentación.

Se conservaron `production-before.json` y `production-after.json`; no se sobrescribieron los resultados históricos. La comparación nueva usa `production-followup.json` y corresponde exclusivamente al commit `6444d97`.

## Qué reveló Server-Timing

Ahora se dispone de tiempos del proceso que sirve producción, en vez de inferirlos restando latencias externas.

Para las seis cargas iniciales de listado, el tiempo interno total estuvo entre **375,5 y 474,2 ms**. La fase de consultas estuvo entre **251,0 y 337,2 ms**, con cuatro consultas; adquisición de cliente más BEGIN entre **57,3 y 67,3 ms**, y finalización entre **57,1 y 66,3 ms**. Renderizar HTML tomó **0,2–0,4 ms**. La mayor parte de la latencia de esa ruta está en los tramos de consultas/transacción, no en construir el HTML.

`db` incluye transporte y espera vistos desde el cliente PostgreSQL; **no es tiempo puro del motor SQL**. `db_setup` incluye adquisición de cliente y BEGIN; **no es espera pura del pool**. Estos datos no demuestran que PostgreSQL esté gastando CPU en planes lentos, que el pool esté saturado ni que exista una región incorrecta. Para separar esas causas siguen faltando planes y métricas de base/infraestructura.

La primera carga del proceso registrada por el smoke tuvo nueve consultas —incluye la inspección de esquema que se ejecuta una vez— y 966,5 ms internos. Después, el listado volvió a cuatro consultas. Esa inspección inicial no es un N+1 por producto.

### Imagen con fallo de caché

Se obtuvo una observación clara de la variante de detalle WebP:

- Preparación total en el servidor: **1.662,1 ms**.
- Consultas: **202,5 ms**; setup **66,8 ms**, finalización **67,1 ms**.
- Carga del archivo privado: **187,1 ms**.
- Fase de Sharp: **1.137,3 ms**.

La fase `encode` comprende decodificación, redimensionado, codificación y esperas internas del trabajo nativo; no es una medida aislada del codec ni de CPU de Render. Aun así, esta observación identifica trabajo de transformación bajo demanda que perjudica la primera foto. En las lecturas siguientes no aparecen `storage` ni `encode` para esa variante: se reutilizan los bytes preparados. Las imágenes 304 siguen validando publicación y preparación, con tres consultas, pero sin descargar el archivo privado ni volver a codificarlo.

Se observaron también algunos tiempos de `db_setup` altos —hasta 611,6 ms para una imagen y 538,8 ms para una imagen de marca—. No permiten separar adquisición, conexión y BEGIN. Deben investigarse con métricas del pool antes de aumentar su tamaño.

## Próximas optimizaciones justificadas por evidencia

1. Sacar la transformación del camino de la primera lectura, o medir configuraciones más rápidas de Sharp con calidad y tamaño reales. La observación de 1,14 s en esa fase justifica esa evaluación; no se implementó otro cambio de imágenes en este despliegue aprobado.
2. Reducir viajes de lectura/autorización manteniendo el snapshot consistente y el aislamiento del comercio. El listado y las fotos concentran su tiempo interno en las fases de base/transacción. Cualquier reducción debe conservar precios y stock actuales y revocación de imágenes.
3. Revisar las representaciones de logo/portada y el costo de leerlas incluso para un 304; siguen teniendo un peso importante.

No hay evidencia para contratar otro plan de alojamiento. El acceso interno a Render sigue sin estar disponible y la conexión SQL configurada sigue pendiente de una cadena TLS confiable e identificación del destino. No se debilitó TLS para obtener métricas.

## Evidencia reproducible

- [Versión observada después del push](production-release.json).
- [Smoke test público en ambos dispositivos](production-smoke.json).
- [108 muestras posteriores al despliegue](production-followup.json).
- [Sondas de endpoints, imágenes y 304](production-followup-probes.json).
- [Comparación con la línea base](production-followup-comparison.json).
- [Resumen de fases internas y muestras de codificación](production-server-timing.json).

Las limitaciones de la comparación anterior siguen aplicando: muestras pequeñas, caché fría del navegador pero no reinicio del servidor, estado de caché del servidor sin controlar, tráfico de prefetch que puede cruzar ventanas y ausencia de una medición certificada de INP de campo. Los tiempos de imagen son disponibilidad conjunta de las imágenes visibles, con decodificación y dos frames; la línea base no tenía una medida equivalente independiente de imágenes.
