# Banner completo en modo «solo imagen»

El límite de 320 px de alto combinado con `aspect-ratio: 16/9` encogía la portada: a 1440 px de viewport ocupaba 568,875 px dentro de un contenido de 1216 px. Se reprodujo con el banner real antes de aplicar la corrección.

En modo solo imagen, la portada ahora ocupa todo el ancho del contenido y la imagen determina su altura con su proporción natural. Se elimina el lienzo fijo y la posición absoluta de la imagen en ese modo. Las portadas con texto y la composición manual mantienen sus reglas. Sin imagen cargada se conserva un fondo de 120 px.

Se probaron los dos archivos provistos por el usuario, de 1920×949 y 1920×1080, mediante el flujo existente de carga de portada en un fixture local. Para 1216 px de ancho, sus alturas renderizadas son aproximadamente 601 y 684 px: mostrar todo el diseño a ese ancho requiere esa altura. No se impone un límite que reduzca el ancho ni se recorta el contenido.

Validación:

- Esencial, Editorial, Megatienda y Boutique.
- Catálogo público y preview de Studio, en 1440×1000 y 390×844: 32 combinaciones.
- Miniaturas de los cuatro diseños con la misma imagen.
- Ancho igual al área de contenido, proporción natural, ausencia de lienzo sobrante y de overflow horizontal.
- Inventario sin cambios y sin errores JavaScript.
- Build de Studio y ocho pruebas de presentación aprobados.

`npm run test:studio:banner` reproduce la regresión con dos imágenes sintéticas que incluyen marcas en los bordes. También admite rutas de archivos locales como argumentos. Las imágenes reales del usuario y sus capturas permanecen en `.fullmatch-runtime/banner-fit/`, que está ignorado por Git; no se incluyen en el repositorio.
