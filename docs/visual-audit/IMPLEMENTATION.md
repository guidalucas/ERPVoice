# Implementación de las tres tandas visuales

22/10/2026. Cambios implementados y verificados en el checkout local, posteriores a la [auditoría original](STOCKY_STUDIO_VISUAL_AUDIT.md). Las capturas de `screenshots/` siguen siendo el diagnóstico previo; las nuevas están en [implementation/](implementation/). Estas últimas muestran fixtures aislados, con ilustraciones y productos de prueba, y no la tienda desplegada.

## Primera tanda: problemas evidentes

- Studio tiene búsqueda y estado en la primera fila; los filtros secundarios se despliegan con «Más filtros», con etiquetas y ancho legible en celular. La tienda usa el mismo patrón progresivo y permite limpiar filtros activos.
- La acción violeta de Studio conserva su color en hover. Los botones y campos principales tienen al menos 44 px de alto, foco visible y ayudas de 13–14 px. Se verificó contraste de texto de las ayudas y del botón en hover: 6,32:1 sobre blanco y 8,59:1, respectivamente. El botón normal tiene 6,47:1. Estos valores no constituyen una certificación integral de accesibilidad.
- Listado, Pendientes y Biblioteca separan errores de estados vacíos. La búsqueda sin coincidencias invita a limpiar filtros; un error no invita a crear la primera ficha.
- Se redujeron las cabeceras de Studio y catálogo. El banner usa un panel acotado con `contain`, conserva el texto configurado y se comprime aún más durante búsquedas.
- Ferretería y kiosco no muestran controles deportivos vacíos ni ejemplos de fútbol. Indumentaria y las fichas con datos deportivos conservan su edición. Las facetas públicas siguen representando los atributos existentes.
- El error de producto ofrece volver al catálogo del mismo comercio. En celular las acciones de sesión están agrupadas en «Cuenta».

## Segunda tanda: pantallas principales

- **Productos de Studio:** encabezado operativo, contador, estadísticas breves, Nueva ficha y tarjetas con precio y disponibilidad jerarquizados. La selección por lote conserva sus límites y elegibilidad; su acción aparece al seleccionar. Se mantienen paginación, actualización y filtros existentes.
- **Historias:** controles y preview se alinean arriba en escritorio; en celular hay vista compacta y expansión de la historia. «Comparar diseños» muestra muestras de composición con la fotografía seleccionada, mientras que el selector habitual sigue disponible. Encuadre y posición se agrupan sin eliminar controles. Generar, formato y descarga están junto al preview.
- **Edición pendiente:** cambiar una opción mantiene la imagen anterior como referencia y marca que debe regenerarse. PNG/JPG y compartir quedan bloqueados hasta aplicar los cambios. Se conserva la revalidación de producto, inventario y marca antes de exportar. Un fallo también impide descargar una referencia anterior.
- **Catálogo:** tarjetas con la misma anatomía, fotos completas, metadatos y precio legibles; las colecciones pequeñas aprovechan dos columnas. Se omiten presentaciones únicas idénticas al título en los listados, conservando su identidad completa en el selector y la consulta.
- **Galería:** las miniaturas cambian la foto dentro de la ficha, indican la actual y admiten flechas, Inicio y Fin. Ampliar abre un diálogo nativo con cierre y Escape; los enlaces a la imagen siguen siendo utilizables sin JavaScript.
- **Variantes:** hay un único selector real con agotados identificados; actualiza el precio mostrado y el enlace individual de WhatsApp. Se preselecciona cuando hay una sola presentación disponible. Cantidad y selección alimentan Mi consulta sin cambiar sus validaciones ni totales.
- **Sin fotografía:** la ficha usa un bloque honesto de 180 px en escritorio y 120 px en celular, para acercar especificaciones y acciones. Se mantienen publicación sin foto y la exigencia de foto para generar historias.

## Tercera tanda: consistencia

- Se centralizaron en `universal.css` los colores, escala de texto, espaciado e interacciones de Studio. La tienda tiene sus propios tokens y conserva los dos colores comerciales con foreground calculado.
- La personalización presenta controles junto a un preview con productos, precios y fotografías reales del catálogo. Permite comparar ancho de escritorio/celular y refleja la composición de los cuatro presets. Se conserva el selector visual de `main`: Esencial (`classic`, antes Actual), Editorial, Megatienda (`technical`) y Boutique (`local`). Las miniaturas están rotuladas como ejemplos y el preview grande usa fichas reales mediante el mismo renderizador y CSS públicos.
- Se conservaron logo, banner, fotos, textos y la opción Actual; no hay una configuración de marca paralela. Los presets evolucionan su composición sobre los contratos existentes.
- Hover, foco, selección, deshabilitado y reduced motion tienen reglas coherentes. Se corrigió un desbordamiento de 6 px en la búsqueda móvil, el solapamiento de fotos en el preview y una regla de selección que ocultaba acciones de Pendientes, detectados durante las pruebas.

La rama del MR integra `main` hasta `3cf339b`. Conserva los cambios de portada editable, textos opcionales, modo solo imagen, recuadro opcional y color sobre imagen, posiciones por arrastre/teclado, buscador técnico, filtros laterales y categorías visuales. Las portadas automáticas se compactan; la composición manual elegida por el comercio mantiene su lienzo de edición. Se repitieron build, presentación, branding, regresión visual, multirrubro y aceptación comercial sobre esta integración.

## Evidencia revisada

- [Productos a 375 px](implementation/studio-products-375x812.png) y [1440 px](implementation/studio-products-1440x900.png).
- [Filtros móviles desplegados](implementation/studio-mobile-filters-open.png) y [error del listado](implementation/studio-error.png).
- [Historias en escritorio](implementation/story-ready-desktop.png), [cambios pendientes](implementation/story-pending-desktop.png) y [celular](implementation/story-ready-mobile.png).
- [Personalización en escritorio](implementation/settings-preview-desktop.png) y [celular](implementation/settings-preview-mobile.png).
- [Catálogo en escritorio](implementation/catalog-1440x900.png), [celular](implementation/catalog-390x844.png) y [ferretería](implementation/technical-390-catalog.png).
- [Galería de producto](implementation/product-gallery-desktop.png) y [producto móvil](implementation/product-gallery-mobile.png).
- [Ferretería sin foto en celular](implementation/technical-390-without-photo.png) y [kiosco sin foto en escritorio](implementation/local-1440-without-photo.png).

Las [mediciones](implementation/measurements.json) registran el primer producto en Studio a y≈556 px en móvil, 450 px en tablet y 387 px en escritorio. En el catálogo del fixture aparece a y≈613–647 px en móvil y 542 px en escritorio. No hubo overflow horizontal en los seis tamaños. Los filtros secundarios abiertos tienen al menos 160 px de ancho en la prueba. Estas posiciones corresponden a ese contenido local sin portada; no se extrapolan al banner o a los datos de producción.

## Validación ejecutada

- `npm run build:studio`: TypeScript y build de producción correctos.
- `npm run test:commerce`: 26 pruebas aprobadas. El primer intento dentro del sandbox falló al escribir archivos temporales del supervisor; el mismo comando pasó al ejecutarse con los permisos locales necesarios. No se modificó el supervisor.
- `npm run test:commerce:presentation`: 8 pruebas aprobadas, incluyendo productos genéricos sin foto, escape de contenido y los nuevos controles de banner de `main`.
- `npm run test:commerce:browser`: 17 checks de aceptación aprobados con PostgreSQL temporal y HTTP/UI reales: PNG/JPG, promociones, publicación, recuperación de respuesta perdida, biblioteca, lotes ZIP reanudables y consultas con cambios de precio/stock.
- `npm run test:commerce:onboarding`: 8 checks aprobados: alta móvil, monedas, vinculación desde Pendientes, preparación, PNG y refresco sin sobrescribir borradores.
- `npm run test:studio:branding`: persistencia, reintento de assets, logo/banner/colores/textos públicos y revalidación de marca aprobados.
- `npm run test:studio:multirubro`: indumentaria, ferretería y kiosco, escritorio/celular, presets, fichas sin foto, aislamiento y PNG real aprobados. Comparación de inventario antes/después sin cambios.
- `npm run test:studio:templates`: cinco diseños, píxeles de fotografía, tipografía exportada, JPG, colores claros, logo, versiones históricas y limpieza tras errores aprobados.
- `npm run test:studio:visual`: nueva regresión de comportamiento y geometría en 375×812, 390×844, 430×932, 768×1024, 1440×900 y 1920×1080. Verifica filtros, contraste, teclado, vacíos/error, conservación exacta de píxeles del preview, bloqueo de exportación pendiente, PNG 1080×1920, preset/preview sin superposición, galería, diálogo, selector único e inventario intacto. Genera capturas para revisión humana; no es una comparación automática píxel a píxel contra un baseline aprobado.
- `git diff --check`: correcto.

Las capturas fueron abiertas e inspeccionadas además de medir el DOM. No se instalaron dependencias. Los fixtures se detienen y eliminan su base temporal al finalizar.

## Alcance y límites

Las tres tandas solicitadas están implementadas localmente. No se desplegó, publicó ni alteró inventario, datos o configuración de producción. No se cambiaron contratos backend ni esquemas. Las ilustraciones de prueba no reemplazan fotografías reales.

El editor de historias se rediseñó; el arte exportado y sus renderizadores históricos se conservaron. Las muestras de plantillas no prometen una promoción ni una disponibilidad: la generación real continúa validándolas.

La guía de encuadre y la ayuda de descripción están implementadas. La descripción «da» y la escala desigual de fotografías de FullMatch requieren contenido auténtico del comercio; no se reescribieron ni retocaron automáticamente. La diferencia entre el HTML desplegado `image-only` y el checkout, detectada en la auditoría, requiere verificar el despliegue posterior: las capturas actuales prueban el código local.

Se verificó Edge real con viewport emulado; quedan fuera de esta entrega Safari/iOS físico, lector de pantalla, teclado virtual y mediciones con usuarios o de conversión. No se asigna una nueva puntuación visual como si fuera una medición objetiva.
