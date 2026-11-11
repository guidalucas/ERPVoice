import { record, uuid, integer, text } from './validation.js';
import { fail } from './errors.js';
import { executeCommerceCommand, requireCommerceAccess } from './operationRepository.js';
import { inspectContentSchema } from './contentMigration.js';

export function createContentService(runtime) {
  let ready;
  const ensure = async () => {
    ready ??= runtime.withClient(async client => { if (!(await inspectContentSchema(client)).ready) fail('CONTENT_SCHEMA_NOT_READY', 'La preparación de la biblioteca está pendiente.', 503); })
      .catch(error => { ready = undefined; throw error; }); await ready;
  };
  return {
    recordExport: async (context, snapshotId, input) => {
      snapshotId = uuid(snapshotId); const data = record(input, ['operationId', 'kind', 'filename', 'mimeType', 'sizeBytes', 'sha256']);
      const command = { snapshotId, kind: data.kind, filename: text(data.filename, 200, 'filename'), mimeType: data.mimeType,
        sizeBytes: integer(data.sizeBytes, 1), sha256: text(data.sha256, 64, 'file hash') };
      if (!['generated', 'download_requested', 'share_requested'].includes(command.kind) || !['image/png', 'image/jpeg'].includes(command.mimeType)
        || !/^[a-z0-9-]+\.(png|jpg)$/.test(command.filename) || (command.mimeType === 'image/png') !== command.filename.endsWith('.png')
        || command.sizeBytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(command.sha256)) fail('EXPORT_METADATA_INVALID', 'Revisá los datos del archivo generado.', 400);
      await ensure();
      return executeCommerceCommand(runtime, context, { operationId: uuid(data.operationId), type: 'story.export_event', entityId: snapshotId, command, permission: 'commerce:story' }, async client => {
        const snapshot = (await client.query("SELECT 1 FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2 AND operation_type='story.prepare'", [context.businessId, snapshotId])).rows[0];
        if (!snapshot) fail('RESOURCE_NOT_FOUND', 'No encontré la historia preparada.', 404);
        return { ...command, reportedAt: new Date().toISOString(), source: 'client_reported' };
      });
    },
    library: async (context, query = {}) => {
      const data = record(query, ['cursor', 'limit']), limit = data.limit === undefined ? 24 : Number(data.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('INVALID_COMMAND', 'Límite de biblioteca inválido.', 400);
      let cursor;
      if (data.cursor) {
        try { cursor = JSON.parse(Buffer.from(text(data.cursor, 600, 'cursor'), 'base64url').toString()); } catch { fail('INVALID_COMMAND', 'Cursor de biblioteca inválido.', 400); }
        record(cursor, ['at', 'id']); uuid(cursor.id); if (typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))) fail('INVALID_COMMAND', 'Cursor de biblioteca inválido.', 400);
      }
      await ensure();
      return runtime.transaction(async client => {
        await requireCommerceAccess(client, context, 'commerce:story');
        const rows = (await client.query(`WITH page AS (
            SELECT o.owner_phone,o.operation_id,o.created_at,o.result_json->'result' AS snapshot
            FROM commercial_operations o
            WHERE o.owner_phone=$1 AND o.operation_type='story.prepare' AND ($2::timestamptz IS NULL OR (o.created_at,o.operation_id)<($2::timestamptz,$3::uuid))
            ORDER BY o.created_at DESC,o.operation_id DESC LIMIT $4
          )
          SELECT o.operation_id,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            o.snapshot->>'snapshotId' AS snapshot_id,o.snapshot->>'createdAt' AS prepared_at,o.snapshot->>'expiresAt' AS expires_at,
            o.snapshot#>>'{content,productId}' AS product_id,o.snapshot#>>'{content,title}' AS title,
            o.snapshot#>>'{content,settings,templateId}' AS template_id,o.snapshot#>>'{content,imageId}' AS image_id,
            o.snapshot#>>'{content,imageAlt}' AS image_alt,e.result_json->'result' AS last_export
          FROM page o LEFT JOIN LATERAL (SELECT result_json FROM commercial_operations e
            WHERE e.owner_phone=o.owner_phone AND e.entity_id=o.operation_id AND e.operation_type='story.export_event'
            ORDER BY e.created_at DESC,e.operation_id DESC LIMIT 1) e ON true
          ORDER BY o.created_at DESC,o.operation_id DESC`, [context.businessId, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
        const batch = rows.slice(0, limit), last = batch.at(-1);
        return { items: batch.map(row => ({ snapshotId: row.snapshot_id, productId: row.product_id, title: row.title,
          templateId: row.template_id, imageId: row.image_id, imageAlt: row.image_alt,
          preparedAt: row.prepared_at, expiresAt: row.expires_at, expired: Date.parse(row.expires_at) <= Date.now(),
          lastExport: row.last_export ? { kind: row.last_export.kind, filename: row.last_export.filename, mimeType: row.last_export.mimeType, sizeBytes: row.last_export.sizeBytes, reportedAt: row.last_export.reportedAt } : null })),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.operation_id })).toString('base64url') : null };
      }, { readOnly: true, repeatableRead: true });
    },
  };
}
