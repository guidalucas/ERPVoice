# Recuperación de base y fotografías

Este procedimiento es del operador de la instalación. El alta de un negocio no requiere backups manuales, SQL ni acceso al hosting de parte del cliente. La existencia de este documento no acredita una restauración productiva ejecutada.

## Preparar una copia consistente

1. Registrar fecha, versión desplegada y proyecto de origen; verificar que se está usando la base de Stocky y su bucket privado. Registrar la retención y los permisos realmente configurados, sin copiar secretos al repositorio.
2. Usar la herramienta de backup de la infraestructura o `pg_dump` con formato custom. Pasar credenciales mediante un servicio PostgreSQL/archivo de credenciales protegido, nunca en logs o capturas. Verificar el código de salida y que `pg_restore --list` pueda leer el archivo.
3. Guardar también las fotografías originales/derivadas referidas por `commercial_product_images.master_key` y `thumbnail_key`, con su ruta completa y hash. Un backup de PostgreSQL por sí solo no garantiza recuperar los bytes del bucket. Incluir objetos pendientes si se pretende recuperar intentos de carga.
4. Para una copia coherente entre SQL y objetos, detener temporalmente las escrituras y el mantenimiento de fotos en la ventana de captura, o usar las capacidades de snapshot/versionado efectivamente configuradas. Registrar ese intervalo. Conservar además fotos retiradas dentro del período de recuperación definido.
5. Cifrar y restringir el backup: contiene teléfonos, datos del negocio, stock e historial. Mantener una copia fuera del recurso que se está protegiendo y verificar su integridad.

## Ensayar la restauración sin sobrescribir producción

1. Elegir una base vacía de prueba, un bucket privado distinto y un servicio aislado. Verificar por escrito sus identificadores. No usar `--clean` contra una base compartida ni cambiar la conexión de producción para probar.
2. Restaurar el dump con `pg_restore --no-owner --no-acl --exit-on-error` contra ese destino. Aplicar/revisar los permisos y RLS requeridos por las migraciones; no habilitar acceso anónimo a tablas privadas.
3. Restaurar los objetos conservando exactamente sus claves, en el bucket de prueba. Verificar hashes del master y lectura/procesamiento de las derivadas. No copiar credenciales de producción al frontend.
4. Configurar la aplicación de prueba contra esos recursos. Deshabilitar llamadas Meta/WhatsApp y otras integraciones externas; no contactar clientes durante el ensayo. Usar sesión de prueba y restringir el catálogo restaurado al entorno aislado.
5. Ejecutar inspección de esquema, comparar cantidades de productos/variantes/vínculos/fotos y verificar una muestra de saldos, precios, monedas y recibos. Abrir una ficha, leer sus fotografías y generar una historia. Probar que otro propietario no puede acceder a ella y que ocultar la publicación revoca su lectura pública.
6. Registrar el tiempo efectivo, los errores, la pérdida máxima observada y los hashes de archivos revisados. No declarar recuperación verificada si falta la base o los objetos. Aprobar cualquier cambio de infraestructura o recuperación real por separado.

## Registro de aceptación pendiente

- Fecha y responsable del ensayo:
- Proyecto/base/bucket de origen (identificadores, sin claves):
- Destinos aislados verificados:
- Ventana de la copia y versión de la aplicación:
- Retención comprobada:
- Dump y manifiesto de objetos: tamaño, conteo, hashes y ubicación protegida:
- Conteos y muestra de datos comparados:
- Lectura de fotos y exportación comprobadas:
- Aislamiento y revocación comprobados:
- Tiempo de restauración y pérdida de datos observada:
- Resultado, incidencias y acciones pendientes:

Las pruebas locales con PostgreSQL descartable verifican comportamiento de la aplicación; no sustituyen este ensayo con los backups reales de la instalación.
