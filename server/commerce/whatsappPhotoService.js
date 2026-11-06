import { createHash, randomUUID } from 'node:crypto';
import { CommerceError } from './errors.js';
import { requireCommerceAccess } from './operationRepository.js';

const inactivityMs = 15 * 60_000;
const maxPendingPhotos = 8;
const startCommand = /^(?:agregar|adjuntar|cargar)\s+fotos?\s+(?:a|de|para)\s+(.+)$/iu;
const choiceCommand = /^ficha\s+([1-5])$/iu;
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
const photoCount = count => `${count} ${count === 1 ? 'foto' : 'fotos'}`;

async function findProducts(client, businessId, name, partial = false) {
  const key = normalize(name);
  if (!key || key.length > 160) return [];
  const { rows } = await client.query(`WITH matches AS (
    SELECT id,title,slug,identity_key,trim(regexp_replace(lower(regexp_replace(normalize(title,NFD), '[\u0300-\u036f]', '', 'g')), '\\s+', ' ', 'g')) AS title_key
    FROM commercial_products WHERE owner_phone=$1 AND status<>'archived'
  ), candidates AS (
    SELECT id,title,slug,identity_key,(title_key=$2 OR slug=$2) AS exact FROM matches
    WHERE title_key=$2 OR slug=$2 OR ($3 AND starts_with(title_key,$2 || ' '))
  ) SELECT id,title,slug,identity_key AS "identityKey" FROM candidates WHERE exact OR NOT EXISTS (SELECT 1 FROM candidates WHERE exact)
    ORDER BY title,id LIMIT 6`, [businessId, key, partial]);
  return rows;
}

const eventId = (type, id) => `commerce-photo:${type}:${id}`;
const enqueue = (client, id, actor, text) => client.query(`INSERT INTO meta_reply_outbox(event_id,recipient,reply_text)
  VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`, [id, actor, text]);

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

export function createWhatsAppPhotoService({ runtime, media, download, graceMs = 5_000, clock = Date.now }) {
  const save = (client, context, state, dueAt, expiresAt) => client.query(`UPDATE commerce_whatsapp_photo_chats
    SET state=$3,due_at=$4,expires_at=$5 WHERE owner_phone=$1 AND actor_id=$2`,
  [context.businessId, context.actorId, state, dueAt === null ? null : new Date(dueAt), new Date(expiresAt)]);

  const markRouted = async (client, id, handled) => {
    await client.query(`UPDATE meta_message_claims SET commerce_photo_handled=$2,
      status=CASE WHEN $2 THEN 'completed' ELSE status END, completed_at=CASE WHEN $2 THEN NOW() ELSE completed_at END
      WHERE message_id=$1`, [id, handled]);
    return handled;
  };

  const queue = async (client, context, state, product) => {
    if (state.batch?.photos.length) {
      await client.query(`INSERT INTO commerce_whatsapp_photo_jobs(id,owner_phone,actor_id,product,photos)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
      [state.batch.id, context.businessId, context.actorId, { ...product, overflow: state.batch.overflow ?? 0 }, JSON.stringify(state.batch.photos)]);
    }
    state.active = product;
    delete state.batch;
  };

  async function flushBatch(client, context, state, { ask = true } = {}) {
    if (!state.batch) return;
    const { id, photos } = state.batch;
    const references = [...new Set(photos.map(photo => normalize(photo.caption)).filter(Boolean))];
    if (!references.length && state.active && !state.batch.asked) return queue(client, context, state, state.active);
    const choices = references.length === 1 ? await findProducts(client, context.businessId, references[0], true) : [];
    if (choices.length === 1) return queue(client, context, state, choices[0]);
    if (!ask) return;

    const question = choices.length ? selectionPrompt(choices)
      : references.length > 1 ? 'Las fotos traen nombres distintos. ¿A qué ficha va este envío?'
        : references.length ? 'No encontré esa ficha. ¿A qué producto van las fotos?'
          : photos.length === 1 ? '¿A qué producto va esta foto?' : '¿A qué producto van estas fotos?';
    await enqueue(client, eventId('question', state.batch.questionId), context.actorId, question);
    delete state.active;
    state.batch = { ...state.batch, id, asked: true, choices: choices.length <= 5 ? choices : [],
      photos: photos.map(photo => ({ ...photo, caption: '' })) };
  }

  const route = (context, message, phoneNumberId) => runtime.transaction(async client => {
    const claim = (await client.query(`SELECT commerce_photo_handled FROM meta_message_claims
      WHERE message_id=$1 AND owner_phone=$2 AND sender_phone=$3 FOR UPDATE`,
    [message.id, context.businessId, context.actorId])).rows[0];
    if (!claim) return false;
    if (claim.commerce_photo_handled !== null) return claim.commerce_photo_handled;

    const isPhoto = message.type === 'image';
    const text = typeof message.text?.body === 'string' ? message.text.body.trim() : '';
    const command = startCommand.exec(text);
    const explicit = isPhoto || Boolean(command);
    const scope = [context.businessId, context.actorId];
    const now = clock();
    const expiresAt = now + inactivityMs;
    if (explicit) await client.query(`INSERT INTO commerce_whatsapp_photo_chats(owner_phone,actor_id,state,expires_at)
      VALUES($1,$2,'{}'::jsonb,$3) ON CONFLICT(owner_phone,actor_id) DO NOTHING`, [...scope, new Date(expiresAt)]);
    const row = (await client.query(`SELECT state,due_at,expires_at FROM commerce_whatsapp_photo_chats
      WHERE owner_phone=$1 AND actor_id=$2 FOR UPDATE`, scope)).rows[0];
    const state = row && row.expires_at.getTime() > now ? row.state : {};
    if (!explicit && !state.active && !state.batch) return markRouted(client, message.id, false);

    try {
      await requireCommerceAccess(client, context, 'commerce:media');
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      if (explicit) await enqueue(client, eventId('access', message.id), context.actorId, 'Necesitás permiso de edición en Studio para cargar fotos por WhatsApp.');
      await client.query('DELETE FROM commerce_whatsapp_photo_chats WHERE owner_phone=$1 AND actor_id=$2', scope);
      return markRouted(client, message.id, explicit);
    }

    const sentAt = Number(message.timestamp) * 1_000 || now;
    if (sentAt < (state.closedAt ?? 0) || sentAt < now - inactivityMs) return markRouted(client, message.id, explicit);

    if (isPhoto) {
      if (typeof message.image?.id !== 'string' || !/^[\w-]{1,200}$/.test(message.image.id)) {
        await enqueue(client, eventId('invalid', message.id), context.actorId, 'No pude leer esa foto. Probá enviarla de nuevo.');
        return markRouted(client, message.id, true);
      }
      const due = state.batch && row.due_at?.getTime() <= now;
      if (due) await flushBatch(client, context, state);
      const caption = typeof message.image.caption === 'string' ? message.image.caption.trim().slice(0, 1024) : '';
      state.batch ??= { id: message.id, questionId: message.id, photos: [] };
      if (state.batch.photos.length < maxPendingPhotos) {
        state.batch.photos.push({ id: message.id, mediaId: message.image.id, caption, phoneNumberId, sentAt });
        state.batch.photos.sort((first, second) => first.sentAt - second.sentAt);
      } else {
        state.batch.overflow = (state.batch.overflow ?? 0) + 1;
        if (caption && !state.batch.photos.some(photo => photo.caption)) state.batch.photos[0].caption = caption;
      }
      if (caption) state.batch.questionId = message.id;
      const dueAt = state.batch.asked && !caption && (!row.due_at || due) ? null : now + graceMs;
      await save(client, context, state, dueAt, expiresAt);
      return markRouted(client, message.id, true);
    }

    if (command || (state.batch && text)) {
      const choice = choiceCommand.exec(text);
      const product = !command && choice ? state.batch?.choices?.[Number(choice[1]) - 1] : null;
      const choices = product ? [product] : await findProducts(client, context.businessId, command?.[1] ?? text, Boolean(command));
      if (choices.length === 1) {
        if (command && state.active && state.batch && !state.batch.asked) await flushBatch(client, context, state, { ask: false });
        const hadPhotos = Boolean(state.batch?.photos.length);
        await queue(client, context, state, choices[0]);
        if (!hadPhotos) await enqueue(client, eventId('start', message.id), context.actorId, `Mandame las fotos para ${choices[0].title}.`);
        await save(client, context, state, null, expiresAt);
        return markRouted(client, message.id, true);
      }
      if (command || choice || choices.length) {
        state.batch ??= { id: message.id, questionId: message.id, photos: [] };
        state.batch.asked = true;
        state.batch.choices = choices.length <= 5 ? choices : [];
        delete state.active;
        const reply = choices.length ? selectionPrompt(choices) : 'No encontré esa ficha. Decime el nombre completo o elegí una de las opciones.';
        await enqueue(client, eventId('choose', message.id), context.actorId, reply);
        await save(client, context, state, null, expiresAt);
        return markRouted(client, message.id, true);
      }
    }

    // Finish already addressed photos before passing a new topic to the stock flow.
    await flushBatch(client, context, state, { ask: false });
    await save(client, context, { closedAt: sentAt }, null, expiresAt);
    return markRouted(client, message.id, false);
  });

  const flushDue = () => runtime.transaction(async client => {
    const now = new Date(clock());
    await client.query(`DELETE FROM commerce_whatsapp_photo_chats WHERE (owner_phone,actor_id) IN (
      SELECT owner_phone,actor_id FROM commerce_whatsapp_photo_chats WHERE expires_at<=$1 LIMIT 25 FOR UPDATE SKIP LOCKED)`, [now]);
    const { rows } = await client.query(`SELECT * FROM commerce_whatsapp_photo_chats WHERE due_at<=$1 AND expires_at>$1
      ORDER BY due_at LIMIT 10 FOR UPDATE SKIP LOCKED`, [now]);
    for (const row of rows) {
      const context = { businessId: row.owner_phone, actorId: row.actor_id, role: row.owner_phone === row.actor_id ? 'owner' : 'admin' };
      try {
        await requireCommerceAccess(client, context, 'commerce:media');
        await flushBatch(client, context, row.state);
      } catch (error) {
        if (!(error instanceof CommerceError)) throw error;
        await enqueue(client, eventId('access', row.state.batch.id), context.actorId, 'Necesitás permiso de edición en Studio para cargar fotos por WhatsApp.');
        row.state = {};
      }
      await save(client, context, row.state, null, row.expires_at.getTime());
    }
    return rows.length > 0;
  });

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
