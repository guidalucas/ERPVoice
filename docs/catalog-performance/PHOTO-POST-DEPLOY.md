# Validación de fichas y fotos en producción

Render sirvió el commit [`7c6955e`](https://github.com/guidalucas/ERPVoice/commit/7c6955e76f74d4ba1a02fff3571c9c00d625a2a6) desde las 10:22 de Uruguay del 11 de noviembre de 2026, según la primera comprobación pública exitosa. El SHA coincidió al empezar y terminar las mediciones. [Comprobación del despliegue](production-photo-release.json)

## Comparación con `6444d97`

Se repitieron 108 muestras de navegación con tres corridas de escritorio y tres de móvil simulado. El perfil móvil usó 390 × 844, CPU ×4 y 200.000 bytes/s de descarga. Se hicieron además 36 sondas HTTP secuenciales de lectura. El recorrido registró cero errores HTTP o de solicitud. [Recorridos](production-photo-after.json) · [Sondas](production-photo-after-probes.json) · [Comparación completa](production-photo-comparison.json)

- La primera ficha visible bajó de **878 a 370 ms** en escritorio y de **896 a 509 ms** en móvil. Las dos fichas siguientes se vieron en 349–355 ms en escritorio y 373–375 ms en móvil.
- La ficha con fotos mostró las imágenes visibles en **1,32 → 0,83 s** en escritorio y **2,42 → 1,94 s** en móvil, con caché del navegador vacía. La revisita en móvil pasó de **903 a 413 ms**.
- El TTFB mediano de la API de ficha bajó de **511 a 255 ms**, con tiempo interno de **311 a 68 ms**. Para la misma foto de detalle, el TTFB con los bytes en caché bajó de **527 a 262 ms**. Las tres revalidaciones devolvieron **304** sin cuerpo y el TTFB mediano bajó de **532 a 256 ms**.
- La ficha y la foto registraron una consulta SQL en cada sonda. El TTFB mediano del listado JSON fue 660 → 653 ms. El LCP del listado móvil fue 2,396 → 2,404 s.

## Primera transformación observada

Antes de los recorridos se consultó la misma foto de detalle que había registrado 1.137 ms en Sharp. La solicitud de la nueva versión volvió a transformar la imagen. La fase de Sharp bajó de **1.137 a 897 ms**, y los bytes del archivo subieron de 187.880 a 191.094. El tiempo total interno de esa solicitud subió de **1,66 a 1,81 s**, con **846 ms** en almacenamiento frente a **187 ms** en la observación anterior. La solicitud siguiente reutilizó los bytes y tardó **69 ms** dentro del servidor. [Desglose de la foto](production-photo-smoke.json)

El adaptador incluye la comprobación del bucket privado y la descarga en la fase de almacenamiento cuando inicializa el acceso. El encabezado actual agrupa ambas operaciones. Hay una observación de transformación en frío para cada versión y la caché del servidor estuvo en uso durante los recorridos. Estas muestras establecen una mejora de navegación y revalidación. El costo de la primera foto tras un fallo de caché sigue variando con el almacenamiento.
