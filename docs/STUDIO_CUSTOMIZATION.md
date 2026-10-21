# Stocky Studio: marca, catálogo y plantillas

Stocky Studio es el nombre del producto. El nombre, logo y textos del comercio se configuran por negocio en **Configuración**. FullMatch puede seguir siendo el nombre de un comercio, pero no es una marca fija de la herramienta.

## Personalización

La configuración permite cargar logo y portada, elegir fondo y acento, y editar frase de marca, título y descripción de portada y título de la colección. La vista previa muestra el borrador; **Guardar configuración** lo aplica al negocio. Habilitar el catálogo y publicar fichas siguen siendo acciones independientes.

El catálogo usa toda esa identidad. Las nuevas historias usan nombre, logo, colores y frase de marca. Cambiar esos datos invalida una historia preparada con otra identidad y exige generarla otra vez. Los archivos ya descargados son imágenes estáticas.

Las imágenes admiten JPG, PNG y WebP de hasta 12 MB y 24 megapíxeles. El servidor valida los bytes, aplica orientación, elimina metadatos y reduce el logo a 400 × 400 como máximo, conservando transparencia, y la portada a 1600 × 1000. Cada archivo procesado tiene un límite de 1 MB. Se guardan como archivos inmutables en PostgreSQL (`commerce_brand_assets`) separados del perfil; los endpoints comprueban negocio y permisos. La vista pública solo expone las imágenes actualmente seleccionadas de un catálogo habilitado. Quitar una imagen la desvincula, conservando el archivo para historias y recibos anteriores.

## De dónde salen las plantillas

Son cinco diseños programados, no diseños descargados de un proveedor ni generados con IA:

- `server/commerce/storyService.js`: identifica las plantillas, define encabezados y valida stock, precios, promociones y la afirmación de última unidad.
- `src/studio/storyRenderer.ts`: dibuja foto, logo, títulos, precio y CTA sobre Canvas 2D de 1080 × 1920. Exporta PNG/JPG. Las plantillas comparten la composición base y varían encabezados, colores y detalles.
- `src/studio/StoryEditor.tsx` y `BatchStudio.tsx`: controles de edición, selección y generación.
- `server/catalog/render.js` y `server/catalog/assets/catalog.css`: página pública generada con HTML/CSS. Es independiente del renderizador de historias.

Para mejorar el aspecto de las historias se cambia el renderizador Canvas. Para agregar un diseño se lo registra en el servicio y en los selectores de historia/lote y se implementa su composición en el renderizador. Los cambios incompatibles deben aumentar `rendererVersion` y conservar el tratamiento de snapshots anteriores. Los estilos del catálogo se cambian en sus archivos HTML/CSS; los textos y la identidad ya pueden modificarse desde Configuración.

## Actualización del esquema

Esta función requiere la migración comercial **4**, sin cambios al inventario. El bundle `docs/fullmatch/SUPABASE_COMMERCIAL_SCHEMA.sql` incluye las migraciones 1 a 4 y es idempotente. También se puede usar `npm run commerce:appearance:schema:check` y `npm run commerce:appearance:schema:apply` con `COMMERCE_DATABASE_URL` explícita; destinos remotos requieren la opción `--allow-remote-database`. El servidor no ejecuta DDL al guardar la configuración.

Prueba integral con PostgreSQL temporal y navegador: `npm run test:studio:branding`. Comprueba aislamiento, permisos, persistencia, vista móvil, catálogo e imagen exportada.
