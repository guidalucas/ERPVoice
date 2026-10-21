# Etapa 3 — lotes, biblioteca y promociones locales

Base validada: `2da4c0c`, catálogo público y Studio privado. Esta etapa automatiza generación local; no conecta cuentas ni publica en Meta.

## Lotes recuperables

Selección múltiple de hasta veinte fichas preparadas. Un solo Canvas procesa cada historia secuencialmente. El lote conserva UUID propio, UUID de preparación por ficha, parámetros y progreso en almacenamiento local por propietario. Un reintento conserva exactamente la misma operación; actualizar datos de un lote vencido crea nuevos intentos explícitos.

Se genera un ZIP con nombres de archivo únicos y un límite acumulado de 32 MiB para acotar memoria. No se disparan múltiples descargas automáticas. Antes de habilitar y descargar el ZIP se revalidan todos los snapshots; cualquier cambio obliga a actualizar o corregir el lote. Cerrar la pestaña conserva el progreso/recibos, no promete conservar los buffers de imágenes: al reanudar se reconstruyen secuencialmente y se validan otra vez.

No hay worker, cola externa, tarea programada ni renderizador de navegador en backend. El stock nunca se congela ni reserva para generar contenidos.

## Biblioteca y eventos de exportación

Los snapshots existentes en `commercial_operations` constituyen el historial de preparación. `GET /api/commerce/v1/content-library` ofrece paginación acotada y DTO privado de snapshot, ficha, plantilla, fecha/expiración y último evento de exportación.

`POST /api/commerce/v1/story-snapshots/:id/export-events` registra un recibo idempotente con tipo `generated`, `download_requested` o `share_requested`, nombre de archivo, formato, tamaño y SHA-256 informado por el cliente. Nunca afirma que el archivo llegó al disco ni que fue publicado. El backend no recibe ni hospeda el PNG/JPG final.

La biblioteca permite volver a la ficha y regenerar con datos actuales. Un snapshot vencido o semánticamente inválido no habilita la descarga de una oferta obsoleta.

La migración 3 agrega únicamente un índice privado de operaciones por negocio/tipo/fecha para la biblioteca. No duplica stock, fotos ni snapshots, y conserva los checksums anteriores.

## Plantillas y promociones

Se suman diseños de jornada de fútbol y promoción, manteniendo las tres plantillas existentes. Una promoción es contenido publicitario explícito por porcentaje y período de vigencia: se deriva del precio actual de Stocky con aritmética entera y redondeo definido. No altera el precio de inventario, no crea cupones ni aplica descuentos a ventas.

El snapshot incluye importe base y promocional, porcentaje y fechas. La revalidación comprueba vigencia temporal además de stock, moneda, identidad, foto y parámetros. Se rechazan porcentajes inválidos, productos agotados, promociones fuera de vigencia y afirmaciones de última unidad incorrectas.

## Preparación Meta

Investigar solamente documentación oficial vigente y dejar un contrato/configuración deshabilitada que describa permisos, tipo de cuenta, entrega de medios y autorización requerida. No almacenar tokens, conectar cuentas, crear contenedores, publicar ni programar contenido real. Los requisitos externos se registran como habilitación pendiente y no bloquean lotes/biblioteca/promociones locales.

## Aceptación

Verificar porcentaje/redondeo/fechas con pruebas de dominio; historial y recibos aislados por negocio; reanudación y misma operación; ZIP real con PNG/JPG 1080x1920; una sola generación simultánea; cambios de precio/stock durante el lote; biblioteca veraz; navegador escritorio/móvil; regresión pública/privada/Stocky y build independiente.
