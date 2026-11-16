import { randomUUID } from 'node:crypto';
import { requireCommerceAccess } from './operationRepository.js';
import { createBrandAssetService } from './appearance.js';
import { selectAutoStory, revalidateAutoStory } from './autoStorySelection.js';
import { createInstagramStoryPublisher } from './instagramStoryPublisher.js';
import { digest, sealToken, unsealToken } from './autoStorySecurity.js';
import { temporaryStoryUrl, validateStoryJpeg } from './autoStoryMedia.js';
import { fail } from './errors.js';

const active = "('rendering','ready','creating','publishing','unknown')";
const zone = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric', month: '2-digit', day: '2-digit' });
export const businessDate = now => {
  const parts = Object.fromEntries(zone.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export function nextStoryAttempt(now) {
  const day = new Date(now).setUTCHours(0, 0, 0, 0);
  const times = [12, 15, 19, 23, 36].map(hour => day + (hour * 60 + 17) * 60_000);
  return new Date(times.find(time => time > now)).toISOString();
}
const windowClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});
export function storyWindow(now) {
  const time = windowClock.format(now);
  if (time >= '20:17') return 4;
  if (time >= '16:17') return 3;
  if (time >= '12:17') return 2;
  return 1;
}
const isCurrentWindow = (job, time) => job.business_date === businessDate(time) && job.publication_window === storyWindow(time);
const publicError = error => {
  const code = error?.status >= 400 && error?.status < 500 ? error.code : error?.message;
  return typeof code === 'string' && /^[A-Z][A-Z_]{2,70}$/.test(code) ? code : 'AUTO_STORY_FAILED';
};
const connectionError = error => ({
  META_TOKEN_EXPIRED: 'expired', META_TOKEN_REVOKED: 'revoked', META_PERMISSION_DENIED: 'error', META_ACCOUNT_MISMATCH: 'error', META_BUSINESS_ACCOUNT_REQUIRED: 'error',
})[publicError(error)];
const jobState = async (client, owner, id, status, next, error = null) => (await client.query(`
  UPDATE commerce_auto_story_jobs SET status=$4,error_code=$5,updated_at=now()
  WHERE owner_phone=$1 AND id=$2 AND status=$3 RETURNING id`, [owner, id, status, next, error])).rowCount > 0;

export function createAutoStoryService(runtime, media, config, { meta = createInstagramStoryPublisher(config), now = Date.now } = {}) {
  const brands = createBrandAssetService(runtime);
  const worker = { actorId: config.owner, businessId: config.owner, role: 'owner' };
  const transaction = (callback, repeatableRead = false) => runtime.transaction(callback, { repeatableRead });
  const readSettings = async (client, owner, lock = false) => (await client.query(`
    SELECT * FROM commerce_auto_story_settings WHERE owner_phone=$1${lock ? ' FOR UPDATE' : ''}`, [owner])).rows[0];
  const ensureSettings = (client, owner) => client.query('INSERT INTO commerce_auto_story_settings(owner_phone) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
  const tokenSource = () => digest(config.token);
  const currentCredentials = row => {
    const refreshed = row?.token_source === tokenSource() && row.refreshed_token;
    return refreshed ? { token: unsealToken(config.encryptionKey, config.owner, row.refreshed_token), expires: +row.token_expires_at }
      : { token: config.token, expires: config.expiresAt };
  };
  const connection = (owner, row) => {
    if (!config.liveReady || config.owner !== owner) return 'not_configured';
    const sameSource = row?.token_source === tokenSource();
    const expires = sameSource && row.token_expires_at ? +row.token_expires_at : config.expiresAt;
    if (expires <= now()) return 'expired';
    if (!row || (row.token_source && !sameSource && row.connection_status !== 'connected')) return 'pending';
    return row.connection_status;
  };
  const markConnection = (owner, error) => {
    const status = connectionError(error);
    if (status) return runtime.withClient(async client => {
      await ensureSettings(client, owner);
      return client.query('UPDATE commerce_auto_story_settings SET connection_status=$2 WHERE owner_phone=$1', [owner, status]);
    });
  };
  const preflight = async (token, account) => {
    const result = await meta.verifyPublishing(token, account);
    if (!Array.isArray(result.data) || !result.data.length) throw new Error('META_PERMISSION_DENIED');
    return result.data[0];
  };
  const requireOwner = context => {
    if (context.actorId !== context.businessId || context.role !== 'owner') fail('AUTO_STORY_OWNER_REQUIRED', 'El propietario debe autorizar la automatización.', 403);
  };
  const preview = async (context, selected) => {
    if (!selected) return { status: 'skipped', code: 'NO_ELIGIBLE_PRODUCT' };
    const { snapshot } = selected;
    const { productId, imageId, appearance, imageSha256 } = snapshot.content;
    const [photo, logo] = await Promise.all([media.content(context, productId, imageId),
      appearance.logoId ? brands.content(context, appearance.logoId) : null]);
    if (digest(photo) !== imageSha256) fail('STORY_IMAGE_CHANGED', 'La foto cambió antes de renderizar.', 409);
    return { status: 'rendering', id: snapshot.snapshotId, snapshot, photo: photo.toString('base64'),
      logo: logo && { type: logo.mime_type, bytes: logo.content.toString('base64') } };
  };
  const credentials = async (owner, account, { reconcile = false } = {}) => transaction(async client => {
    const row = await readSettings(client, owner, true);
    if (!config.liveReady || row?.instagram_id !== account || (!reconcile && (!row.enabled || connection(owner, row) !== 'connected'))) {
      throw new Error('META_CONNECTION_REQUIRED');
    }
    const current = currentCredentials(row);
    if (current.expires <= now()) throw new Error('META_TOKEN_EXPIRED');
    // Re-check account when the deployment operator replaces the bootstrap token.
    if (row.token_source !== tokenSource()) {
      if ((await meta.account(current.token)).id !== account) throw new Error('META_ACCOUNT_MISMATCH');
      await preflight(current.token, account);
      await client.query('UPDATE commerce_auto_story_settings SET token_source=$2,refreshed_token=NULL,token_expires_at=$3 WHERE owner_phone=$1',
        [owner, tokenSource(), new Date(current.expires)]);
    }
    if (!reconcile && current.expires - now() < 7 * 86_400_000) {
      const fresh = await meta.refresh(current.token);
      if (typeof fresh.access_token !== 'string' || !(fresh.expires_in > 0)) throw new Error('META_INVALID_RESPONSE');
      await client.query('UPDATE commerce_auto_story_settings SET refreshed_token=$2,token_source=$3,token_expires_at=$4 WHERE owner_phone=$1',
        [owner, sealToken(config.encryptionKey, owner, fresh.access_token), tokenSource(), new Date(now() + fresh.expires_in * 1000)]);
      return fresh.access_token;
    }
    return current.token;
  });
  const complete = (owner, id, mediaId) => runtime.withClient(async client => {
    const { rowCount } = await client.query(`UPDATE commerce_auto_story_jobs SET status='published',media_id=COALESCE($3,media_id),
      published_at=COALESCE(published_at,now()),error_code=NULL,updated_at=now()
      WHERE owner_phone=$1 AND id=$2 AND status IN ('publishing','unknown','published')`, [owner, id, mediaId]);
    return { status: rowCount ? 'published' : 'unknown' };
  });
  const reconcile = async (owner, job, existingToken) => {
    try {
      const token = existingToken ?? await credentials(owner, job.instagram_id, { reconcile: true });
      const status = await meta.status(token, job.container_id);
      if (status === 'PUBLISHED') return complete(owner, job.id, null);
      if (['EXPIRED', 'ERROR'].includes(status)) {
        await runtime.withClient(client => jobState(client, owner, job.id, 'unknown', 'failed', `META_CONTAINER_${status}`));
        return { status: 'failed', code: `META_CONTAINER_${status}` };
      }
    } catch (error) { await markConnection(owner, error); }
    return { status: 'unknown', code: 'META_PUBLICATION_UNCERTAIN' };
  };

  const renderFailed = (id, code = 'RENDER_FAILED') => runtime.withClient(async client => {
    await jobState(client, worker.businessId, id, 'rendering', 'failed', code);
    return { status: 'failed', code };
  });

  return {
    consumeNonce: async nonce => transaction(async client => {
      await client.query('DELETE FROM commerce_auto_story_requests WHERE owner_phone=$1 AND expires_at<=now()', [config.owner]);
      await client.query('UPDATE commerce_auto_story_jobs SET jpeg=NULL WHERE owner_phone=$1 AND jpeg IS NOT NULL AND jpeg_expires_at<=now()', [config.owner]);
      const result = await client.query(`INSERT INTO commerce_auto_story_requests (owner_phone,nonce,expires_at) VALUES ($1,$2,now()+interval '5 minutes')
        ON CONFLICT DO NOTHING`, [config.owner, nonce]);
      if (!result.rowCount) fail('AUTO_STORY_REPLAY', 'La solicitud ya se usó.', 409);
    }),
    status: context => transaction(async client => {
      await requireCommerceAccess(client, context, 'commerce:story');
      const present = await client.query("SELECT 1 FROM commerce_schema_migrations WHERE version=7");
      if (!present.rowCount) return { ready: false, enabled: false, connection: 'not_configured', history: [], lastPublished: null };
      const row = await readSettings(client, context.businessId);
      const columns = "id,status,error_code,product_id,business_date::text,created_at,published_at,media_id,snapshot#>>'{content,title}' AS title";
      const history = (await client.query(`SELECT ${columns} FROM commerce_auto_story_jobs WHERE owner_phone=$1 ORDER BY created_at DESC LIMIT 30`, [context.businessId])).rows;
      const lastPublished = (await client.query(`SELECT ${columns} FROM commerce_auto_story_jobs WHERE owner_phone=$1 AND status='published' ORDER BY published_at DESC LIMIT 1`, [context.businessId])).rows[0] ?? null;
      return { ready: true, enabled: row?.enabled ?? false, connection: connection(context.businessId, row),
        instagramId: row?.instagram_id, instagramUsername: row?.instagram_username, nextAttempt: row?.enabled ? nextStoryAttempt(now()) : null, history, lastPublished };
    }),
    configure: async (context, input) => {
      requireOwner(context);
      const { enabled, verifyBusiness } = input ?? {};
      if (typeof enabled !== 'boolean' || (verifyBusiness !== undefined && typeof verifyBusiness !== 'boolean')) fail('INVALID_COMMAND', 'Configuración inválida.', 400);
      const owner = context.businessId;
      try {
        return await transaction(async client => {
          await requireCommerceAccess(client, context, 'commerce:settings');
          await ensureSettings(client, owner);
          const row = await readSettings(client, owner, true);
          if (verifyBusiness && config.liveReady && config.owner === owner) {
            const current = currentCredentials(row);
            if (current.expires <= now()) throw new Error('META_TOKEN_EXPIRED');
            const account = await meta.account(current.token);
            await preflight(current.token, account.id);
            if (row.instagram_id && row.instagram_id !== account.id && (await client.query(
              `SELECT 1 FROM commerce_auto_story_jobs WHERE owner_phone=$1 AND status IN ('publishing','unknown')`, [owner])).rowCount) {
              fail('AUTO_STORY_UNRESOLVED', 'Resolvé la publicación incierta antes de cambiar de cuenta.', 409);
            }
            await client.query(`UPDATE commerce_auto_story_settings SET instagram_id=$2,connection_status='connected',
              authorization_at=now(),token_expires_at=$3,refreshed_token=CASE WHEN token_source=$4 THEN refreshed_token ELSE NULL END,
              token_source=$4,instagram_username=$5 WHERE owner_phone=$1`, [owner, account.id, new Date(current.expires), tokenSource(), account.username]);
          }
          if (enabled && (connection(owner, await readSettings(client, owner)) !== 'connected')) fail('META_CONNECTION_REQUIRED', 'Primero verificá y autorizá una cuenta Business de Instagram.', 409);
          await client.query('UPDATE commerce_auto_story_settings SET enabled=$2 WHERE owner_phone=$1', [owner, enabled]);
          return { enabled };
        });
      } catch (error) {
        if (publicError(error).startsWith('META_') && !error.status) {
          await markConnection(owner, error);
          fail(publicError(error), 'Meta no pudo verificar la conexión de Instagram.', 422);
        }
        throw error;
      }
    },
    productPreference: (context, productId, enabled) => transaction(async client => {
      await requireCommerceAccess(client, context, 'commerce:write');
      if (!(await client.query("SELECT 1 FROM commerce_schema_migrations WHERE version=6")).rowCount) return { ready: false };
      const row = (await client.query('SELECT auto_story_enabled FROM commercial_products WHERE owner_phone=$1 AND id=$2', [context.businessId, productId])).rows[0];
      if (!row) fail('RESOURCE_NOT_FOUND', 'No encontré la ficha comercial.', 404);
      if (enabled === undefined) return { enabled: row.auto_story_enabled };
      if (typeof enabled !== 'boolean') fail('INVALID_COMMAND', 'Configuración inválida.', 400);
      await client.query('UPDATE commercial_products SET auto_story_enabled=$3 WHERE owner_phone=$1 AND id=$2', [context.businessId, productId, enabled]);
      return { enabled };
    }),
    simulate: async context => {
      const selection = await transaction(async client => {
        await requireCommerceAccess(client, context, 'commerce:story');
        const row = await readSettings(client, context.businessId);
        return selectAutoStory(client, context, randomUUID(), row?.instagram_id ?? null);
      }, true);
      return preview(context, selection);
    },
    async claim(requestedTime) {
      const owner = worker.businessId;
      const result = await transaction(async client => {
        await requireCommerceAccess(client, worker, 'commerce:story');
        if (!(await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=7')).rowCount) {
          fail('AUTO_STORY_MIGRATION_REQUIRED', 'Falta aplicar la migración de ventanas de publicación.', 503);
        }
        await ensureSettings(client, owner);
        const row = await readSettings(client, owner, true);
        const time = now();
        const day = businessDate(time);
        const window = storyWindow(time);
        if (requestedTime !== undefined && (requestedTime > time || businessDate(requestedTime) !== day || storyWindow(requestedTime) !== window)) {
          return { status: 'skipped', code: 'STORY_WINDOW_CLOSED' };
        }
        const job = (await client.query(`SELECT id,status,instagram_id,container_id,business_date::text,publication_window,lease_until,
          jpeg_expires_at FROM commerce_auto_story_jobs WHERE owner_phone=$1 AND status IN ${active}`, [owner])).rows[0];
        if (job?.status === 'unknown') return { reconcile: job };
        if (job?.status === 'publishing') {
          if (+job.lease_until > now()) return { status: 'busy' };
          return await jobState(client, owner, job.id, 'publishing', 'unknown', 'META_PUBLICATION_UNCERTAIN')
            ? { reconcile: job } : { status: 'busy' };
        }
        if (job) {
          if (isCurrentWindow(job, time) && job.instagram_id === row.instagram_id &&
            (+job.lease_until > now() || job.status === 'ready' && +job.jpeg_expires_at > now())) {
            if (job.status === 'ready' && row.enabled && connection(owner, row) === 'connected') return { status: 'ready', id: job.id };
            return { status: 'busy' };
          }
          await jobState(client, owner, job.id, job.status, 'failed', 'JOB_LEASE_EXPIRED');
        }
        if (!row.enabled) return { status: 'skipped', code: 'AUTOMATION_DISABLED' };
        const connected = connection(owner, row);
        if (connected !== 'connected') return { status: 'skipped', code: `META_${connected.toUpperCase()}` };
        if ((await client.query(`
          SELECT 1 FROM commerce_auto_story_jobs WHERE owner_phone=$1 AND instagram_id=$2 AND status='published'
          AND business_date=$3 AND publication_window=$4
        `, [owner, row.instagram_id, day, window])).rowCount) return { status: 'skipped', code: 'ALREADY_PUBLISHED' };
        const id = randomUUID();
        const selection = await selectAutoStory(client, worker, id, row.instagram_id);
        await client.query(`INSERT INTO commerce_auto_story_jobs
          (id,owner_phone,instagram_id,business_date,product_id,cycle,snapshot,status,error_code,lease_until,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes',$10)`, [id, owner, row.instagram_id, day,
          selection?.snapshot.content.productId ?? null, selection?.cycle ?? null, selection?.snapshot ?? null,
          selection ? 'rendering' : 'skipped', selection ? null : 'NO_ELIGIBLE_PRODUCT', new Date(time)]);
        return { selection };
      });
      if (result.reconcile) return reconcile(owner, result.reconcile);
      if (!Object.hasOwn(result, 'selection')) return result;
      try { return await preview(worker, result.selection); }
      catch (error) {
        await renderFailed(result.selection.snapshot.snapshotId, publicError(error));
        return { status: 'failed', code: publicError(error) };
      }
    },
    renderFailed,
    upload: async (id, bytes) => {
      try { await validateStoryJpeg(bytes); }
      catch (error) {
        await runtime.withClient(client => jobState(client, worker.businessId, id, 'rendering', 'failed', 'AUTO_STORY_INVALID_JPEG'));
        throw error;
      }
      return runtime.withClient(async client => {
        const { rowCount } = await client.query(`UPDATE commerce_auto_story_jobs SET jpeg=$3,jpeg_expires_at=now()+interval '1 hour',
          status='ready',updated_at=now() WHERE owner_phone=$1 AND id=$2 AND status='rendering' AND lease_until>now()`,
        [worker.businessId, id, bytes]);
        if (!rowCount) fail('AUTO_STORY_JOB_STALE', 'El intento de renderizado ya no está vigente.', 409);
        return { status: 'ready', id };
      });
    },
    async advance(id) {
      const owner = worker.businessId;
      const start = await transaction(async client => {
        await requireCommerceAccess(client, worker, 'commerce:story');
        const row = await readSettings(client, owner, true);
        const job = (await client.query(`SELECT id,status,instagram_id,business_date::text,publication_window,container_id,snapshot,
          jpeg_expires_at FROM commerce_auto_story_jobs WHERE owner_phone=$1 AND id=$2 FOR UPDATE`, [owner, id])).rows[0];
        if (!job) fail('RESOURCE_NOT_FOUND', 'No encontré el intento.', 404);
        if (job.status !== 'ready') return { status: job.status };
        const time = now();
        if (!row?.enabled || row.instagram_id !== job.instagram_id || connection(owner, row) !== 'connected'
          || !isCurrentWindow(job, time) || !isCurrentWindow(job, time + 30_000) || +job.jpeg_expires_at <= time) {
          await jobState(client, owner, id, 'ready', 'failed', 'JOB_NO_LONGER_ELIGIBLE');
          return { status: 'failed', code: 'JOB_NO_LONGER_ELIGIBLE' };
        }
        const lease = await client.query(`UPDATE commerce_auto_story_jobs SET status='creating',lease_until=now()+interval '3 minutes',updated_at=now()
          WHERE owner_phone=$1 AND id=$2 AND status='ready'`, [owner, id]);
        return lease.rowCount ? { job } : { status: 'busy' };
      });
      if (!start.job) return start;
      const job = start.job;
      let token, publishing = false;
      try {
        token = await credentials(owner, job.instagram_id);
        if (!job.container_id) {
          await transaction(client => revalidateAutoStory(client, worker, job.snapshot), true);
          const quota = await preflight(token, job.instagram_id);
          if (typeof quota.config?.quota_total === 'number' && quota.quota_usage >= quota.config.quota_total) throw new Error('META_RATE_LIMIT');
          job.container_id = await meta.create(token, job.instagram_id, temporaryStoryUrl(config, id, +job.jpeg_expires_at));
          const saved = await runtime.withClient(client => client.query(`UPDATE commerce_auto_story_jobs SET container_id=$3
            WHERE owner_phone=$1 AND id=$2 AND status='creating' AND lease_until>now()`, [owner, id, job.container_id]));
          if (!saved.rowCount) return { status: 'failed', code: 'JOB_LEASE_EXPIRED' };
        }
        const state = await meta.status(token, job.container_id);
        if (state === 'IN_PROGRESS') {
          await runtime.withClient(client => jobState(client, owner, id, 'creating', 'ready'));
          return { status: 'processing', id };
        }
        if (state !== 'FINISHED') throw new Error(['EXPIRED', 'ERROR'].includes(state) ? `META_CONTAINER_${state}` : 'META_INVALID_RESPONSE');
        publishing = await transaction(async client => {
          await requireCommerceAccess(client, worker, 'commerce:story');
          const row = await readSettings(client, owner, true);
          if (!row?.enabled || row.instagram_id !== job.instagram_id || connection(owner, row) !== 'connected'
            || !isCurrentWindow(job, now() + 30_000)) throw new Error('JOB_NO_LONGER_ELIGIBLE');
          await revalidateAutoStory(client, worker, job.snapshot);
          return (await client.query(`UPDATE commerce_auto_story_jobs SET status='publishing',lease_until=now()+interval '3 minutes',updated_at=now()
            WHERE owner_phone=$1 AND id=$2 AND status='creating' AND lease_until>now()`, [owner, id])).rowCount > 0;
        }, true);
        if (!publishing) return { status: 'failed', code: 'JOB_LEASE_EXPIRED' };
        const mediaId = await meta.publish(token, job.instagram_id, job.container_id);
        return await complete(owner, id, mediaId);
      } catch (error) {
        await markConnection(owner, error);
        const code = publicError(error);
        await runtime.withClient(client => jobState(client, owner, id, publishing ? 'publishing' : 'creating', publishing ? 'unknown' : 'failed', code));
        return publishing ? reconcile(owner, job, token) : { status: 'failed', code };
      }
    },
    readImage: (id, expires) => runtime.withClient(async client => {
      const { rows } = await client.query(`SELECT jpeg FROM commerce_auto_story_jobs WHERE id=$1
        AND jpeg_expires_at>now() AND floor(extract(epoch FROM jpeg_expires_at)*1000)=$2`, [id, expires]);
      return rows[0]?.jpeg;
    }),
  };
}
