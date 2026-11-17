# Historias automáticas de Stocky

## Arquitectura

GitHub Actions llama al backend existente con solicitudes HMAC de vida corta. PostgreSQL valida cada nonce y guarda la configuración, el historial y el trabajo activo por comercio. Actions recibe solo los datos de la historia y ejecuta Chromium localmente. No necesita acceso a PostgreSQL ni credenciales de Meta.

La selección usa las fichas listas con portada disponible y al menos un SKU activo con stock y precio. Usa las reglas de preparación y el snapshot de Studio, con la plantilla Stock disponible. La selección es aleatoria y prioriza productos sin publicar en el ciclo actual. Solo las publicaciones confirmadas consumen un turno. Los nuevos productos elegibles entran en el ciclo. Para excluir una ficha, desmarcá **Incluir en historias automáticas** en el editor.

El runner devuelve un JPG de 1080 × 1920. Stocky verifica los bytes decodificados y revalida precio, stock, foto y demás datos comerciales antes de preparar el contenedor y de nuevo antes de publicar. PostgreSQL conserva el JPG temporalmente. Meta lo obtiene por HTTPS mediante una firma que autoriza un archivo durante una hora. El runner limpia archivos vencidos, incluso en días sin publicaciones. El historial y los snapshots se conservan. Mantené la ruta `/api/instagram-story-media/*` fuera de los logs que registren la URL completa.

La configuración se bloquea por comercio mientras se reclama el trabajo o se autoriza el envío. Hay un único trabajo activo por comercio y hasta una publicación confirmada por ventana, fecha comercial, comercio y cuenta. Un intento interrumpido antes de publicar puede recuperarse tras vencer el lease si su ventana sigue abierta. Si se pierde el resultado de `media_publish`, solo se consulta el contenedor. `PUBLISHED` confirma el envío, `EXPIRED` o `ERROR` permiten un nuevo intento. Cualquier otro resultado deja el trabajo en `unknown` y bloquea nuevos envíos hasta resolverlo.

El modo de prueba de Actions y la simulación en Studio generan un JPG sin crear contenedores ni alterar el historial o la rotación. El exportador manual sigue usando el mismo renderizador y la autenticación de Studio.

## Archivos de la implementación

- Workflow y runner. `.github/workflows/instagram-auto-story.yml`, `scripts/instagram-auto-story.mjs`, `scripts/auto-story-render.html`.
- Base de datos. `server/migrations/commerce/006_automatic_stories.sql`, `server/migrations/commerce/007_automatic_story_windows.sql`, `server/commerce/migrationSource.js`, `scripts/migrate-commerce-auto-stories.js`.
- Backend. `server/commerce/autoStoryService.js`, `autoStorySelection.js`, `autoStoryRoutes.js`, `autoStorySecurity.js`, `autoStoryMedia.js` e `instagramStoryPublisher.js` dentro de `server/commerce`. Integración en `server/index.js`, `server/commerce/router.js` y `server/commerce/storyService.js`.
- Studio. `src/studio/AutomaticStories.tsx`, `autoStoryRender.ts`, `Studio.tsx`, `storyRenderer.ts` y `universal.css` dentro de `src/studio`.
- Pruebas y comandos. `scripts/test-auto-stories.mjs`, `scripts/test-auto-stories-e2e.mjs` y `package.json`.
- Documentación. Esta guía, `docs/fullmatch/META_PREPARATION.md` y `docs/STUDIO_CUSTOMIZATION.md`.

## Migración

Aplicá las migraciones de historias después de la 005. El comando aplica de la 006 a la 008 en orden y conserva las ya registradas. El backend requiere la 007 para publicar por ventana. La 008 habilita el registro de ventanas omitidas y puede aplicarse después de desplegar el backend. Usá el destino explícito en `COMMERCE_DATABASE_URL` desde un entorno de mantenimiento autorizado. Para un destino remoto, agregá `-- --allow-remote-database` a cada comando.

```sh
npm run commerce:auto-stories:schema:check
npm run commerce:auto-stories:schema:apply
npm run commerce:auto-stories:schema:check
```

La migración crea `commerce_auto_story_settings`, `commerce_auto_story_jobs` y `commerce_auto_story_requests`, y agrega `commercial_products.auto_story_enabled`. Las fichas existentes quedan incluidas si cumplen las reglas. Cada comercio empieza con la automatización desactivada.
La 007 asigna los intentos existentes a la ventana correspondiente a la hora en que se reclamaron y conserva el historial.
La 008 guarda desde cuándo está activada la automatización. Para configuraciones que ya estaban activadas toma como referencia la última autorización registrada.

## Configuración del backend

El MVP habilita la sección Historias automáticas, su simulación y las preferencias de producto solo para el comercio identificado por `AUTO_STORY_OWNER`. El generador manual de historias sigue disponible en los demás comercios habilitados para Studio.

| Variable en el backend | Uso |
| --- | --- |
| `AUTO_STORY_OWNER` | Identificador telefónico canónico de Stocky del propietario, con código de país y solo dígitos. |
| `AUTO_STORY_RUNNER_KEY` | Clave HMAC de 32 bytes como 64 dígitos hexadecimales. También se configura como secreto en GitHub. |
| `AUTO_STORY_MEDIA_KEY` | Clave de 32 bytes, en hex, exclusiva del backend y distinta de la clave del runner. |
| `AUTO_STORY_TOKEN_KEY` | Clave AES de 32 bytes, en hex, exclusiva del backend. Conservala al redeplegar. |
| `AUTO_STORY_PUBLIC_ORIGIN` | Origen HTTPS público del backend, sin ruta. |
| `AUTO_STORY_META_TOKEN` | Secreto del backend con el token de larga duración de Instagram. |
| `AUTO_STORY_META_EXPIRES_AT` | Vencimiento del token, como fecha y hora ISO 8601 con zona. |
| `AUTO_STORY_META_VERSION` | Versión de Graph configurada para Instagram. Valor predeterminado `v26.0`. |

Generá las claves por separado en un entorno seguro. Para un dry-run de Actions alcanzan el identificador del comercio y la clave del runner en el backend. Studio usa su autenticación habitual.

## Conectar FullMatch Casacas

1. En Instagram, confirmá que FullMatch Casacas usa una cuenta profesional de tipo **Business**.
2. En [Meta for Developers](https://developers.facebook.com/apps), creá o seleccioná una app **Business**. Agregá el producto Instagram y elegí **API setup with Instagram business login**. Este flujo usa Instagram Login y no requiere enlazar una Página de Facebook. [Guía de Meta para Instagram Login](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login).
3. En la configuración de Instagram de la app, agregá la cuenta que administrás. Si Meta pide aceptar una invitación de tester o asignar un rol, completalo con la cuenta de FullMatch. Confirmá que el token se otorga con `instagram_business_basic` e `instagram_business_content_publish`. Standard Access corresponde a cuentas que administrás y agregaste a la app. Para cuentas que la app no administra, solicitá Advanced Access mediante App Review y completá la verificación comercial si el panel la exige. [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login).
4. En el panel de Instagram de la app, elegí **Generate token** junto a FullMatch, iniciá sesión con esa cuenta y aceptá los permisos. El token generado en el panel es de larga duración, con validez de 60 días. Copialo al gestor de secretos del backend y configurá su vencimiento real. El MVP usa este aprovisionamiento desde el panel, sin implementar un callback OAuth en Stocky. [Guía de obtención de token de Meta](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started).
5. En Studio, entrá como propietario y abrí **Historias automáticas**. Confirmá el tipo de cuenta y autorizá su conexión. **Verificar conexión** consulta la identidad y tipo Business que devuelve Meta y el endpoint de cuota de publicación. Comprobá que el usuario mostrado sea el de FullMatch. La publicación sigue desactivada hasta usar **Autorizar y activar publicación automática**.
6. Stocky intenta renovar el token cuando quedan menos de siete días y hay un trabajo que publicar. Guarda la renovación cifrada en PostgreSQL. Para un token expirado o revocado, generá otro, reemplazá el token y vencimiento en el backend y verificá de nuevo desde Studio. El endpoint de renovación requiere un token válido de al menos 24 horas. [Renovación del token](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login#refresh-a-long-lived-token).

Meta documenta JPEG y descarga pública, `media_type=STORIES`, creación del contenedor, consulta de estado y `media_publish`. La guía de publicación menciona 100 publicaciones por API en una ventana móvil de 24 horas y la referencia de cuota muestra 50. Stocky usa el valor que devuelve `config.quota_total` para la cuenta y aplica su propio límite de una historia por ventana. [Referencia de cuota de Meta](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit). Verificá la aceptación de la imagen vertical y el permiso efectivo en la cuenta real durante el primer intento controlado. [Meta Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing).

## GitHub Actions, prueba y primer envío

1. En GitHub, entrá a **Settings → Environments → Production**. El job usa las variables y los secretos de ese entorno con `deployment: false`. Creá la variable `AUTO_STORY_API_ORIGIN` con el origen HTTPS del backend y el secreto `AUTO_STORY_RUNNER_KEY` con la misma clave que usa Stocky. El workflow debe estar en la rama predeterminada `main`.
2. Aplicá la migración y desplegá el backend y Studio mediante el proceso habitual cuando lo autorices. Con la publicación desactivada, probá **Simular historia** en Studio. Verificá nombre, precio, talles, portada y marca.
3. En **Actions → Instagram automatic story → Run workflow**, elegí `main` y dejá `dry_run` marcado. El resumen debe mostrar `simulated`. `NO_ELIGIBLE_PRODUCT` indica que ninguna ficha cumplió los criterios.
4. Para un primer envío real, elegí un horario entre las ejecuciones previstas y autorizalo expresamente. Verificá la cuenta, activá la automatización en Studio y ejecutá el workflow con `dry_run` desmarcado. Comprobá el historial y el Instagram del comercio. Si la prueba debe terminar con un solo envío, desactivá la automatización desde Studio al confirmar el resultado.
5. Supabase Cron dispara el workflow por API a las 09:17, 12:17, 16:17 y 20:17 de Argentina. Cada ventana tiene reintentos a los minutos :37 y :57. PostgreSQL limita la publicación a una historia por ventana. El campo `scheduled_at` conserva el inicio de la ventana aunque GitHub demore la ejecución. Una ejecución manual que deja ese campo vacío usa la hora en que se solicitó. El runner espera el arranque del backend y descarta los trabajos cuya ventana cerró.

## Configurar Supabase Cron

El comando de configuración usa el destino explícito `COMMERCE_DATABASE_URL`. Para Supabase agregá `--allow-remote-database` y usá la cadena de confianza TLS habitual del proyecto.

1. Ejecutá `node scripts/configure-instagram-story-cron.mjs --apply --allow-remote-database`. Instala `pg_cron`, `pg_net` y el esquema privado `stocky_automation`. Crea los cuatro trabajos de publicación desactivados y un trabajo que conserva las respuestas HTTP cada cinco minutos.
2. Creá un token fine-grained de GitHub limitado a `guidalucas/ERPVoice`, con permiso `Actions: Read and write`. Guardalo en Supabase Vault con el nombre `stocky_instagram_actions_token`. El token debe renovarse antes de su vencimiento.
3. Integrá el workflow con el input `scheduled_at` en `main`. Ejecutá `node scripts/configure-instagram-story-cron.mjs --simulate --allow-remote-database`. Verificá la respuesta HTTP 204 y el resultado `simulated` en Actions.
4. Ejecutá `node scripts/configure-instagram-story-cron.mjs --activate --allow-remote-database` para activar los horarios. El comando verifica que exista el secreto y que `main` incluya el input. `--pause` desactiva los cuatro horarios.
5. Ejecutá el comando sin ninguna acción para consultar horarios, activación y las últimas solicitudes. `stocky_automation.instagram_story_dispatches` guarda la hora solicitada, el identificador de pg_net y la respuesta HTTP. Un HTTP 204 confirma que GitHub recibió el disparo. El resultado de publicación se consulta en Actions y en el historial de Stocky.

## Operación

- **Ventana sin registro:** al recibir otra ejecución o consultar el historial, Stocky guarda como omitidas las ventanas cerradas de los últimos siete días en las que la automatización estaba activada y no hay intento registrado. La fila muestra la hora de inicio de la ventana.
- **Resultado incierto:** las ejecuciones siguientes consultan el mismo contenedor, aun con la automatización desactivada. Si el contenedor queda indeterminado tras recuperar la conexión, revisá el historial de Instagram y Meta. Conservá el bloqueo hasta contar con confirmación externa inequívoca. Si Meta ya no puede exponer el estado del contenedor, la resolución documentada requiere intervención de un operador de la base sobre el trabajo concreto y registro de la evidencia disponible. No borres el trabajo.
- **JPG temporal:** una URL deja de responder al vencer la hora, aunque el backend haya estado suspendido. La limpieza física ocurre al volver a ejecutar la automatización. Si el workflow queda deshabilitado durante un período prolongado, se pueden limpiar los bytes con `UPDATE commerce_auto_story_jobs SET jpeg=NULL WHERE jpeg IS NOT NULL AND jpeg_expires_at<=now();`.
- **Metadatos de confirmación:** si se perdió la respuesta de publicación y Meta confirma por estado `PUBLISHED`, el historial puede carecer del identificador de la historia. La confirmación conserva el ID del contenedor y bloquea duplicados.
- **Pruebas locales:** `npm run test:commerce:auto-stories` usa PostgreSQL aislado, Playwright y un mock del Graph API. En Windows reutiliza Edge como las otras pruebas del repositorio. En CI instalá Chromium antes de ejecutar las pruebas con `npx playwright install --with-deps chromium`.
