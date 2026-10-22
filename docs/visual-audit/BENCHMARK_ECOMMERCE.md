# Benchmark de ecommerce — 22/10/2026

## Alcance y calidad de evidencia

**V:** página renderizada en Edge y captura local; **D:** documentación o contenido oficial obtenido por web, sin validar su composición visual en una sesión completa; **B:** barrera de acceso. Una marca famosa no se toma como prueba de buen diseño.

El catálogo auditado vende mediante consulta. Adoptar su claridad de navegación no exige convertirlo en checkout ni copiar funcionalidades comerciales de otras plataformas. Precios, promociones y stock de las referencias son estados de la fecha, no recomendaciones de compra.

## Referencias inspeccionadas

| Referencia y pantalla | Evidencia | Fuente / captura | Qué se puede afirmar |
|---|---|---|---|
| Nike ES, categoría Zapatillas | V | [Categoría](https://www.nike.com/es/w/zapatillas-6xge1za99xszy7ok), [1440](screenshots/ref-nike-list-1440x900.png), [390](screenshots/ref-nike-list-390x844.png) | Se vio grilla, fotos homogéneas, nombre/precio y filtros laterales en escritorio. Aviso de país visible; no se cambió ubicación |
| Nike Hybrid RN, ficha | V | [Producto](https://www.nike.com/es/t/hybrid-rn-zapatillas-de-entrenamiento-hombre-S0DIEknC/IV5066-101), [1440](screenshots/ref-nike-product-1440x900.png), [390](screenshots/ref-nike-product-390x844.png) | Se vieron miniaturas, variantes visuales y tallas disponibles/agotadas. No hubo compra, prueba de checkout ni auditoría integral de accesibilidad |
| Carrefour Argentina, home y categoría Bebidas | V | [Home](https://www.carrefour.com.ar/), [Bebidas](https://www.carrefour.com.ar/bebidas), [home](screenshots/ref-carrefour-home-1440x900.png), [categoría](screenshots/ref-carrefour-list-1440x900.png), [móvil](screenshots/ref-carrefour-home-390x844.png) | Búsqueda, categorías, acceso a carrito y contexto de entrega. No se configuró domicilio ni se verificó una compra |
| Asket, colección de hombre | V limitada | [Colección](https://www.asket.com/gb/mens), [captura](screenshots/ref-asket-list-1440x900.png) | La captura contiene aviso de cookies. No se usa como evidencia de interacción de ficha, filtros o conversión |
| UNIQLO ES, camisetas | D/B | [Categoría oficial](https://www.uniqlo.com/es/es/men/tops/t-shirts?categoryIds=85071), [bloqueo](screenshots/ref-uniqlo-list-1440x900.png) | Contenido indexado con ordenación, rangos de talla y precio. No inspección visual válida de su grilla |
| Leroy Merlin ES, taladros | D/B | [Categoría oficial](https://www.leroymerlin.es/productos/herramientas/herramientas-electricas-portatiles/herramientas-electricas-para-taladrar-atornillar/taladros/), [bloqueo](screenshots/ref-leroy-home-1440x900.png) | La fuente pública enumera atributos y filtros; navegador recibió restricción. No atribuir estética ni comportamiento observado |
| RS, taladros manuales | D/B | [Categoría oficial](https://es.rs-online.com/web/c/herramientas-manuales/herramientas-especiales/taladros-manuales/), [bloqueo](screenshots/ref-rs-list-1440x900.png) | Fuente textual con marca, código, capacidad y unidad. No se probó su selector o tabla en navegador |
| Screwfix, drills | D/B | [Categoría oficial](https://www.screwfix.com/c/tools/drills/cat830704), [bloqueo](screenshots/ref-screwfix-list-1440x900.png) | Fuente textual con datos técnicos breves por artículo. Sin valoración estética renderizada |
| Bauhaus, taladros | D/B | [Categoría oficial](https://www.bauhaus.es/taladros/c/10000161), [reto de conexión](screenshots/ref-bauhaus-list-1440x900.png) | Categoría verificada, barrera sin resolver; no patrón visual deducido del reto |
| Zara, Adidas, Home Depot | B | [Zara](https://www.zara.com/es/), [Adidas](https://www.adidas.es/), [Home Depot](https://www.homedepot.com/); `ref-zara-home`, `ref-adidas-home`, `ref-homedepot-home` | Se intentó acceso directo; no se inspeccionaron tiendas utilizables. No hay conclusiones específicas sobre sus interfaces |

Las variaciones de catálogo entre búsqueda indexada y navegador pueden reflejar fecha, país y disponibilidad. No comparar cantidades como si fueran una medición de completitud de Stocky.

## Matriz de patrones aplicables

| Referencia / pantalla | Solución y problema que resuelve | Ventaja | Límite / coste | Aplicación concreta a Stocky | Adaptación | Evidencia |
|---|---|---|---|---|---|---|
| Nike / listado, V | Fotografía del producto sobre fondos comparables y metadatos próximos | Escaneo claro sin paneles pesados | Requiere disciplina fotográfica; no demuestra que todas las tiendas necesiten el mismo encuadre | Preset Editorial: proporción y escala visual consistentes; zona de título/precio alineada | Media | [Grilla real](screenshots/ref-nike-list-1440x900.png), A19 |
| Nike / listado, V | Filtros laterales en desktop y acción Filtrar en móvil | Evita una fila de selects diminutos | Sidebar permanente no sirve para dos artículos; móvil exige foco y cierre accesibles | Mostrar filtros esenciales y agrupar secundarios conservando los datos existentes | Media | [Móvil](screenshots/ref-nike-list-390x844.png), A03/A04 |
| Nike / ficha, V | Tallas en zona comercial con agotados diferenciados | Decisión junto a producto/precio | Una matriz de tallas no sirve para presentaciones técnicas extensas | Un control real de variante, chips o select según longitud; sin fila estática duplicada | Media | [Ficha](screenshots/ref-nike-product-1440x900.png), A12 |
| Nike / ficha, V | Miniaturas junto a imagen principal y controles de galería visibles | Explorar medios sin abandonar contexto | Más UI no compensa fotos repetidas; faltan pruebas de teclado de la referencia | Actualizar foto dentro de la ficha; ampliación accesible y reversible | Media | [Ficha](screenshots/ref-nike-product-1440x900.png), A13 |
| Nike / ficha móvil, V | Nombre y precio antes de la foto | Orientación comercial sin recorrer primero toda la galería | Puede reducir inmersión editorial; aviso de país tapa parte de esta captura | Probar título/precio temprano en ficha móvil, conservando foto protagonista | Baja/media | [390](screenshots/ref-nike-product-390x844.png), A12 |
| Carrefour / home, V | Búsqueda dominante, categorías y estado comercial visibles | Orienta catálogos de muchas referencias | La campaña y múltiples barras saturan; Stocky no debe copiar esa promoción | Compacto: búsqueda/categorías al inicio, encabezado corto, selección de consulta visible | Media | [Home](screenshots/ref-carrefour-home-1440x900.png), A01/A04 |
| Carrefour / móvil, V | Búsqueda próxima a navegación principal | Reconocimiento inmediato de la tarea | No se probó domicilio ni resultados personalizados | Elevar buscar sin sumar otra barra permanente de marca | Baja/media | [390](screenshots/ref-carrefour-home-390x844.png) |
| RS / categoría, D | Código y unidad se presentan junto a datos técnicos en el contenido oficial | Identificación y comparación precisa | Evidencia textual, sin validación visual ni datos equivalentes garantizados en Stocky | Técnico: jerarquizar solo especificaciones públicas existentes; no duplicar nombre como presentación | Media | [Fuente](https://es.rs-online.com/web/c/herramientas-manuales/herramientas-especiales/taladros-manuales/), A14 |
| Screwfix / categoría, D | Resumen de pocas características concretas por producto | Reduce necesidad de abrir cada ficha | Puede generar ruido si se muestran todas las características; no se vio renderizado | Resumen técnico de dos/tres atributos pertinentes en lugar de un párrafo completo | Media | [Fuente](https://www.screwfix.com/c/tools/drills/cat830704) |
| Leroy Merlin / categoría, D | Filtros asociados a características reales del tipo de producto | Reduce ambigüedad de búsqueda técnica | No copiar taxonomía ni exigir filtros nuevos sin datos públicos existentes | Conservar facetas derivadas de catálogo; priorizar las útiles y ocultar las vacías | Media | [Fuente](https://www.leroymerlin.es/productos/herramientas/herramientas-electricas-portatiles/herramientas-electricas-para-taladrar-atornillar/taladros/) |
| UNIQLO / categoría, D | La fuente distingue título, rango de tallas y precio | Los metadatos complementan en vez de repetir | No se pudo juzgar su composición real | Separar título y presentación; evitar el chip con el nombre íntegro del SKU | Baja/media | [Fuente](https://www.uniqlo.com/es/es/men/tops/t-shirts?categoryIds=85071), A14 |
| Stocky / Mi consulta, V | Selección agrupada, actualización y advertencia sin cobro/reserva | Modelo comercial honesto y útil | Explicación llega tarde y variante se elige dos veces visualmente | Conservar flujo; explicar «Elegí productos y consultá por WhatsApp» temprano | Media | [Consulta con contenido](screenshots/prod-public-inquiry-filled-390x844.png) |

## Comparación de las tres presentaciones

### Editorial

**Conservar:** dos columnas, foto protagonista, superficie tranquila y jerarquía expresiva. **Evolucionar:** portada más contenida cuando el catálogo es corto, fotos con escala comercial comparable y precios alineados. Georgia puede ser una opción del preset, no una exigencia de moda ni un reemplazo de toda la tipografía operativa. La observación de Nike prueba el valor de las fotos consistentes; no prueba que Georgia sea superior.

### Técnico

**Conservar:** fotos menores, búsqueda agrupada y especificaciones visibles. **Evolucionar:** nombre, atributo relevante y presentación sin duplicaciones; estados legibles; ficha sin foto compacta. Las fuentes oficiales de RS/Screwfix refuerzan el valor informativo de códigos/unidades/características, pero no justifican agregar campos o filtros que Stocky no posea.

### Compacto

**Conservar:** cuatro columnas en desktop y categorías de acceso rápido. **Evolucionar:** cabecera realmente corta, menos separación antes de artículos, identificación clara de pack/contenido. No necesita copiar descuentos, clubes, entrega inmediata ni formularios de domicilio de Carrefour. No agregar «+» a tarjetas sin resolver primero la variante y el flujo de consulta.

Los tres estilos son opciones de composición: una ferretería puede elegir Editorial y una tienda de ropa Compacto. Deben conservar exactamente la misma marca, datos, publicaciones y retorno a Actual.

## Decisiones y límites

1. Adoptar fotografía coherente, filtro progresivo y selección junto a acción; no copiar diseños completos.
2. Stocky necesita un catálogo profesional orientado a consulta, no la complejidad de un supermercado nacional.
3. No inventar testimonios, garantía, envíos, descuentos o métodos de pago. Mostrar información comercial auténtica mediante los textos y campos disponibles.
4. La comparación técnica es documental debido a barreras de los sitios. Antes de una dirección artística técnica final conviene completar la validación renderizada en una sesión autorizada o con demos públicas accesibles.
5. No se usaron imágenes de referencias como contenido del producto. Las capturas se conservan únicamente como evidencia fechada de la investigación.

**Contraejemplo observado:** en la categoría Bebidas de Carrefour, la captura muestra un párrafo introductorio sobre indumentaria. Además, las primeras tarjetas aparecen muy abajo. Una plataforma madura también puede tener errores de contenido y composición; esa introducción y la acumulación promocional no se recomiendan para Stocky. [Evidencia directa](screenshots/ref-carrefour-list-1440x900.png).
