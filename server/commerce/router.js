import express from 'express';
import { randomUUID } from 'node:crypto';
import { CommerceError } from './errors.js';
import { createCommerceProductService } from './productService.js';
import { createCommerceMediaService } from './mediaService.js';
import { MAX_IMAGE_BYTES } from './imageProcessor.js';
import { createCommerceStoryService } from './storyService.js';
import { createCatalogService } from './catalogService.js';
import { createContentService } from './contentService.js';
import { createCommerceSetupService } from './setupService.js';
import { readMoneyPolicy } from './productRepository.js';
import { createBrandAssetService } from './appearance.js';

/** Authentication middleware must be mounted before this private router. */
export function createCommerceRouter({ runtime, contextOf }) {
  const router = express.Router(), products = createCommerceProductService(runtime);
  const media = createCommerceMediaService(runtime);
  const stories = createCommerceStoryService(runtime);
  const catalog = createCatalogService(runtime);
  const content = createContentService(runtime);
  const setup = createCommerceSetupService(runtime);
  const brandAssets = createBrandAssetService(runtime);
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
  router.get('/setup', handle(req => setup.status(req.commerceContext)));
  router.get('/money-policy', handle(req => runtime.withClient(async client => {
    const exists = (await client.query("SELECT to_regclass('public.inventory_money_policies') AS name")).rows[0].name;
    return { moneyPolicy: exists ? await readMoneyPolicy(client, req.commerceContext.businessId) : null };
  })));
  router.post('/setup', handle(req => setup.activate(req.commerceContext, req.body)));
  router.get('/profile', handle(req => products.profile(req.commerceContext)));
  router.get('/money-review', handle(req => products.moneyReview(req.commerceContext, req.query)));
  router.put('/profile', handle(req => products.updateProfile(req.commerceContext, req.body)));
  router.post('/brand-assets/:kind', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES, inflate: false }),
    handle(req => brandAssets.upload(req.commerceContext, req.params.kind, req.body), 201));
  router.get('/brand-assets/:id', async (req, res, next) => {
    try { const asset = await brandAssets.content(req.commerceContext, req.params.id); res.setHeader('X-Content-Type-Options', 'nosniff'); res.type(asset.mime_type).send(asset.content); }
    catch (error) { next(error); }
  });
  router.get('/catalog', handle(req => catalog.configuration(req.commerceContext)));
  router.put('/catalog', handle(req => catalog.configure(req.commerceContext, req.body)));
  router.get('/products/:id/publication', handle(req => catalog.publication(req.commerceContext, req.params.id)));
  router.put('/products/:id/publication', handle(req => catalog.publish(req.commerceContext, req.params.id, req.body)));
  router.get('/summary', handle(req => products.summary(req.commerceContext)));
  router.get('/content-library', handle(req => content.library(req.commerceContext, req.query)));
  router.post('/story-snapshots/:snapshotId/export-events', handle(req => content.recordExport(req.commerceContext, req.params.snapshotId, req.body), 201));
  router.get('/products', handle(req => products.list(req.commerceContext, req.query)));
  router.post('/products', handle(req => products.create(req.commerceContext, req.body), 201));
  router.get('/products/:id', handle(req => products.detail(req.commerceContext, req.params.id)));
  router.get('/products/:id/availability', handle(req => products.availability(req.commerceContext, req.params.id)));
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
