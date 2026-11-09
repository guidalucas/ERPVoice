import express from 'express';
import { CommerceError } from '../commerce/errors.js';
import { createCatalogService } from '../commerce/catalogService.js';
import { renderCatalogList, renderCatalogProduct, renderCatalogError, renderInquiryPage } from './render.js';
import { catalogThemeCss } from '../../src/shared/catalogAppearance.js';
import { sha256 } from '../commerce/imageProcessor.js';
import { createCatalogAssetHandler } from './staticAssets.js';
import { catalogTiming, measuredCatalogRuntime, measureCatalogPhase } from './timing.js';

export function createPublicCatalogRouters(runtime) {
  const catalog = createCatalogService(measuredCatalogRuntime(runtime)), api = express.Router(), pages = express.Router();
  api.use(catalogTiming);
  pages.use((req, res, next) => req.path.startsWith('/c/') || req.path.startsWith('/catalog-assets/') ? catalogTiming(req, res, next) : next());
  let origin = process.env.COMMERCE_CATALOG_ORIGIN || '';
  if (origin) { const value = new URL(origin); if (!['http:', 'https:'].includes(value.protocol) || value.origin !== origin) throw new Error('INVALID_CATALOG_ORIGIN'); origin = value.origin; }
  const headers = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); };
  api.use(headers);
  const json = callback => async (req, res, next) => { try { res.json(await callback(req)); } catch (error) { next(error); } };
  const revalidated = (req, res, content, type) => {
    res.type(type).set('Cache-Control', 'private, no-cache').set('ETag', `"${sha256(Buffer.from(content))}"`).send(content);
  };
  api.get('/:shop', json(req => catalog.brand(req.params.shop)));
  api.get('/:shop/brand-assets/:id', async (req, res, next) => {
    try { const asset = await catalog.brandAsset(req.params.shop, req.params.id); revalidated(req, res, asset.content, asset.mime_type); } catch (error) { next(error); }
  });
  api.get('/:shop/products', json(req => catalog.list(req.params.shop, req.query)));
  api.post('/:shop/inquiry-preview', json(req => catalog.inquiry(req.params.shop, req.body)));
  api.get('/:shop/products/:slug', json(req => catalog.detail(req.params.shop, req.params.slug)));
  api.get('/:shop/products/:slug/images/:imageId', async (req, res, next) => { try {
    const image = await catalog.image(req.params.shop, req.params.slug, req.params.imageId, req.query.variant ?? 'master', req.query.format ?? 'jpeg', req.get('If-None-Match'));
    res.set('Cache-Control', 'private, no-cache').set('ETag', image.etag);
    if (image.notModified) return res.status(304).end();
    res.type(image.mimeType).send(image);
  } catch (error) { next(error); } });
  api.use((error, _req, res, _next) => { const known = error instanceof CommerceError; res.status(known ? error.status : 503).json({ error: { code: known ? error.code : 'CATALOG_UNAVAILABLE', message: known ? error.message : 'El catálogo no está disponible.' } }); });
  for (const asset of ['catalog.css', 'templates.css', 'cart.js', 'navigation.js', 'catalog.js'])
    pages.get(`/catalog-assets/${asset}`, createCatalogAssetHandler(asset));
  pages.get('/catalog-assets/:shop/theme.css', headers, async (req, res, next) => {
    try {
      const { appearance } = await catalog.brand(req.params.shop);
      revalidated(req, res, catalogThemeCss(appearance), 'css');
    } catch (error) { next(error); }
  });
  pages.use('/c', headers, (_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
  pages.get('/c/:shop', async (req, res, next) => { try {
    const filters = Object.fromEntries(Object.entries(req.query).filter(([key]) => ['q', 'category', 'variant', 'team', 'season', 'version', 'sleeve', 'kit', 'cursor', 'limit'].includes(key)));
    const data = await catalog.list(req.params.shop, filters);
    res.type('html').send(measureCatalogPhase('render', () => renderCatalogList(data, filters, origin)));
  } catch (error) { next(error); } });
  pages.get(['/c/:shop/pedido', '/c/:shop/consulta'], async (req, res, next) => { try { res.type('html').send(renderInquiryPage(await catalog.brand(req.params.shop), origin)); } catch (error) { next(error); } });
  pages.get('/c/:shop/p/:slug', async (req, res, next) => { try {
    const data = await catalog.detail(req.params.shop, req.params.slug);
    res.type('html').send(measureCatalogPhase('render', () => renderCatalogProduct(data, origin)));
  } catch (error) { next(error); } });
  pages.use((error, req, res, next) => { if (!req.path.startsWith('/c/')) return next(error); const status = error instanceof CommerceError ? error.status : 503; const shop = req.path.split('/')[2]; res.status(status).type('html').send(renderCatalogError(status, shop ? `/c/${encodeURIComponent(shop)}` : '/')); });
  return { api, pages };
}
