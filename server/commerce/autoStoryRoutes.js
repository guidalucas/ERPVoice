import express from 'express';
import { CommerceError } from './errors.js';
import { createAutoStoryService } from './autoStoryService.js';
import { assertSignedRunner, readAutoStoryConfig } from './autoStorySecurity.js';
import { JPEG_LIMIT, MEDIA_PATH, validMediaSignature } from './autoStoryMedia.js';
import { uuid } from './validation.js';

export const RUNNER_PATH = '/api/internal/instagram-auto-story/v1';
export function createAutoStoryRoutes(runtime, media, config = readAutoStoryConfig(process.env), options) {
  const service = createAutoStoryService(runtime, media, config, options);
  const runner = express.Router(), signedMedia = express.Router();
  const handle = callback => async (req, res, next) => {
    try { res.json(await callback(req)); } catch (error) { next(error); }
  };
  runner.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  runner.get('/health', (_req, res) => res.sendStatus(204));
  const authorize = async (req, _res, next) => {
    try {
      if (!config.owner) throw new CommerceError('AUTO_STORY_NOT_CONFIGURED', 'Ejecutor sin configurar.', 503);
      await service.consumeNonce(assertSignedRunner(req, config.workerKey));
      next();
    }
    catch (error) { next(error); }
  };
  runner.post('/claim', authorize, handle(() => service.claim()));
  runner.post('/simulate', authorize, handle(() => service.simulate({ actorId: config.owner, businessId: config.owner, role: 'owner' })));
  const verifyUploadHeaders = (req, _res, next) => {
    try {
      assertSignedRunner(req, config.workerKey, Date.now(), true);
      if (!req.is('image/jpeg')) throw new CommerceError('AUTO_STORY_INVALID_JPEG', 'Tipo de imagen inválido.', 415);
      next();
    } catch (error) { next(error); }
  };
  runner.put('/jobs/:id/jpeg', verifyUploadHeaders, express.raw({ type: 'image/jpeg', limit: JPEG_LIMIT, inflate: false }), authorize,
    handle(req => service.upload(uuid(req.params.id), req.body)));
  runner.post('/jobs/:id/render-failed', authorize, handle(req => service.renderFailed(uuid(req.params.id))));
  runner.post('/jobs/:id/advance', authorize, handle(req => service.advance(uuid(req.params.id))));
  runner.use((error, _req, res, _next) => {
    const known = error instanceof CommerceError;
    const size = error.type === 'entity.too.large';
    res.status(known ? error.status : size ? 413 : 503).json({
      error: { code: known ? error.code : size ? 'AUTO_STORY_INVALID_JPEG' : 'AUTO_STORY_UNAVAILABLE' },
    });
  });
  signedMedia.get('/:id/:expires/:signature.jpg', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const { id, expires, signature } = req.params;
    if (!validMediaSignature(config.mediaKey, id, expires, signature)) return res.sendStatus(404);
    try {
      const jpeg = await service.readImage(id, expires);
      return jpeg ? res.type('image/jpeg').send(jpeg) : res.sendStatus(404);
    } catch { return res.sendStatus(404); }
  });
  return { service, runner, signedMedia, runnerPath: RUNNER_PATH, mediaPath: MEDIA_PATH };
}
