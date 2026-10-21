# Instagram — preparación deshabilitada

Revisión: 20/10/2026. Solo investigación de documentación oficial. No se conectó una cuenta, no se solicitaron tokens y no se crearon contenedores ni publicaciones.

La [colección oficial de Instagram de Meta](https://www.postman.com/meta/instagram/overview) ofrece flujos separados para Instagram Login y Facebook Login. La [documentación de Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login) permite cuentas profesionales y documenta los nombres `instagram_business_basic` e `instagram_business_content_publish`; ese flujo no requiere una Página de Facebook vinculada.

La [colección oficial de Facebook Login](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login) requiere Página vinculada y distingue Stories, disponibles para cuentas Business en ese flujo. No trasladar permisos ni limitaciones de un login al otro sin verificar el contrato concreto.

Los enlaces directos a la guía de Content Publishing en developers.facebook.com devolvieron 429/no accesible durante esta revisión. La colección oficial sí fue consultable. Por lo tanto, formato/tamaño de la imagen, disponibilidad exacta de Stories para la cuenta real, versión Graph, requisitos de app review, límites y mecanismo de entrega pública del archivo deben verificarse de nuevo antes de implementar publicación real. No se inventan cuotas ni se supone que un PNG exportable manualmente sea aceptable por la API.

`server/commerce/metaPublishingPreparation.js` conserva un manifiesto deshabilitado y una función que rechaza publicar. No contiene HTTP, credenciales, toggles de entorno que activen publicaciones ni una cola de programación. La generación/exportación local funciona sin estos requisitos externos.

Una futura implementación necesitaría autorización explícita, tipo de cuenta y app comprobados, permisos mínimos aprobados, almacenamiento seguro/renovación y revocación de tokens, medio accesible durante la ingesta, control de estados/duplicados y revisión semántica inmediatamente antes de publicar. Nada de esto habilita publicaciones reales en el alcance actual.
