# Desplegar Stocky y Stocky Studio juntos

## Qué publica este cambio

El build habitual `npm run build` genera ambas entradas en `dist`: Stocky (`index.html`) y Studio (`studio.html`). Vercel usa ese comando y directorio mediante `vercel.json`. El build independiente `npm run build:studio` sigue disponible para instalaciones separadas, pero no es el comando del proyecto Vercel de Stocky.

En Stocky, el propietario ve **Stocky Studio** en la barra lateral y en **Más** en móvil. El enlace abre `/studio.html` en el mismo dominio y conserva el acceso existente. Es navegación: no habilita negocios, modifica permisos ni evita la autorización comercial del backend. Los miembros no ven ese enlace; entrar directamente tampoco les concede permiso comercial.

URLs de esta instalación:

- Stocky: `https://erp-voice.vercel.app/`.
- Studio: `https://erp-voice.vercel.app/studio.html`.
- API: `https://erpvoice.onrender.com`.
- Catálogo de clientes: `https://erpvoice.onrender.com/c/<identificador-elegido>`.

## Vercel

En el proyecto existente de Stocky, conservar la rama de producción elegida y publicar el commit que incluye este cambio. No hace falta crear otro proyecto.

En variables de **Production**, comprobar:

```dotenv
VITE_META_API_BASE=https://erpvoice.onrender.com
VITE_CATALOG_ORIGIN=https://erpvoice.onrender.com
```

`VITE_META_API_BASE` ya se utiliza para Stocky. Si se usa `VITE_API_BASE`, este tiene prioridad y debe apuntar al mismo backend; no dejarlo con un host anterior o local. `VITE_CATALOG_ORIGIN` es opcional porque Studio usa por defecto la base API, pero permite dejar explícito el destino del catálogo.

El repositorio establece Build Command `npm run build` y Output Directory `dist`. Retirar el comando de dos builds/copias sugerido previamente si se llegó a configurar: ya no es necesario. Al cambiar variables VITE, hacer un nuevo build/deploy porque sus valores se incorporan al JavaScript del navegador.

## Render

En el servicio existente `erpvoice`, comprobar estas variables (orígenes sin barra final):

```dotenv
NODE_ENV=production
COMMERCE_STUDIO_ORIGIN=https://erp-voice.vercel.app
COMMERCE_CATALOG_ORIGIN=https://erpvoice.onrender.com
COMMERCE_MEDIA_ADAPTER=supabase
COMMERCE_STORAGE_URL=https://<proyecto-real>.supabase.co
COMMERCE_STORAGE_BUCKET=<bucket-privado-existente>
COMMERCE_STORAGE_SERVICE_KEY=<clave-privada-solo-del-servidor>
```

La URL de Studio ya está admitida por el CORS existente; declarar `COMMERCE_STUDIO_ORIGIN` hace explícito el origen. `COMMERCE_CATALOG_ORIGIN` se usa para canonical, imágenes sociales y enlaces absolutos del catálogo.

Las cuatro variables `COMMERCE_MEDIA_ADAPTER`/`COMMERCE_STORAGE_*` son necesarias para subir y leer fotos usando el adaptador productivo. El bucket debe existir y ser **privado**; el adaptador comprueba esta condición. Los placeholders se reemplazan con el recurso real; no son valores válidos de configuración. Ninguna clave de Storage, conexión SQL ni secreto JWT se configura con prefijo `VITE_` ni se copia a Vercel.

Conservar la conexión PostgreSQL, `AUTH_JWT_SECRET` y la configuración Meta/WhatsApp que ya usa Stocky. No rotar el secreto JWT para este cambio: invalidaría las sesiones. El servidor utiliza la conexión de Stocky; `COMMERCE_DATABASE_URL` es una selección explícita para los scripts de inspección/migración, no una base adicional ni un reemplazo automático de la conexión del servidor.

Guardar variables y desplegar el servicio para activarlas. No cambiar `PORT` ni establecer `API_BIND_HOST=127.0.0.1` en Render. El servidor ya lee el puerto de la plataforma y escucha en `0.0.0.0`.

## Base real: comprobación separada del deploy

### Alternativa sin Shell: SQL Editor de Supabase

El archivo [SUPABASE_COMMERCIAL_SCHEMA.sql](SUPABASE_COMMERCIAL_SCHEMA.sql) contiene las cuatro migraciones y su registro de versiones. Se genera desde los SQL originales con `npm run commerce:schema:sql`; no incluye claves ni datos DEMO.

1. Verificar el respaldo y seleccionar en Supabase el proyecto que usa la base de Stocky.
2. Abrir **SQL Editor → New query** con el rol administrador del proyecto.
3. Abrir el archivo local y copiar **todo** su contenido, desde `BEGIN` hasta el `SELECT` final, incluyendo los comentarios si se desea. Ejecutar el archivo completo una sola vez con **Run**, sin seleccionar una parte del texto.
4. El resultado debe mostrar las versiones **1, 2, 3 y 4**. Recargar Studio para volver a comprobar el esquema.

El script usa una sola transacción, comprueba las huellas del inventario antes/después, limita tiempos de espera, registra los mismos checksums que las herramientas CLI, activa RLS y retira acceso directo de los roles API sobre las tablas comerciales. Una excepción cancela toda la instalación; si el editor conserva una transacción fallida, ejecutar `ROLLBACK;` antes de reintentar. Los checksums anteriores con saltos de línea de Windows también se reconocen; un checksum desconocido se rechaza. No elimina tablas ni incorpora perfiles, políticas monetarias o publicaciones.

Las doce pruebas de `npm run test:commerce:sql` usan PostgreSQL descartable: instalación inicial, repetición/compatibilidad con CLI, preservación de datos existentes, instalación parcial, compatibilidad CRLF, rollback por fuente desconocida, permisos de roles API, base incorrecta, relaciones dañadas, habilitación explícita de negocio y corrección administrativa de moneda con aislamiento/recibo/repetición. Son evidencia local; el archivo no fue ejecutado en producción desde este chat.

### Alta autoservicio de cada negocio

Después de preparar el esquema una sola vez por instalación, los propietarios pueden entrar en Stocky → Stocky Studio o directamente en "/studio.html" con su sesión de WhatsApp. El asistente solicita nombre comercial, rubro si falta, contacto de ventas opcional, moneda (ARS/UYU/USD) y confirmación de unidades enteras. No necesita Shell, SQL ni credenciales de Supabase de parte del usuario.

La activación queda en una transacción con recibo idempotente, revisión y aislamiento por el propietario autenticado. Un miembro no puede activar otro negocio; un perfil deshabilitado por el operador no se reactiva desde el asistente. Una moneda ya confirmada no se reemplaza ni convierte automáticamente. Si falta una migración, la interfaz indica que el administrador debe actualizar el servicio; una petición HTTP nunca crea tablas.

Las variantes anteriores con XXX se revisan en **Configuración → Revisar moneda del inventario anterior**. El propietario selecciona hasta 100 variantes, revisa los importes y confirma la vista previa. La corrección usa **sku.update** y los recibos normales de inventario, con revisiones, motivo y selección limitada a su negocio. Cambiar un precio o resolver una moneda distinta de XXX requiere revisar el producto en Stocky. Los importes, stock y monedas ajenas a la selección no se convierten.

Los generadores administrativos de habilitación y corrección SQL se conservan como antecedentes de mantenimiento y para verificar recibos ya emitidos. **No son el procedimiento de alta ni normalización vigente.** Si se aplicó antes un archivo de corrección, no se vuelve a corregir ni se fabrican recibos de inventario retroactivos: se conserva su historial administrativo y se revisa el estado actual.

No hay variables de entorno nuevas para el asistente. Se reutilizan autenticación, base y Storage privado ya configurados. Desplegar backend y frontend actualizados antes de usarlo. La configuración del catálogo y la publicación de cada ficha continúan siendo decisiones explícitas del propietario, posteriores al alta.

### Inspección y aplicación desde Shell

El despliegue no crea ni habilita automáticamente el dominio comercial. Seleccionar expresamente la misma base de Stocky mediante `COMMERCE_DATABASE_URL`, sin imprimir su valor, y revisar primero:

```sh
npm run commerce:schema:check -- --allow-remote-database
npm run commerce:catalog:schema:check -- --allow-remote-database
npm run commerce:content:schema:check -- --allow-remote-database
npm run commerce:appearance:schema:check -- --allow-remote-database
```

Si faltan migraciones, revisarlas y aplicarlas en orden después de verificar el respaldo y la base objetivo:

```sh
npm run commerce:schema:apply -- --allow-remote-database
npm run commerce:catalog:schema:apply -- --allow-remote-database
npm run commerce:content:schema:apply -- --allow-remote-database
npm run commerce:appearance:schema:apply -- --allow-remote-database
```

Las migraciones no generan el perfil habilitado del negocio ni confirman moneda/escala. Antes del piloto, verificar `commerce_profiles` para el propietario real y `inventory_money_policies` con hechos confirmados. El perfil debe estar habilitado; el backend no concede acceso por ver el enlace. No usar el seed de DEMO en una base real ni inferir la moneda a partir del símbolo `$`.

## Cómo probar después del deploy

1. Ingresar normalmente a Stocky como propietario del negocio.
2. Abrir **Stocky Studio** desde la barra lateral o **Más** en móvil. Debe cargar `/studio.html` sin volver a pedir login.
3. Revisar **Configuración**: marca, moneda y WhatsApp de ventas.
4. Crear una ficha, vincular variantes existentes, cargar una foto y preparar la ficha. Generar y descargar una historia.
5. Elegir el identificador del catálogo en Configuración y habilitarlo. Publicar una ficha preparada y usar **Abrir catálogo**.
6. Abrir el catálogo sin sesión para comprobar la experiencia del cliente.

Diagnóstico: 404 en `/studio.html` indica build/commit/directorio publicado incorrecto; `COMMERCE_SCHEMA_NOT_READY` indica preparación comercial pendiente; 403 indica sesión/propietario/perfil no habilitado; `MEDIA_NOT_CONFIGURED` indica Storage pendiente. Ninguno se resuelve desactivando autenticación.

Este cambio integra build y navegación. No ejecuta migraciones, modifica variables alojadas, habilita negocios ni publica productos reales.

## Verificación del cambio

`npm run test:studio:deployment` compila las dos entradas y prueba el resultado de producción con una API simulada, sin acceso a la red: propietario y miembro en escritorio y móvil, navegación real desde Stocky a Studio, JWT conservado al cambiar de entrada y al recargar, y ausencia de escrituras durante la navegación. Los cuatro recorridos pasaron. También pasó la regresión de grilla de inventario (`node scripts/test-product-grid-ui.mjs`). Esto no certifica la configuración ni el perfil comercial de la base real.

Referencias: [Vercel: configuración del build](https://vercel.com/docs/builds/configure-a-build), [Render: variables de entorno](https://render.com/docs/configure-environment-variables).

## Personalización de marca

Aplicar también la migración comercial 4 antes de habilitar la personalización. El bundle SQL actualizado incluye las versiones 1 a 4 y se puede volver a ejecutar. Alternativa para una instalación ya preparada: `npm run commerce:appearance:schema:apply` con destino explícito. Ver [configuración y plantillas](../STUDIO_CUSTOMIZATION.md).
