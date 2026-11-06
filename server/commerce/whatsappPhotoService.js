import { createHash, randomUUID } from 'node:crypto';
import { CommerceError } from './errors.js';
import { requireCommerceAccess } from './operationRepository.js';
import { inventoryRowToProduct } from '../inventoryPostgres.js';
import { interpretUniversalIntent } from '../universalIntentInterpreter.js';
import { parseUniversalMetaCommand } from '../universalMetaOperations.js';

const inactivityMs = 15 * 60_000;
const maxPendingPhotos = 8;
const startCommand = /^(?:agregar|adjuntar|cargar)\s+fotos?\s+(?:a|de|para)\s+(.+)$/iu;
const choiceCommand = /^ficha\s+([1-5])$/iu;
const confirmCommand = /^confirmar\s+fotos(?:\s+([0-9a-f]{8}))?$/iu;
const cancelCommand = /^cancelar\s+fotos[.!]?$/iu;
const simpleControl = /^(confirmar|cancelar)[.!]?$/iu;
const yes = /^s[ií][.!]?$/iu;
const no = /^no[.!]?$/iu;
const garmentPrefix = '^(?:(?:la|una) )?(?:camisetas?|remeras?) (?:(?:de|del) )?';
const garmentPrefixPattern = new RegExp(garmentPrefix);
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
const photoCount = count => `${count} ${count === 1 ? 'foto' : 'fotos'}`;
const titles = values => [...new Set(values)].slice(0, 3).map(title => `«${title}»`).join(', ');
const archivedNote = products => `Encontré ${titles(products.map(product => product.title))} en Studio, con estado archivado. Restaurá la ficha correcta en Studio o indicame otra ficha activa para estas fotos.`;

async function findProducts(client, businessId, name, partial = false) {
  const key = normalize(name);
  if (!key || key.length > 160) return [];
  const alias = key.replace(garmentPrefixPattern, '');
  const { rows } = await client.query(`WITH matches AS (
    SELECT id,title,slug,identity_key,status,trim(regexp_replace(lower(regexp_replace(normalize(title,NFD), '[\u0300-\u036f]', '', 'g')), '\\s+', ' ', 'g')) AS title_key
    FROM commercial_products WHERE owner_phone=$1
  ), candidates AS (
    SELECT id,title,slug,identity_key,status,CASE
      WHEN title_key=$2 OR slug=$2 THEN 1
      WHEN $4<>'' AND regexp_replace(title_key,$5,'')=$4 THEN 2
      WHEN $3 AND starts_with(title_key,$2 || ' ') THEN 3
    END AS priority FROM matches
  ) SELECT id,title,slug,status,identity_key AS "identityKey" FROM candidates
    WHERE priority=(SELECT MIN(priority) FROM candidates) ORDER BY status='archived',title,id LIMIT 6`,
  [businessId, key, partial, alias, garmentPrefix]);
  return rows;
}

const eventId = (type, id) => `commerce-photo:${type}:${id}`;
const enqueue = (client, id, actor, text) => client.query(`INSERT INTO meta_reply_outbox(event_id,recipient,reply_text)
  VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`, [id, actor, text]);

async function isReplyToPhotoPrompt(client, actor, batch, replyTo) {
  if (!batch?.asked || typeof replyTo !== 'string') return false;
  const prompt = batch.prompt ?? eventId('question', batch.questionId);
  const { rowCount } = await client.query(`SELECT 1 FROM meta_reply_outbox
    WHERE event_id=$1 AND recipient=$2 AND provider_message_ids @> jsonb_build_array($3::text)`, [prompt, actor, replyTo]);
  return rowCount > 0;
}

async function wasPhotoPromptSent(client, actor, prompt, sentAt) {
  const { rowCount } = await client.query(`SELECT 1 FROM meta_reply_outbox WHERE event_id=$1 AND recipient=$2
    AND status='sent' AND date_trunc('second',sent_at)<=$3`, [prompt, actor, new Date(sentAt)]);
  return rowCount > 0;
}

function uploadId(messageId) {
  const bytes = createHash('sha256').update(eventId('image', messageId)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const selectionPrompt = choices => choices.length > 5
  ? 'Encontré varias fichas. Respondé con el nombre completo o el identificador de la ficha.'
  : `¿Cuál ficha querés usar?\n${choices.map((product, index) => `${index + 1}. ${product.title} (${product.slug})`).join('\n')}\nRespondé «ficha 1», «ficha 2», etc.`;

export function createWhatsAppPhotoService({ runtime, media, download, graceMs = 5_000, clock = Date.now, complete }) {
  async function interpretReference(context, { reference, purpose }) {
    const products = await runtime.transaction(async client => {
      await requireCommerceAccess(client, context, 'commerce:media');
      const { rows } = await client.query(`SELECT * FROM products WHERE owner_phone=$1 AND inventory_status='active'
        ORDER BY id LIMIT 1001`, [context.businessId]);
      return rows.map(inventoryRowToProduct);
    }, { readOnly: true });
    return interpretUniversalIntent({ sourceText: reference, purpose, channel: 'whatsapp', operationId: randomUUID(),
      context: { ...context, permissions: ['inventory:read'] }, catalog: { products, clients: [], proveedores: [], pedidos: [] },
      ...(complete ? { complete } : {}) });
  }

  // Resolve references outside transactions, then re-read the chat and links before applying the result.
  async function withReferenceLookup(context, run) {
    const interpreted = new Map();
    for (;;) {
      const result = await runtime.transaction(client => run(client, interpreted));
      if (!result?.lookup) return result;
      const { key } = result.lookup;
      interpreted.set(key, interpreted.size >= 3 ? { kind: 'unavailable' } : await interpretReference(context, result.lookup));
    }
  }

  async function resolveReference(client, context, reference, { partial, purpose, batchId, interpreted }) {
    const direct = await findProducts(client, context.businessId, reference, partial);
    const choices = direct.filter(product => product.status !== 'archived');
    if (direct.length && !choices.length) return { choices, addressed: true, note: archivedNote(direct) };
    if (choices.length || !purpose || !reference || reference.length > 240) return { choices };
    const key = JSON.stringify([batchId, reference, purpose]);
    if (!interpreted.has(key)) return { lookup: { key, reference, purpose } };
    const result = interpreted.get(key);
    if (result.kind !== 'answer') return { choices };
    const ids = result.queries[0].selector.ids;
    if (!ids.length) return { choices, addressed: true };
    const { rows } = await client.query(`SELECT i.name AS sku_name,p.id,p.title,p.slug,p.status,p.identity_key AS "identityKey"
      FROM products i LEFT JOIN commercial_product_skus l ON l.owner_phone=i.owner_phone AND l.sku_id=i.id
      LEFT JOIN commercial_products p ON p.owner_phone=l.owner_phone AND p.id=l.commercial_product_id
      WHERE i.owner_phone=$1 AND i.id=ANY($2) AND i.inventory_status='active' ORDER BY p.title,p.id`, [context.businessId, ids]);
    const products = [...new Map(rows.filter(row => row.id).map(({ sku_name, ...product }) => [product.id, product])).values()];
    const active = products.filter(product => product.status !== 'archived');
    if (active.length) return { choices: active.slice(0, 6), addressed: true };
    if (products.length) return { choices, addressed: true, note: archivedNote(products) };
    const note = rows.length ? `Encontré ${titles(rows.map(row => row.sku_name))} en inventario, pero todavía no tiene una ficha vinculada en Studio. Vinculalo desde Studio o indicame otra ficha activa.` : undefined;
    return { choices, addressed: true, note };
  }

  const save = (client, context, state, dueAt, expiresAt) => client.query(`UPDATE commerce_whatsapp_photo_chats
    SET state=$3,due_at=$4,expires_at=$5 WHERE owner_phone=$1 AND actor_id=$2`,
  [context.businessId, context.actorId, state, dueAt === null ? null : new Date(dueAt), new Date(expiresAt)]);

  const markRouted = async (client, id, handled) => {
    await client.query(`UPDATE meta_message_claims SET commerce_photo_handled=$2,
      status=CASE WHEN $2 THEN 'completed' ELSE status END, completed_at=CASE WHEN $2 THEN NOW() ELSE completed_at END
      WHERE message_id=$1`, [id, handled]);
    return handled;
  };

  const queueConfirmedBatch = async (client, context, state) => {
    const { id, photos, overflow, confirmation: { product } } = state.batch;
    await client.query(`INSERT INTO commerce_whatsapp_photo_jobs(id,owner_phone,actor_id,product,photos)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
    [id, context.businessId, context.actorId, { ...product, overflow: overflow ?? 0 }, JSON.stringify(photos)]);
    state.active = product;
    delete state.batch;
  };

  async function askAboutBatch(client, context, state, prompt, question, choices = []) {
    await enqueue(client, prompt, context.actorId, question);
    delete state.active;
    delete state.batch.confirmation;
    Object.assign(state.batch, { asked: true, prompt, choices: choices.length <= 5 ? choices : [],
      photos: state.batch.photos.map(photo => ({ ...photo, caption: '' })) });
  }

  async function proposeBatch(client, context, state, product, sourceId) {
    const code = randomUUID().slice(0, 8);
    const review = [
      `Carga de fotos · ${product.title}`,
      `* Cantidad: ${photoCount(state.batch.photos.length)}.`,
      '',
      'Respondé «confirmar» para guardar, «cancelar» para descartar, o escribí qué querés corregir.',
      '',
      'La vigencia del borrador es de 15 minutos.',
    ].join('\n');
    await askAboutBatch(client, context, state, eventId('confirm', sourceId), review);
    state.batch.confirmation = { product, code };
  }

  async function flushBatch(client, context, state, interpreted) {
    if (!state.batch || state.batch.confirmation) return;
    const { id, photos } = state.batch;
    const references = new Map(photos.filter(photo => photo.caption).map(photo => [normalize(photo.caption), photo.caption]));
    if (!references.size && state.active && !state.batch.asked) {
      await proposeBatch(client, context, state, state.active, state.batch.questionId);
      return;
    }
    const match = references.size === 1 ? await resolveReference(client, context, references.values().next().value,
      { partial: true, purpose: 'photo-reference', batchId: id, interpreted }) : { choices: [] };
    if (match.lookup) return match;
    const { choices } = match;
    if (choices.length === 1) {
      await proposeBatch(client, context, state, choices[0], state.batch.questionId);
      return;
    }

    const question = choices.length ? selectionPrompt(choices) : match.note
      ?? (references.size > 1 ? 'Las fotos traen nombres distintos. ¿A qué ficha va este envío?'
        : references.size ? 'No encontré esa ficha. ¿A qué producto van las fotos?'
          : photos.length === 1 ? '¿A qué producto va esta foto?' : '¿A qué producto van estas fotos?');
    await askAboutBatch(client, context, state, eventId('question', state.batch.questionId), question, choices);
  }

  const route = (context, message, phoneNumberId) => withReferenceLookup(context, async (client, interpreted) => {
    const claim = (await client.query(`SELECT commerce_photo_handled FROM meta_message_claims
      WHERE message_id=$1 AND owner_phone=$2 AND sender_phone=$3 FOR UPDATE`,
    [message.id, context.businessId, context.actorId])).rows[0];
    if (!claim) return false;
    if (claim.commerce_photo_handled !== null) return claim.commerce_photo_handled;

    const isPhoto = message.type === 'image';
    const text = typeof message.text?.body === 'string' ? message.text.body.trim() : '';
    const command = startCommand.exec(text);
    const confirm = confirmCommand.exec(text);
    const cancel = cancelCommand.test(text);
    const control = simpleControl.exec(text)?.[1].toLowerCase();
    const explicit = isPhoto || Boolean(command || confirm || cancel);
    const scope = [context.businessId, context.actorId];
    const now = clock();
    const expiresAt = now + inactivityMs;
    if (isPhoto || command) await client.query(`INSERT INTO commerce_whatsapp_photo_chats(owner_phone,actor_id,state,expires_at)
      VALUES($1,$2,'{}'::jsonb,$3) ON CONFLICT(owner_phone,actor_id) DO NOTHING`, [...scope, new Date(expiresAt)]);
    const row = (await client.query(`SELECT state,due_at,expires_at FROM commerce_whatsapp_photo_chats
      WHERE owner_phone=$1 AND actor_id=$2 FOR UPDATE`, scope)).rows[0];
    const state = row && row.expires_at.getTime() > now ? row.state : {};
    const photoContext = Boolean(state.active || state.batch || state.photoControl);
    const photoControl = photoContext ? control : undefined;
    if (!explicit && !photoContext) return markRouted(client, message.id, false);

    try {
      await requireCommerceAccess(client, context, 'commerce:media');
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      if (explicit || photoControl) await enqueue(client, eventId('access', message.id), context.actorId, 'Necesitás permiso de edición en Studio para cargar fotos por WhatsApp.');
      await client.query('DELETE FROM commerce_whatsapp_photo_chats WHERE owner_phone=$1 AND actor_id=$2', scope);
      return markRouted(client, message.id, explicit || Boolean(photoControl));
    }

    const sentAt = Number(message.timestamp) * 1_000 || now;
    if (sentAt < (state.closedAt ?? 0) || sentAt < now - inactivityMs) return markRouted(client, message.id, explicit || Boolean(photoControl));

    if (isPhoto) {
      if (typeof message.image?.id !== 'string' || !/^[\w-]{1,200}$/.test(message.image.id)) {
        await enqueue(client, eventId('invalid', message.id), context.actorId, 'No pude leer esa foto. Probá enviarla de nuevo.');
        return markRouted(client, message.id, true);
      }
      const caption = typeof message.image.caption === 'string' ? message.image.caption.trim().slice(0, 1024) : '';
      state.batch ??= { id: message.id, questionId: message.id, photos: [] };
      if (state.batch.confirmation) {
        state.active = state.batch.confirmation.product;
        delete state.batch.confirmation;
        delete state.batch.prompt;
        state.batch.asked = false;
        state.batch.questionId = message.id;
      }
      if (!state.batch.photos.length) {
        await enqueue(client, eventId('processing', state.batch.id), context.actorId, 'Recibí tu envío. Estoy procesando la carga de fotos…');
      }
      if (state.batch.photos.length < maxPendingPhotos) {
        state.batch.photos.push({ id: message.id, mediaId: message.image.id, caption, phoneNumberId, sentAt });
        state.batch.photos.sort((first, second) => first.sentAt - second.sentAt);
      } else {
        state.batch.overflow = (state.batch.overflow ?? 0) + 1;
        if (caption && !state.batch.photos.some(photo => photo.caption)) state.batch.photos[0].caption = caption;
      }
      if (caption) state.batch.questionId = message.id;
      const dueAt = state.batch.asked && !caption && !row.due_at ? null : now + graceMs;
      await save(client, context, state, dueAt, expiresAt);
      return markRouted(client, message.id, true);
    }

    const quoted = await isReplyToPhotoPrompt(client, context.actorId, state.batch, message.context?.id);
    const confirmation = state.batch?.confirmation;
    if (confirm || photoControl === 'confirmar' || (confirmation && yes.test(text))) {
      const acceptsCurrent = confirmation && (
        confirm?.[1]?.toLowerCase() === confirmation.code ||
        (quoted && (photoControl === 'confirmar' || yes.test(text))) ||
        (photoControl === 'confirmar' && !message.context?.id && await wasPhotoPromptSent(client, context.actorId, state.batch.prompt, sentAt))
      );
      if (acceptsCurrent) {
        await queueConfirmedBatch(client, context, state);
        await save(client, context, state, null, expiresAt);
      } else {
        const reply = confirmation ? 'Respondé «confirmar» después de recibir la propuesta vigente para estas fotos.'
          : 'No hay una confirmación de fotos vigente. Esperá la propuesta o volvé a mandar las fotos.';
        await enqueue(client, eventId('confirm-invalid', message.id), context.actorId, reply);
      }
      return markRouted(client, message.id, true);
    }
    if (cancel || photoControl === 'cancelar') {
      const hasPending = Boolean(state.batch || state.active);
      const acceptsCurrent = cancel || !message.context?.id || quoted;
      if (row && acceptsCurrent) await save(client, context, { closedAt: sentAt, photoControl: true }, null, expiresAt);
      const reply = !acceptsCurrent ? 'Respondé «cancelar» para descartar la carga de fotos vigente.'
        : hasPending ? 'Cerré la carga de fotos pendiente.' : 'No hay una carga de fotos pendiente.';
      await enqueue(client, eventId('cancelled', message.id), context.actorId, reply);
      return markRouted(client, message.id, true);
    }
    if (confirmation && no.test(text)) {
      await askAboutBatch(client, context, state, eventId('choose', message.id), '¿A qué ficha van estas fotos?');
      await save(client, context, state, null, expiresAt);
      return markRouted(client, message.id, true);
    }

    const stockControl = control || parseUniversalMetaCommand(text);
    if (command || (state.batch && text && !stockControl)) {
      const choice = choiceCommand.exec(text);
      const product = !command && choice ? state.batch?.choices?.[Number(choice[1]) - 1] : null;
      const purpose = choice ? null : command || quoted ? 'photo-reference' : state.batch?.asked ? 'photo-reply' : null;
      const match = product ? { choices: [product] } : await resolveReference(client, context, command?.[1] ?? text,
        { partial: Boolean(command), purpose, batchId: state.batch?.id ?? message.id, interpreted });
      if (match.lookup) return match;
      const { choices } = match;
      if (choices.length === 1) {
        if (state.batch?.photos.length) {
          await proposeBatch(client, context, state, choices[0], message.id);
        } else {
          state.active = choices[0];
          delete state.batch;
          await enqueue(client, eventId('start', message.id), context.actorId, `Mandame las fotos para ${choices[0].title}.`);
        }
        await save(client, context, state, null, expiresAt);
        return markRouted(client, message.id, true);
      }
      if (command || choice || choices.length || quoted || match.addressed) {
        state.batch ??= { id: message.id, questionId: message.id, photos: [] };
        const reply = choices.length ? selectionPrompt(choices) : match.note ?? 'No encontré esa ficha en Studio. Decime algún detalle más, como el modelo, el color o el año.';
        await askAboutBatch(client, context, state, eventId('choose', message.id), reply, choices);
        await save(client, context, state, null, expiresAt);
        return markRouted(client, message.id, true);
      }
    }

    await save(client, context, { closedAt: sentAt }, null, expiresAt);
    return markRouted(client, message.id, false);
  });

  const dueChats = () => runtime.transaction(async client => {
    const now = new Date(clock());
    await client.query(`DELETE FROM commerce_whatsapp_photo_chats WHERE (owner_phone,actor_id) IN (
      SELECT owner_phone,actor_id FROM commerce_whatsapp_photo_chats WHERE expires_at<=$1 LIMIT 25 FOR UPDATE SKIP LOCKED)`, [now]);
    const { rows } = await client.query(`SELECT owner_phone,actor_id FROM commerce_whatsapp_photo_chats WHERE due_at<=$1 AND expires_at>$1
      ORDER BY due_at LIMIT 10`, [now]);
    return rows;
  });

  const flushDue = async () => {
    const rows = await dueChats();
    const results = await Promise.allSettled(rows.map(({ owner_phone, actor_id }) => {
      const context = { businessId: owner_phone, actorId: actor_id, role: owner_phone === actor_id ? 'owner' : 'admin' };
      return withReferenceLookup(context, async (client, interpreted) => {
        const { rows: [row] } = await client.query(`SELECT state,expires_at FROM commerce_whatsapp_photo_chats
          WHERE owner_phone=$1 AND actor_id=$2 AND due_at<=$3 AND expires_at>$3 FOR UPDATE SKIP LOCKED`,
        [owner_phone, actor_id, new Date(clock())]);
        if (!row) return false;
        try {
          await requireCommerceAccess(client, context, 'commerce:media');
          const pending = await flushBatch(client, context, row.state, interpreted);
          if (pending) return pending;
        } catch (error) {
          if (!(error instanceof CommerceError)) throw error;
          await enqueue(client, eventId('access', row.state.batch.id), context.actorId, 'Necesitás permiso de edición en Studio para cargar fotos por WhatsApp.');
          row.state = {};
        }
        const expiresAt = row.state.batch?.confirmation ? clock() + inactivityMs : row.expires_at.getTime();
        await save(client, context, row.state, null, expiresAt);
        return true;
      });
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.some(result => result.value);
  };

  const claimJob = () => runtime.transaction(async client => {
    const { rows } = await client.query(`WITH next AS (
      SELECT job.id FROM commerce_whatsapp_photo_jobs job WHERE job.available_at<=NOW() AND (job.lease_until IS NULL OR job.lease_until<=NOW())
        AND NOT EXISTS (SELECT 1 FROM commerce_whatsapp_photo_jobs earlier WHERE earlier.owner_phone=job.owner_phone
          AND earlier.actor_id=job.actor_id AND (earlier.created_at,earlier.id)<(job.created_at,job.id))
      ORDER BY job.available_at,job.created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE commerce_whatsapp_photo_jobs job SET lease_token=$1,lease_until=NOW()+INTERVAL '5 minutes'
      FROM next WHERE job.id=next.id RETURNING job.*`, [randomUUID()]);
    return rows[0];
  });

  const processJob = async () => {
    const job = await claimJob();
    if (!job) return false;
    const context = { businessId: job.owner_phone, actorId: job.actor_id, role: job.owner_phone === job.actor_id ? 'owner' : 'admin' };
    for (const photo of job.photos.slice(job.results.length)) {
      let failure = null;
      try {
        const operationId = uploadId(photo.id);
        if (!await media.isWhatsAppUploadReady(context, job.product.id, operationId)) {
          const bytes = await download(photo.mediaId, photo.phoneNumberId);
          const initialized = await media.initializeWhatsApp(context, job.product, operationId, bytes);
          await media.upload(context, job.product.id, initialized.result.imageId, bytes, { whatsapp: true });
        }
      } catch (error) {
        const retryable = !(error instanceof CommerceError) || error.status >= 500 || error.status === 429 || error.code === 'IMAGE_PROCESSING';
        if (retryable && job.attempts < 2) {
          await runtime.withClient(client => client.query(`UPDATE commerce_whatsapp_photo_jobs SET attempts=attempts+1,
            available_at=NOW()+($3*INTERVAL '1 second'),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
          [job.id, job.lease_token, error.code === 'IMAGE_PROCESSING' ? 120 : 15]));
          return false;
        }
        failure = error instanceof CommerceError ? error.message : 'No pude guardar una foto. Probá enviarla de nuevo.';
      }
      job.results.push(failure);
      job.attempts = 0;
      const persisted = await runtime.withClient(client => client.query(`UPDATE commerce_whatsapp_photo_jobs SET results=$3,attempts=0,
        lease_until=NOW()+INTERVAL '5 minutes' WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token, JSON.stringify(job.results)]));
      if (!persisted.rowCount) return false;
    }
    return runtime.transaction(async client => {
      const deleted = await client.query('DELETE FROM commerce_whatsapp_photo_jobs WHERE id=$1 AND lease_token=$2', [job.id, job.lease_token]);
      if (!deleted.rowCount) return false;
      const saved = job.results.filter(result => result === null).length;
      const failures = [...new Set(job.results.filter(Boolean))];
      const overflow = job.product.overflow;
      if (overflow) failures.push(`${photoCount(overflow)} fuera del límite de 8 por ficha.`);
      const missed = job.photos.length + overflow - saved;
      const result = saved ? `Agregué ${photoCount(saved)} a ${job.product.title}.` : `No pude agregar fotos a ${job.product.title}.`;
      const note = missed ? ` Quedaron sin guardar ${photoCount(missed)}. ${failures.join(' ')}` : '';
      await enqueue(client, eventId('result', job.id), context.actorId, result + note);
      return true;
    });
  };

  return { route, flushDue, processJob };
}
