# Mejoras del catálogo de FullMatch

## Configuración en Stocky Studio

En **Configuración → Información para tus clientes** se editan dirección/retiro, Instagram, medios de pago, envíos y guía de talles. Los campos vacíos usan una invitación a consultar por WhatsApp; no se inventan costos, plazos ni medidas. La explicación del calce jugador/hincha se muestra en catálogos de prendas con talles.

En **Colecciones comerciales** se seleccionan hasta 24 fichas preparadas para Destacados y Promociones. Solo las publicaciones públicas y válidas aparecen para clientes. Esta selección no cambia precios ni aplica descuentos. Las portadas muestran hasta cuatro productos por sección; **Ver todos** abre la colección completa. Novedades usa la fecha de creación de la ficha, no su última edición ni una reposición de stock.

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
- El orden por precio usa el menor precio disponible que se muestra en la ficha; si está agotada, usa el menor precio de sus variantes activas. El cursor incluye orden, valor y enlace almacenado para resolver empates sin repetir productos. Conserva los filtros al paginar.
- Los enlaces públicos usan el título actual y el sufijo estable del ID. El enlace guardado y los títulos compartidos anteriormente resuelven la misma publicación dentro del catálogo y redirigen al nombre actual. No se intercambian IDs, fotos, variantes ni publicaciones al corregir el nombre del enlace. Los accesos siguen comprobando publicación y disponibilidad de la ficha antes de servir datos o imágenes.
- El pedido reconoce enlaces anteriores de la misma variante al agregar productos. El servidor rechaza líneas duplicadas que usen diferentes nombres para la misma variante.

## Verificación

```powershell
npm run build
npm run test:catalog:storefront
npm run test:catalog:filters
npm run test:catalog:performance
npm run test:catalog:order
```

Las pruebas usan PostgreSQL descartable y Edge local. La portada agrega dos lecturas acotadas para las secciones comerciales (seis SELECT en total, independientemente del número de tarjetas de la página); los listados filtrados conservan cuatro y el detalle una. Las capturas del flujo nuevo se escriben en `.fullmatch-runtime/storefront`.
