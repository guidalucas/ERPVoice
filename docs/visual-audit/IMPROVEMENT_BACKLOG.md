# Backlog visual propuesto

**Estado:** no implementado. **Fecha:** 22/10/2026. Todos los ítems remiten al [informe y evidencia A01–A22](STOCKY_STUDIO_VISUAL_AUDIT.md#7-hallazgos-verificables).

**Seguimiento posterior:** este es el backlog original del diagnóstico. Consultar [la implementación de las tres tandas](IMPLEMENTATION.md) para el alcance realizado, las pruebas y los límites pendientes de contenido y despliegue.

P1 = primera iteración por fricción o lectura; P2 = mejora importante tras corregir base; P3 = consolidación. No se usa P0: no se reprodujo un bloqueo visual crítico general. Impactos altos/medios son juicio de diseño, no medición de conversión. Complejidad baja/media/alta es relativa y necesita estimación del equipo una vez aprobado el alcance.

## Quick wins

| ID / hallazgo | Propuesta concreta | Impacto visual | Usabilidad | Complejidad | Reutilización multirrubro | Prioridad | Dependencias | Componentes | Aceptación |
|---|---|---|---|---|---|---|---|---|---|
| V01 / A03 | Ancho legible de filtros móviles; agrupar secundarios | Alto | Alto | Baja/media | Alta | P1 | Ninguna; preservar todas las opciones | [ProductList](../../src/studio/Studio.tsx), [CSS universal](../../src/studio/universal.css) | Ningún select de ~61 px; etiqueta/valor reconocibles a 375/390/430 |
| V02 / A09 | Elevar ayuda a 12–14 px y token secundario contrastado | Medio | Alto | Baja | Alta | P1 | Verificar superficies reales | [stories.css](../../src/studio/stories.css), ayudas relacionadas | Ayudas normales ≥4,5:1; sin pérdida de contenido |
| V03 / A10 | Hover/foco de acción violeta coherentes | Medio | Alto | Baja | Alta | P1 | V02 criterios de contraste | [studio.css](../../src/studio/studio.css), universal.css | Normal/hover/foco ≥4,5:1; no naranja heredado |
| V04 / A16–A17 | Separar vacío inicial, búsqueda vacía, carga y error | Medio | Alto | Baja/media | Alta | P1 | Estado de búsqueda y error ya existentes | ProductList / Notice | Error nunca invita a crear primera ficha; búsqueda ofrece limpiar |
| V05 / A21 | Copy genérico y detalles deportivos contextuales | Medio | Medio | Baja | Alta | P1 | Mantener edición de fichas deportivas | Fields / StoryEditor | Taladro sin placeholder deportivo; datos de FullMatch conservados |
| V06 / A18 | Revisar descripción real incompleta y guía de copy | Alto en FullMatch | Medio | Baja contenido / media guía | Media | P1 contenido, P2 guía | Texto aprobado por comercio; no editar producción en esta tarea | Fields / `.product-description` | Descripción auténtica útil o ausencia tratada honestamente |
| V07 / A22 | Regreso al catálogo en error de producto | Medio | Medio | Baja | Alta | P2 | Contexto de tienda conocido | [renderCatalogError](../../server/catalog/render.js) | Ruta real inexistente ofrece una salida accionable |
| V08 / A11 | Ampliar blancos táctiles sin reducir texto | Medio | Alto | Baja/media | Alta | P1 | Validar labels y espaciado, no solo input | sidebar / mobile-session / shop-cart | Acciones frecuentes cercanas a 44 px; foco y separación claros |

## Mejoras importantes

| ID / hallazgo | Propuesta concreta | Impacto visual | Usabilidad | Complejidad | Reutilización multirrubro | Prioridad | Dependencias | Componentes | Aceptación |
|---|---|---|---|---|---|---|---|---|---|
| V09 / A01–A02 | Portada proporcionada y mensaje accesible | Alto | Alto | Media | Alta | P1 | Identificar fuente desplegada `image-only`; revisar banner real | renderCatalogList / catalog.css | Productos temprano a 1440×900; mensaje disponible sin imagen; no recortar texto de banner |
| V10 / A05 | Cabecera operativa breve con contador y Nueva ficha | Alto | Alto | Media | Alta | P1 | V01/V04 | Studio / ProductList | Primera ficha más arriba; mantener acciones, estadísticas y filtros |
| V11 / A04 | Filtros públicos progresivos y selección activa limpiable | Medio | Alto | Media | Alta | P2 | V09; facetas existentes | renderCatalogList / catalog-filters | Identificar y quitar filtros; no ocultar campos necesarios |
| V12 / A06–A07 | Layout de historias alineado y preview anterior pendiente | Alto | Alto | Media | Alta | P1 | V02/V03; conservar validación/exportación | [StoryEditor](../../src/studio/StoryEditor.tsx), stories.css | Preview completo+acción a 1440×900; cambio no borra referencia ni habilita exportación obsoleta |
| V13 / A08 | Mostrar las plantillas actuales visualmente | Medio | Alto | Media | Alta | P2 | V12; distinguir elegibilidad real | StoryEditor / PromotionFields / renderizadores | Identificar diseño antes de generar; ninguna oferta inventada |
| V14 / A12 | Un único selector real y jerarquía de consulta | Alto | Alto | Media | Alta | P1 | Mantener contrato de presentaciones y consulta | renderCatalogProduct / [cart.js](../../server/catalog/assets/cart.js) | Selección visible determina agregado; agotados claros; sin promesa de cobro/reserva |
| V15 / A13 | Galería que cambia imagen sin abrir pestañas sueltas | Alto | Alto | Media | Alta | P2 | Dos/ocho fotos fixture; teclado/foco | renderCatalogProduct / public-gallery | Miniaturas dentro de ficha; ampliar/cerrar de forma accesible |
| V16 / A14 | Presentaciones breves, no redundantes, sin alterar identidad SKU | Alto | Alto | Media | Alta | P1 | Definir regla visual de coincidencia; sin inventar atributos | ProductList / renderCatalogList/Product / [storyRenderer](../../src/studio/storyRenderer.ts) | Título largo una vez; labels completos disponibles donde son necesarios |
| V17 / A15 | Configuración agrupada y preview representativo del preset | Alto | Alto | Media/alta | Alta | P2 | V09/V18/V20; una sola configuración | [Branding](../../src/studio/Branding.tsx) / Settings | Preview refleja grilla/filtros/portada y ancho; guardar mantiene todos los campos |
| V18 / A19 | Anatomía de tarjeta y medios coherentes para pocos artículos | Alto | Medio | Media | Alta | P2 | V09/V16; guía fotográfica del comercio | catalog-grid / catalog-card | Precio y metadatos comparables; fotos sin recortes involuntarios |
| V19 / A20 | Fallback de ficha sin foto proporcionado | Alto | Medio | Media | Alta | P2 | V16/V18 | main-photo / no-photo | Especificaciones y acción temprano sin imagen falsa; publicación sin foto preservada |

## Evolución estratégica

| ID | Propuesta | Impacto visual | Usabilidad | Complejidad | Reutilización | Prioridad | Dependencias | Componentes | Aceptación |
|---|---|---|---|---|---|---|---|---|---|
| V20 | Consolidar tokens de tipografía, espacio e interacción de Studio | Alto | Alto | Media | Alta | P2 | V01–V04 como casos de referencia | studio.css / universal.css / refinements.css / automation.css / stories.css | Un mismo botón/campo tiene mismos estados; no recurrencia de overrides contradictorios |
| V21 | Contratos visuales Editorial/Técnico/Compacto sobre presets actuales | Alto | Alto | Media/alta | Alta | P2 | V09/V11/V16/V18/V19 | catalog.css / AppearanceFields | Composición distinta y útil en móvil/desktop, sin cambiar datos ni restringir por rubro |
| V22 | Baseline visual por estado y contenido representativo | Medio | Alto | Media | Alta | P3 | Capturas aprobadas tras implementación, no antes | Scripts de captura/fixtures ya existentes y de esta auditoría | Comparar seis viewports + tres rubros; revisión humana de diffs; no tomar cero overflow como aprobación completa |
| V23 | Guía editorial de fotos/texto para comercios | Alto | Medio | Baja/media | Alta | P2 | Responsabilidad y contenido del comercio | Ayudas en fotos/Fields; documentación | Ejemplos de escala/encuadre y texto auténtico; sin fotos generadas que alteren producto |

## Secuencia y dependencias

1. **Acordar baseline:** fuente real de Studio, diferencia live/local y contenido comercial de ejemplo.
2. **V01–V08:** legibilidad, estados e identidad de interacción. V06 contenido requiere participación de FullMatch en una tarea posterior.
3. **V09, V10, V12, V14 y V16:** mayor impacto sobre catálogo temprano, trabajo diario y selección. Pueden diseñarse en paralelo una vez acordados tokens, sin necesidad de nuevos contratos backend.
4. **V11, V13, V15, V17–V19:** completar filtros, plantillas, galería, configuración y medios.
5. **V20–V23:** consolidar y evitar regresiones. Los tokens pueden definirse antes, pero la consolidación se valida con componentes y estados reales.

## Condiciones para cerrar la implementación futura

- Mantener funcionalidad de marca y «Actual», IDs/SKU, inventario, precios, contactos y exportación.
- Revisar 375×812, 390×844, 430×932, 768×1024, 1440×900 y 1920×1080 con contenido representativo.
- Validar controles mediante teclado, foco, touch y lector de pantalla; contraste normal y estados; reduced motion.
- No cerrar V12 solo porque el canvas aparece: deben verificarse edición pendiente, regeneración, descarga bloqueada y validación de datos.
- No cerrar V21 con capturas de diferentes productos: comparar mismo contenido, colores y medios entre los cuatro presets y al volver a Actual.
- No estimar mejora de conversión hasta medir tareas/consultas reales con consentimiento apropiado.

**Fuera de este backlog visual:** reescritura de plataforma, nuevo motor de temas, nuevas entidades de marca, checkout/pagos/envíos, migraciones productivas, edición automática de inventario, políticas comerciales inventadas y generación de fotos reales de productos.
