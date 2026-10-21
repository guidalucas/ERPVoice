import { randomUUID } from 'node:crypto';
import { record, uuid, integer, text, denseArray } from './validation.js';
import { fail } from './errors.js';
import { executeCommerceCommand, requireCommerceAccess } from './operationRepository.js';
import { requireProduct, readProductDetail } from './productRepository.js';
import { inspectCommerceSchema } from './schemaInspection.js';
import { createMediaStorage } from './mediaStorage.js';
import { MAX_IMAGE_BYTES, processCommercialImage, sha256 } from './imageProcessor.js';

const expected = (row, revision) => {
  if (Number(row.revision) !== integer(revision, 1)) fail('REVISION_CONFLICT', 'La ficha cambió. Actualizá antes de guardar.', 409, { currentRevision: Number(row.revision) });
  if (row.status === 'archived') fail('PRODUCT_ARCHIVED', 'Restaurá la ficha para editar sus fotos.', 409);
};
const requireImage = async (client, owner, productId, imageId) => {
  const row = (await client.query('SELECT * FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3 FOR UPDATE', [owner, productId, imageId])).rows[0];
  if (!row || row.status === 'deleted') fail('RESOURCE_NOT_FOUND', 'No encontré la foto.', 404);
  return row;
};
const touch = (client, context, id, invalidate = false) => client.query(`UPDATE commercial_products SET revision=revision+1,
  updated_at=NOW(),updated_by=$3,status=CASE WHEN $4 THEN 'draft' ELSE status END WHERE owner_phone=$1 AND id=$2`, [context.businessId, id, context.actorId, invalidate]);

export function createCommerceMediaService(runtime, storage = createMediaStorage()) {
  let processing = 0;
  const withSlot = async callback => {
    if (processing >= 2) fail('IMAGE_PROCESSOR_BUSY', 'Hay otras fotos en proceso. Reintentá en unos segundos.', 429);
    processing++;
    try { return await callback(); } finally { processing--; }
  };
  const ensure = async () => {
    if (!storage.configured) fail('MEDIA_NOT_CONFIGURED', 'Falta configurar el almacenamiento privado de fotografías.', 503);
    await runtime.withClient(async client => { if (!(await inspectCommerceSchema(client)).ready) fail('COMMERCE_SCHEMA_NOT_READY', 'La preparación comercial está pendiente.', 503); });
  };
  const mutate = async (context, meta, apply) => { await ensure(); return executeCommerceCommand(runtime, context, meta, apply); };
  return {
    initialize: async (context, productId, input) => {
      productId = uuid(productId);
      const data = record(input, ['operationId', 'expectedRevision', 'sourceSha256', 'sourceSizeBytes', 'altText']);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1),
        sourceSha256: text(data.sourceSha256, 64, 'image hash'), sourceSizeBytes: integer(data.sourceSizeBytes, 1), altText: text(data.altText ?? '', 300, 'alt text', { empty: true }) };
      if (!/^[a-f0-9]{64}$/.test(command.sourceSha256) || command.sourceSizeBytes > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', 'Revisá la foto: máximo 12 MB.', 413);
      return mutate(context, { operationId: command.operationId, type: 'image.initialize', entityId: productId, command }, async client => {
        const product = await requireProduct(client, context.businessId, productId, { lock: true }); expected(product, command.expectedRevision);
        const images = (await client.query("SELECT id FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND status<>'deleted'", [context.businessId, productId])).rows;
        if (images.length >= 8) fail('IMAGE_LIMIT_REACHED', 'Podés guardar hasta 8 fotos por ficha.', 422);
        const id = randomUUID();
        await client.query(`INSERT INTO commercial_product_images(owner_phone,id,commercial_product_id,source_sha256,source_size_bytes,
          alt_text,sort_order,upload_expires_at,product_identity_at_start,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '30 minutes',$8,$9)`, [context.businessId, id, productId,
          command.sourceSha256, command.sourceSizeBytes, command.altText, images.length, product.identity_key, context.actorId]);
        await touch(client, context, productId);
        return { imageId: id, product: await readProductDetail(client, context.businessId, productId) };
      });
    },
    upload: async (context, productId, imageId, bytes) => {
      productId = uuid(productId); imageId = uuid(imageId); await ensure();
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', 'La foto debe pesar hasta 12 MB.', 413);
      return withSlot(async () => {
      const hash = sha256(bytes), attempt = randomUUID();
      const claim = await runtime.transaction(async client => {
        await requireCommerceAccess(client, context, 'commerce:media');
        const product = await requireProduct(client, context.businessId, productId, { lock: true });
        if (product.status === 'archived') fail('PRODUCT_ARCHIVED', 'Restaurá la ficha para subir fotos.', 409);
        const row = await requireImage(client, context.businessId, productId, imageId);
        if (row.source_sha256 !== hash || Number(row.source_size_bytes) !== bytes.length) fail('IMAGE_CONTENT_MISMATCH', 'El archivo cambió. Iniciá una nueva carga.', 409);
        if (row.status === 'ready') return { complete: await readProductDetail(client, context.businessId, productId) };
        if (row.upload_expires_at.getTime() < Date.now()) fail('IMAGE_UPLOAD_EXPIRED', 'La carga venció. Retirá este intento y elegí la foto otra vez.', 410);
        if (product.identity_key !== row.product_identity_at_start) fail('PRODUCT_CHANGED', 'Cambió la identidad de la ficha. Iniciá una nueva carga.', 409);
        if (row.status === 'processing' && Date.now() - row.processing_started_at.getTime() < 120_000) fail('IMAGE_PROCESSING', 'Esta foto todavía se está procesando.', 409);
        await client.query(`UPDATE commercial_product_images SET status='processing',attempt_id=$4,processing_started_at=NOW(),
          error_code=NULL,revision=revision+1,updated_at=NOW() WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3`, [context.businessId, productId, imageId, attempt]);
        return {};
      });
      if (claim.complete) return claim.complete;
      const prefix = `${sha256(Buffer.from(context.businessId)).slice(0, 32)}/${imageId}/${attempt}`;
      const masterKey = `${prefix}/master.jpg`, thumbnailKey = `${prefix}/thumbnail.jpg`;
      let completed = false, cleanupSafe = false;
      try {
        const output = await processCommercialImage(bytes);
        await storage.put(masterKey, output.master); await storage.put(thumbnailKey, output.thumbnail);
        const result = await runtime.transaction(async client => {
          await requireCommerceAccess(client, context, 'commerce:media');
          const product = await requireProduct(client, context.businessId, productId, { lock: true });
          const image = await requireImage(client, context.businessId, productId, imageId);
          if (image.status !== 'processing' || image.attempt_id !== attempt) fail('IMAGE_ATTEMPT_SUPERSEDED', 'Otro intento reemplazó esta carga.', 409);
          if (product.status === 'archived' || product.identity_key !== image.product_identity_at_start) fail('PRODUCT_CHANGED', 'La ficha cambió durante la carga. Revisala antes de reintentar.', 409);
          await client.query(`UPDATE commercial_product_images SET status='ready',master_key=$4,thumbnail_key=$5,master_sha256=$6,
            mime_type=$7,width=$8,height=$9,stored_size_bytes=$10,revision=revision+1,error_code=NULL,updated_at=NOW()
            WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3`, [context.businessId, productId, imageId,
            masterKey, thumbnailKey, output.masterSha256, output.mimeType, output.width, output.height, output.master.length + output.thumbnail.length]);
          if (!product.cover_image_id) await client.query('UPDATE commercial_products SET cover_image_id=$3 WHERE owner_phone=$1 AND id=$2', [context.businessId, productId, imageId]);
          await touch(client, context, productId);
          return readProductDetail(client, context.businessId, productId);
        });
        completed = true;
        return result;
      } catch (error) {
        const code = /^IMAGE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'IMAGE_PROCESSING_FAILED';
        await runtime.transaction(async client => {
          await client.query(`UPDATE commercial_product_images SET status='failed',error_code=$5,revision=revision+1,updated_at=NOW()
            WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3 AND attempt_id=$4 AND status='processing'`, [context.businessId, productId, imageId, attempt, code]);
        }).catch(() => {}); // A crashed process leaves a bounded lease, recoverable after two minutes.
        // COMMIT acknowledgements can be lost. Never delete a stored file on an unknown DB outcome.
        await runtime.withClient(async client => {
          const row = (await client.query('SELECT status,attempt_id,master_key FROM commercial_product_images WHERE owner_phone=$1 AND id=$2', [context.businessId, imageId])).rows[0];
          if (row?.status === 'ready' && row.attempt_id === attempt && row.master_key === masterKey) completed = true;
          else if (!row || row.attempt_id !== attempt || ['failed', 'deleted'].includes(row.status)) cleanupSafe = true;
        }).catch(() => {});
        throw error;
      } finally {
        if (!completed && cleanupSafe) await Promise.allSettled([storage.remove(masterKey), storage.remove(thumbnailKey)]);
      }
      });
    },
    content: async (context, productId, imageId, variant = 'master') => {
      uuid(productId); uuid(imageId); if (!['master', 'thumbnail'].includes(variant)) fail('INVALID_COMMAND', 'Versión de foto inválida.', 400);
      await ensure();
      const selected = await runtime.transaction(async client => {
        await requireCommerceAccess(client, context, 'commerce:read');
        const row = (await client.query("SELECT master_key,thumbnail_key,master_sha256 FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3 AND status='ready'", [context.businessId, productId, imageId])).rows[0];
        if (!row) fail('RESOURCE_NOT_FOUND', 'No encontré la foto.', 404);
        return { key: variant === 'thumbnail' ? row.thumbnail_key : row.master_key, expectedHash: variant === 'master' ? row.master_sha256 : null };
      }, { readOnly: true });
      const bytes = await storage.get(selected.key);
      if (selected.expectedHash && sha256(bytes) !== selected.expectedHash) fail('MEDIA_INTEGRITY_ERROR', 'La foto guardada no coincide con su registro. Revisá el almacenamiento.', 503);
      return bytes;
    },
    update: async (context, productId, imageId, input) => {
      productId = uuid(productId); imageId = uuid(imageId);
      const data = record(input, ['operationId', 'expectedRevision', 'expectedImageRevision', 'altText', 'focalX', 'focalY', 'retire']);
      const fraction = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('INVALID_COMMAND', 'Punto de enfoque inválido.', 400); return value; };
      if (typeof data.retire !== 'boolean') fail('INVALID_COMMAND', 'Indicá la acción sobre la foto.', 400);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1), expectedImageRevision: integer(data.expectedImageRevision, 1),
        altText: text(data.altText, 300, 'alt text', { empty: true }), focalX: fraction(data.focalX), focalY: fraction(data.focalY), retire: data.retire };
      return mutate(context, { operationId: command.operationId, type: 'image.update', entityId: imageId, command: { ...command, productId }, permission: 'commerce:media' }, async client => {
        const product = await requireProduct(client, context.businessId, productId, { lock: true }); expected(product, command.expectedRevision);
        const image = await requireImage(client, context.businessId, productId, imageId); expected(image, command.expectedImageRevision);
        await client.query(`UPDATE commercial_product_images SET alt_text=$4,focal_x=$5,focal_y=$6,
          status=CASE WHEN $7 THEN 'deleted' ELSE status END,deleted_at=CASE WHEN $7 THEN NOW() ELSE NULL END,revision=revision+1,updated_at=NOW()
          WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3`, [context.businessId, productId, imageId, command.altText, command.focalX, command.focalY, command.retire]);
        const losesCover = command.retire && product.cover_image_id === imageId;
        if (losesCover) await client.query('UPDATE commercial_products SET cover_image_id=NULL WHERE owner_phone=$1 AND id=$2', [context.businessId, productId]);
        await touch(client, context, productId, losesCover);
        return readProductDetail(client, context.businessId, productId);
      });
    },
    gallery: async (context, productId, input) => {
      productId = uuid(productId);
      const data = record(input, ['operationId', 'expectedRevision', 'imageIds', 'coverImageId']);
      const imageIds = denseArray(data.imageIds, 8, 'image order').map(uuid);
      if (new Set(imageIds).size !== imageIds.length) fail('INVALID_COMMAND', 'No repitas fotos.', 400);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1), imageIds, coverImageId: data.coverImageId === null ? null : uuid(data.coverImageId) };
      return mutate(context, { operationId: command.operationId, type: 'image.gallery', entityId: productId, command, permission: 'commerce:media' }, async client => {
        const product = await requireProduct(client, context.businessId, productId, { lock: true }); expected(product, command.expectedRevision);
        const images = (await client.query("SELECT id,status FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND status<>'deleted' FOR UPDATE", [context.businessId, productId])).rows;
        if (images.length !== imageIds.length || images.some(image => !imageIds.includes(image.id))) fail('GALLERY_CHANGED', 'La galería cambió. Volvé a cargarla.', 409);
        if (command.coverImageId !== null && !images.some(image => image.id === command.coverImageId && image.status === 'ready')) fail('COVER_NOT_READY', 'Elegí una foto procesada como portada.', 422);
        for (const [index, id] of imageIds.entries()) await client.query('UPDATE commercial_product_images SET sort_order=$4,revision=revision+1,updated_at=NOW() WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3', [context.businessId, productId, id, index]);
        await client.query('UPDATE commercial_products SET cover_image_id=$3 WHERE owner_phone=$1 AND id=$2', [context.businessId, productId, command.coverImageId]);
        await touch(client, context, productId, command.coverImageId === null);
        return readProductDetail(client, context.businessId, productId);
      });
    },
  };
}
