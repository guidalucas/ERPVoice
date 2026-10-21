# FullMatch Studio privado — operación local

## Verificaciones

```powershell
npm run test:commerce
npm run test:voice-stock-postgres
npm run test:commerce:browser
npm run build:studio
```

Las pruebas PostgreSQL y de navegador crean sus propias bases temporales en loopback. No utilizan la base configurada en `.env.local`. En Windows pueden requerir autorización de ejecución para los binarios de PostgreSQL, Edge y los archivos temporales. La aceptación de navegador usa Edge instalado y una sesión JWT real emitida solamente para el negocio de prueba.

Las capturas y exportaciones de prueba quedan en `.fullmatch-runtime/browser/`, fuera de Git. Las camisetas de demostración son ilustraciones identificadas como tales; no son fotografías de productos reales.

## Desarrollo

`npm run dev:studio` abre la entrada independiente en `http://127.0.0.1:5175/studio.html`. Requiere el backend autenticado y migraciones comerciales ya aplicadas de forma explícita. Usa `VITE_API_PROXY_TARGET` para elegir el backend local. La aplicación no consulta `/api/state` y no incorpora el dashboard operativo.

Para una demostración totalmente aislada:

```powershell
npm run dev:studio:fixture
```

Este comando crea PostgreSQL, API y Vite locales, con puertos libres y recursos descartables. Informa la URL, sin imprimir claves. La sesión de demostración se guarda en `.fullmatch-runtime/fixture-session.json`; pertenece únicamente al backend temporal y no desactiva su autenticación. La prueba automatizada inyecta esa sesión en el navegador antes de abrir Studio. Para entrar manualmente, establecer las claves locales `erpvoice.auth.token` y `erpvoice.auth.phoneNumber` con los valores `token` y `owner` de ese archivo, en el origen de la URL informada, y recargar. No es un mecanismo de acceso productivo.

Detener con Ctrl+C o crear `.fullmatch-runtime/FIXTURE_STOP`. El proceso cierra sus servicios y elimina únicamente su directorio temporal verificado. Si existe ese archivo al reiniciar, retirarlo después de comprobar que el proceso anterior terminó.

## Flujo diario

1. Ingresar con WhatsApp, usando la sesión existente de Stocky y el propietario habilitado.
2. Crear la ficha y completar equipo, temporada, equipación, versión y manga.
3. Vincular explícitamente las variantes físicas correspondientes. Revisar talles, moneda y precios provenientes de Stocky.
4. Cargar fotos, elegir portada, ordenar la galería y ajustar su descripción/enfoque.
5. Preparar la ficha. Este estado todavía es privado.
6. Elegir una de las tres plantillas, foto, talles y encuadre; generar previsualización y descargar PNG/JPG.

El servidor conserva el snapshot inmutable en el recibo comercial y revalida su contenido antes de habilitar y ejecutar la descarga. «Última unidad» exige una unidad total o especifica el talle con una unidad. Las reservas ya están descontadas de `stockAvailable`; no se descuentan otra vez.

Los borradores de información se conservan por usuario/ficha en el navegador. Los intentos cuyo resultado no se pudo confirmar aparecen en **Recuperar intentos**: consultar el recibo o reenviar exactamente la misma operación. Reenviar conserva su UUID y no crea una segunda ficha. Una foto pendiente/fallida se reintenta con el mismo archivo; si cambió el archivo, retirar ese intento e iniciar uno nuevo.

## Fotografías y mantenimiento

Producción requiere configurar explícitamente un bucket privado existente y las variables de servidor `COMMERCE_MEDIA_ADAPTER=supabase`, `COMMERCE_STORAGE_URL`, `COMMERCE_STORAGE_BUCKET` y `COMMERCE_STORAGE_SERVICE_KEY`. La clave nunca lleva prefijo `VITE_`. El adaptador no crea cuentas, buckets ni servicios. El adaptador local está limitado a desarrollo/pruebas y se rechaza en producción. La conexión real con Supabase queda pendiente de habilitación/verificación externa.

Límites: ocho fotos por ficha, hasta 12 MiB/24 megapíxeles, JPEG/PNG/WebP sin animación. Master JPEG de hasta 2400 px, miniatura de hasta 480 px, orientación corregida y EXIF retirado. Concurrencia por instancia: dos cargas; cada carga conserva un identificador de intento. Reserva de carga: 30 minutos. Un intento en proceso puede recuperarse tras dos minutos; el mantenimiento considera vencida una lease tras cinco minutos. Las escrituras de objetos usan claves inmutables. Ante confirmación de base incierta se conservan los archivos hasta poder comprobar su referencia.

Inspección explícita, sin bootstrap ni modificación de inventario:

```powershell
$env:COMMERCE_DATABASE_URL = '<conexión elegida explícitamente>'
npm run commerce:media:inspect -- --owner <negocio>
```

El resultado contiene contadores, sin teléfonos, fichas, claves de objetos ni credenciales. Si hay almacenamiento configurado, inspecciona exclusivamente el prefijo del negocio; el recorrido está acotado. Una base remota exige además `--allow-remote-database`, que no constituye autorización para operar producción desde esta implementación.

Aplicación y purga son acciones separadas y explícitas:

```powershell
node scripts/maintain-commerce-media.js --owner <negocio> --apply
node scripts/maintain-commerce-media.js --owner <negocio> --apply --purge
```

`--apply` marca cargas vencidas; `--purge` elimina objetos de fotos retiradas hace más de 24 horas y huérfanos antiguos sin referencia. Revalida la referencia y el intento bajo bloqueo antes de purgar; nunca borra un master ready ni un archivo de un intento activo. Registra `purged_at` y permite repetir la operación. Cada ejecución procesa como máximo 50 retiros y 100 objetos huérfanos. No se instala una tarea programada ni se ejecuta mantenimiento productivo automáticamente.

Referencia de contrato del adaptador: [API oficial de Supabase Storage](https://supabase.github.io/storage/).
