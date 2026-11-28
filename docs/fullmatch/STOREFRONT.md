# Mejoras del catálogo de FullMatch

## Configuración en Stocky Studio

En **Configuración → Información para tus clientes** se editan dirección/retiro, Instagram, correo de contacto, medios de pago, envíos y guía de talles. También se eligen mediante casillas los logos de pago y los medios de envío/retiro. Los campos vacíos usan una invitación a consultar por WhatsApp; no se inventan costos, plazos ni medidas.

El pie del catálogo usa dos columnas en escritorio y una en celular: pagos/envíos y redes/contacto. Los iconos se sirven desde el propio sitio y también se ven en la vista previa de Studio. Las licencias y atribuciones están en `server/catalog/assets/icons`. Si el texto existente dice «Todos los medios de pago» y todavía no se eligieron logos, se muestran las seis opciones disponibles; una selección explícita, incluso vacía, tiene prioridad. Los transportistas específicos aparecen únicamente cuando se seleccionan.

Los enlaces del pie abren `/c/<tienda>/ayuda`, con las instrucciones de compra, la guía de talles y la explicación jugador/hincha para prendas. El enlace junto al selector de talle lleva directamente a la guía. El footer ya no usa el bloque de acordeones «Comprá con confianza».

En **Colecciones comerciales** se seleccionan hasta 24 fichas preparadas para Destacados y Promociones usando casillas individuales. Se pueden buscar por nombre, desmarcar sin usar Ctrl o quitar todas juntas. Solo las publicaciones públicas y válidas aparecen para clientes. Esta selección no cambia precios ni aplica descuentos.

Las secciones muestran hasta ocho productos en un carrusel manual: flechas en escritorio, desplazamiento táctil en celular y navegación con teclado. No hay avance automático. Los controles se ocultan si todos los productos entran; **Ver todas** abre la colección completa. Las imágenes conservan una proporción de 3:4 y el ancho se alinea con el catálogo, incluida la plantilla Editorial.

Novedades usa la fecha de creación de la ficha, no su última edición ni una reposición de stock. Se eligen fichas publicadas con fotos y variantes activas; después de comprobar su validez, se completa la selección con las siguientes fichas en orden de fecha hasta reunir ocho o agotar las candidatas. Los productos sin fotografía siguen disponibles en el catálogo general.

La Mystery Box se crea y publica como un producto común, con su descripción, variantes, precio y stock. No se publica una caja ni una promoción ficticia.

La información y las selecciones se guardan en `commerce_profiles.appearance`, mediante el comando comercial habitual con revisión y recibo. No requieren una migración nueva. Desplegar backend y Studio juntos antes de guardar estos campos nuevos.

## Contacto de FullMatch

El número confirmado para ventas es **5493454326660**. La reparación del contacto se aplicó con el comando comercial y se comprobó leyendo el JSON y el HTML del catálogo público. Esto verifica el destino del enlace; no demuestra que la aplicación de WhatsApp haya abierto el chat en un teléfono físico.

La carga de los datos confirmados se puede previsualizar con:

```powershell
node --use-system-ca scripts/update-fullmatch-storefront.mjs --env-file=.env.local --allow-remote-database --ca-file=.fullmatch-runtime/supabase-ca.crt
```

El archivo de entorno y el certificado son locales, no se incluyen en Git. Se conserva la verificación TLS. La herramienta exige el catálogo público `fullmatch-casacas`, la marca esperada y el contacto anterior/corregido; no muestra credenciales ni identificadores de propietario.

Después del despliegue conjunto, agregar `--apply` guarda los datos confirmados: Alvear 818, Concordia, Entre Ríos; Instagram `fmcasacas`; todos los medios de pago. Preserva los textos de envío y guía existentes, si los hay. `--contact-only --apply` limita la reparación al teléfono y es compatible con el backend anterior. Una segunda ejecución sin cambios no genera otra escritura.

## Filtros, orden y enlaces

- Los atributos explícitos siguen teniendo prioridad. En fichas antiguas sin esos atributos se recuperan equipo y versión desde los nombres activos del inventario. Nacional y Retro aparecen cuando existen; una camiseta retro versión jugador participa en ambos filtros.
- El filtro dice **Todos los talles** cuando todas las variantes tienen talle. Otros rubros conservan **Presentaciones**.
- Las equivalencias del filtro se definen en `src/shared/catalogSizes.js`: `2XL`/`XXL` se muestran como **XXL**, `XXXL`/`3XL` como **3XL**, y `XXXXL`/`4XL` como **4XL**. También se reconocen XS, XXS y sus equivalentes numéricos, hasta 9XL. Se ordenan por escala de talle y se conserva el orden natural de los talles numéricos. Las presentaciones no reconocidas conservan su texto.
- Los enlaces existentes con `variant=2XL` siguen funcionando y muestran **XXL** seleccionado. Ambas grafías buscan los mismos productos, incluso al combinar filtros o paginar. No se cambian etiquetas, IDs, precios ni stock del inventario; tampoco se fusionan SKU distintos.
- El orden por precio usa el menor precio disponible que se muestra en la ficha; si está agotada, usa el menor precio de sus variantes activas. El cursor incluye orden, valor y enlace almacenado para resolver empates sin repetir productos. Conserva los filtros al paginar.
- Los enlaces públicos usan el título actual y el sufijo estable del ID. El enlace guardado y los títulos compartidos anteriormente resuelven la misma publicación dentro del catálogo y redirigen al nombre actual. No se intercambian IDs, fotos, variantes ni publicaciones al corregir el nombre del enlace. Los accesos siguen comprobando publicación y disponibilidad de la ficha antes de servir datos o imágenes.
- El pedido reconoce enlaces anteriores de la misma variante al agregar productos. El servidor rechaza líneas duplicadas que usen diferentes nombres para la misma variante.

## Imagen al compartir

El catálogo utiliza la portada para `og:image`; si no hay portada, usa el logo, y después la primera fotografía disponible. Esa selección no depende de que el primer producto tenga foto ni de que una búsqueda devuelva resultados. Cada ficha prioriza su propia fotografía y usa portada/logo como respaldo. Pedido y ayuda también usan la imagen de marca.

Las imágenes sociales incluyen URL absoluta cuando el servidor tiene configurado `COMMERCE_CATALOG_ORIGIN`, descripción alternativa y URL segura si corresponde. Los metadatos se entregan en el HTML del servidor, y las imágenes públicas se pueden descargar sin sesión.

## Verificación

```powershell
npm run build
npm run test:catalog:storefront
npm run test:catalog:carousel
npm run test:catalog:social-sizes
npm run test:catalog:filters
npm run test:catalog:performance
npm run test:catalog:order
```

Las pruebas usan PostgreSQL descartable y Edge local. La portada agrega dos lecturas acotadas para las secciones comerciales (seis SELECT normalmente); puede buscar tandas adicionales cuando hay fichas invalidadas por cambios del inventario. Los listados filtrados conservan cuatro y el detalle una. Las capturas se escriben en `.fullmatch-runtime/storefront` y `.fullmatch-runtime/carousel`.
