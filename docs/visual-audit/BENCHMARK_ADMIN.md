# Benchmark de administradores — 22/10/2026

## Qué se inspeccionó realmente

Stocky Studio se navegó con sesión **local de fixture**, no con una cuenta remota del comercio. Para Shopify, Tiendanube, WooCommerce y Wix se usó documentación oficial pública. No hubo cuenta privada ajena, alta de prueba, suscripción ni autorización de credenciales. Linear se vio solo como landing, insuficiente para juzgar su app. Notion/Stripe no fueron explorados; no se atribuyen observaciones a ellos.

**Conclusión:** la mejora principal frente a Studio es hacer que la tarea y sus estados gobiernen la composición: filtros identificables, grupos de edición claros y preview que sirva para decidir. Eso no requiere adoptar cada módulo de esas plataformas.

## Matriz comparativa

| Plataforma y pantalla de referencia | Patrón observado/documentado y problema | Ventaja | Límite | Aplicabilidad a Studio | Dificultad | Evidencia verificable |
|---|---|---|---|---|---|---|
| Shopify / listado de productos, documentación | Búsqueda, filtros y vistas organizan el listado; acciones masivas operan sobre una selección | Trabajar sobre subconjuntos reconocibles | No se probó su productividad ni interfaz privada. No agregar persistencia de vistas a Stocky como parte de un arreglo visual | Reorganizar filtros ya existentes, mostrar activos y selección por lote contextual | Media | [Listado](https://help.shopify.com/en/manual/products/searching-filtering), [vistas](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/searching-filtering-views) |
| Shopify / detalle y medios, documentación | Secciones de título/descripción, medios y variantes; portada definida en los medios | Agrupación reconocible de tareas relacionadas | Stocky debe mantener Stocky inventario como fuente de precio/SKU; no copiar edición duplicada | Conservar tabs de ficha, hacer más legibles portada, orden y acciones de foto | Media | [Detalle](https://help.shopify.com/en/manual/products/details/product-details-page/), [medios](https://help.shopify.com/en/manual/products/product-media/add-media) |
| Shopify / búsqueda de Admin, documentación | La ayuda avisa que ubicación de búsqueda puede variar entre diseños | Orientación consistente pese a evolución del producto | No hay base para afirmar que el Admin actual universalmente tiene una búsqueda superior fija | Elegir una ubicación estable para buscar productos en Studio, sin copiar una topbar por tendencia | Baja/media | [Búsqueda](https://help.shopify.com/en/manual/shopify-admin/admin-search) |
| Tiendanube / Diseño, guía pública renderizada | Personalización se acompaña con preview; un diseño puede adaptarse a rubros distintos al ejemplo | Evaluar identidad antes de publicar | No se operó su editor privado; disponibilidad depende de diseño/plan, irrelevante para copiar el modelo comercial | Reutilizar `AppearanceFields`; preview representativo de layout y tarjetas sin otra marca | Media/alta | [Guía](https://ayuda.tiendanube.com/diseno/guia-personalizar-el-diseno-de-tu-tiendanube), [captura de documentación](screenshots/ref-tiendanube-documentation-detail-1440x900.png) |
| WooCommerce / productos, guía pública renderizada | Organización por tipo y paneles de datos/imagen en ejemplos oficiales | Expone estructura reconocible sin obligar a llenar todo | La documentación no demuestra que un panel muy denso sea buena UX; tipos de Woo no son contratos de Stocky | Mantener campos principales breves y agrupar información específica secundaria | Media | [Gestión](https://woocommerce.com/document/managing-products/), [producto simple y ejemplo](https://woocommerce.com/document/managing-products/add-product/), [documentación](screenshots/ref-woo-documentation-detail-1440x900.png) |
| Wix Stores / opciones, ayuda pública renderizada | Opciones y variantes de producto reciben tratamiento explícito en guía y ejemplos | Distingue qué se configura y qué variante resulta | Wix anuncia transición de página de creación. No tratar un ejemplo como única UI vigente | Mejorar selección/lectura de SKU existentes, no crear otra fuente de variantes | Media | [Ayuda](https://support.wix.com/en/article/wix-stores-adding-product-options), [captura](screenshots/ref-wix-options-doc-1440x900.png) |
| Linear / landing pública | Se vio identidad y material comercial | Referencia limitada de tono sobrio | No permite medir listado, formularios ni velocidad de la aplicación | Solo orientación estética secundaria; sin puntuación comparativa funcional | No se estima | [Landing](https://linear.app/), [captura](screenshots/ref-linear-home-1440x900.png) |
| Stocky / Productos, navegación directa | Cuatro destinos, fichas, contador y lote; cabecera introductoria muy alta | Reconoce catálogo y flujo comercial existente | En móvil filtros y preámbulo dificultan operar | Compresión de cabecera y orden de filtros conservando destinos | Media | [1440](screenshots/local-studio-products-1440x900.png), [390](screenshots/local-studio-products-390x844.png) |
| Stocky / historias, navegación directa | Preview se genera de forma explícita y se valida; al editar desaparece | Exportación deliberada con validación | Recorrido de prueba largo, preview alineado al centro, plantillas por nombre | Alinear arriba, mantener vista anterior pendiente, explorar diseños visualmente | Media | [Viewport](screenshots/local-story-initial-viewport-1440x900.png), [edición](screenshots/local-story-edited-invalidated-390x844.png) |

## Qué hacen mejor estas referencias y qué conviene adoptar

**Shopify:** la documentación da entidad al listado filtrado y a la selección operativa. Studio puede mejorar mostrando selección y filtros activos junto a los productos, eliminando el mensaje de primer uso en una búsqueda sin resultados. El aprendizaje es la claridad del contexto de trabajo; no hace falta agregar un dashboard ni vistas guardadas nuevas para resolverlo.

**Tiendanube:** la personalización documentada asocia configuración y resultado visual. En Stocky el preview existente deja fuera la grilla, que justamente diferencia Editorial, Técnico y Proximidad. La evolución consiste en hacer fiable ese preview con los mismos campos y presets.

**WooCommerce:** sus ejemplos oficiales separan datos, medios y publicación. Studio ya posee información/SKU/fotos y un resumen lateral; conviene conservar esa división, agrupar acciones y marcar claramente el estado comercial. No incorporar precios editables en Studio si pertenecen al inventario.

**Wix:** la documentación hace explícitas opciones y variantes. Stocky debe aplicar esa claridad a los vínculos existentes y a la elección pública, sin cambiar sus contratos de inventario ni crear combinaciones nuevas por diseño.

## Densidad y formularios propuestos

- Cabecera con título, contador y una acción principal, seguida por búsqueda/estado. Filtros secundarios visibles cuando se necesitan, con resumen.
- Encabezados operativos de 24–30 px; cuerpo de 14–16 px; ayudas de 12–14 px contrastadas. No usar 9–10 px para explicar validez de una historia.
- Misma anatomía de input, error, guardado, selección y foco en Productos, Pendientes, fotos y configuración.
- Ficha: identidad comercial primero, SKU/fotos en sus grupos, estado y siguiente acción sin convertir todo botón en primario.
- Configuración: secciones escaneables y preview adyacente en escritorio; en móvil alternar de forma explícita entre editar y revisar si no caben juntos.
- Historias: preview estable y visible, plantillas reconocibles, controles frecuentes primero y ajuste avanzado después. Conservar exportación deliberada y revalidaciones.

## Patrones que no conviene importar

No copiar paneles de ventas si no hay datos útiles; no reducir formularios a tipografía microscópica; no añadir animaciones ornamentales; no crear un theme builder paralelo; no simular checkout, envíos o cobros. La competencia posee funciones distintas y su tamaño no es un objetivo de diseño para Stocky.

## Limitaciones

La documentación de Shopify pudo leerse mediante web, pero el navegador devolvió una verificación de conexión en la página de medios; [esa captura](screenshots/ref-shopify-media-doc-1440x900.png) es una barrera, no un Admin. Las capturas de Tiendanube/Woo/Wix son páginas de ayuda. Los ejemplos visuales incrustados, cuando se consultan, son material oficial ilustrativo: no equivalen a navegar una cuenta real. No se elaboró una tabla de puntuaciones de administradores ajenos porque faltaría evidencia comparable.
