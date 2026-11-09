# Candidato preparado; requiere autorización antes de publicarse

- Rama local: `codex/catalog-production-validation`.
- Base confirmada en producción: `0e069a34020bbca731152208f486a901565aff34`.
- Commit de ejecución candidato: `2f30311` — `fix(catalog): preserve anchor navigation and expose request timings`.
- [Diff completo de ejecución para revisar](pending-runtime.patch).
- [Comparación de producción y pruebas](PRODUCTION-VALIDATION.md).

El commit candidato corrige CTA/anclas del catálogo y agrega Server-Timing por request. Incluye sus pruebas. No cambia inventario, esquema, variables, dependencias, planes ni servicios. Los datos de medición y las herramientas de diagnóstico se guardan en un segundo commit, separado del cambio de ejecución.

El directorio original conserva sus cambios pendientes. Esta rama se preparó en la copia aislada `.fullmatch-runtime/catalog-publish`, sobre el último commit del catálogo ya publicado; no se incluyeron cambios ajenos de WhatsApp/Studio.

**No se hizo push de estos commits ni se inició un despliegue.** La comparación `production-after.json` corresponde a la base `0e069a3`, ya activa antes de esta tarea. No debe presentarse como una medición del candidato `2f30311`.

Antes de publicar, obtener autorización expresa del usuario y verificar que main no haya avanzado. Conservar la configuración existente de Render. Si publicar main activa el despliegue automático, ese push también debe esperar la autorización.

Después de publicarse:

1. Comprobar que health y el script `catalog.js?v=2` corresponden al nuevo commit y que el CTA ya no vuelve arriba.
2. Ejecutar el recorrido con una etiqueta nueva y conservar `production-before.json` y `production-after.json` históricos.
3. Revisar Server-Timing de listado, ficha, imagen 200 y 304. Separar `db_setup` (cliente + BEGIN) de consultas, almacenamiento y codificación, sin presentarlo como espera pura del pool.
4. Investigar CPU/memoria/pool con acceso de lectura a Render y la base cuando esté disponible. No cambiar planes ni desactivar TLS para obtener las métricas.

Rollback de código, si fuera necesario y autorizado: volver a la base `0e069a3`. No hay migraciones ni cambios de datos de esta versión que revertir.
