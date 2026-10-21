import express from 'express';
import { randomUUID } from 'node:crypto';
import { CommerceError } from './errors.js';
import { createCommerceProductService } from './productService.js';
import { createCommerceMediaService } from './mediaService.js';
import { MAX_IMAGE_BYTES } from './imageProcessor.js';
import { createCommerceStoryService } from './storyService.js';

/** Authentication middleware must be mounted before this private router. */
export function createCommerceRouter({ runtime, contextOf }) {
  const router = express.Router(), products = createCommerceProductService(runtime);
  const media = createCommerceMediaService(runtime);
  const stories = createCommerceStoryService(runtime);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    req.commerceRequestId = randomUUID();
    const context = contextOf(req);
    if (!context?.actorId || !context?.businessId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Iniciá sesión para abrir Studio.' } });
    req.commerceContext = context; next();
  });
  const handle = (callback, status = 200) => async (req, res, next) => {
    try { res.status(status).json(await callback(req)); } catch (error) { next(error); }
  };
  router.get('/profile', handle(req => products.profile(req.commerceContext)));
  router.put('/profile', handle(req => products.updateProfile(req.commerceContext, req.body)));
  router.get('/summary', handle(req => products.summary(req.commerceContext)));
  router.get('/products', handle(req => products.list(req.commerceContext, req.query)));
  router.post('/products', handle(req => products.create(req.commerceContext, req.body), 201));
  router.get('/products/:id', handle(req => products.detail(req.commerceContext, req.params.id)));
  router.post('/products/:id/story-snapshots', handle(req => stories.prepare(req.commerceContext, req.params.id, req.body), 201));
  router.get('/story-snapshots/:snapshotId', handle(req => stories.recover(req.commerceContext, req.params.snapshotId)));
  router.post('/story-snapshots/:snapshotId/validate', handle(req => stories.validate(req.commerceContext, req.params.snapshotId)));
  router.post('/products/:id/images', handle(req => media.initialize(req.commerceContext, req.params.id, req.body), 201));
  router.put('/products/:id/images/:imageId/content', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES, inflate: false }),
    handle(req => media.upload(req.commerceContext, req.params.id, req.params.imageId, req.body)));
  router.get('/products/:id/images/:imageId/content', async (req, res, next) => {
    try { const bytes = await media.content(req.commerceContext, req.params.id, req.params.imageId, req.query.variant ?? 'master');
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.type('image/jpeg').send(bytes); } catch (error) { next(error); }
  });
  router.patch('/products/:id/images/:imageId', handle(req => media.update(req.commerceContext, req.params.id, req.params.imageId, req.body)));
  router.put('/products/:id/gallery', handle(req => media.gallery(req.commerceContext, req.params.id, req.body)));
  router.patch('/products/:id', handle(req => products.update(req.commerceContext, req.params.id, req.body)));
  router.put('/products/:id/sku-links', handle(req => products.link(req.commerceContext, req.params.id, req.body)));
  router.post('/products/:id/status', handle(req => products.setStatus(req.commerceContext, req.params.id, req.body)));
  router.get('/inventory-candidates', handle(req => products.candidates(req.commerceContext, req.query)));
  router.get('/operations/:id', handle(req => products.recover(req.commerceContext, req.params.id)));
  router.use((error, req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'IMAGE_SIZE_INVALID', message: 'La foto debe pesar hasta 12 MB.' }, requestId: req.commerceRequestId });
    const known = error instanceof CommerceError;
    res.status(known ? error.status : 503).json({ error: { code: known ? error.code : 'COMMERCE_UNAVAILABLE',
      message: known ? error.message : 'No pude consultar o guardar los datos comerciales. Reintentá.',
      ...(known && error.details ? error.details : {}) }, requestId: req.commerceRequestId });
  });
  return router;
}
