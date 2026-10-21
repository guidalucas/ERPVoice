import express from 'express';
import { fileURLToPath } from 'node:url';
import { CommerceError } from '../commerce/errors.js';
import { createCatalogService } from '../commerce/catalogService.js';
import { renderCatalogList, renderCatalogProduct, renderCatalogError, renderInquiryPage } from './render.js';

export function createPublicCatalogRouters(runtime) {
  const catalog = createCatalogService(runtime), api = express.Router(), pages = express.Router();
  let origin = process.env.COMMERCE_CATALOG_ORIGIN || '';
  if (origin) { const value = new URL(origin); if (!['http:', 'https:'].includes(value.protocol) || value.origin !== origin) throw new Error('INVALID_CATALOG_ORIGIN'); origin = value.origin; }
  const headers = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); };
  api.use(headers);
  const json = callback => async (req, res, next) => { try { res.json(await callback(req)); } catch (error) { next(error); } };
  api.get('/:shop', json(req => catalog.brand(req.params.shop)));
  api.get('/:shop/products', json(req => catalog.list(req.params.shop, req.query)));
  api.post('/:shop/inquiry-preview', json(req => catalog.inquiry(req.params.shop, req.body)));
  api.get('/:shop/products/:slug', json(req => catalog.detail(req.params.shop, req.params.slug)));
  api.get('/:shop/products/:slug/images/:imageId', async (req, res, next) => { try { res.type('image/jpeg').send(await catalog.image(req.params.shop, req.params.slug, req.params.imageId, req.query.variant ?? 'master')); } catch (error) { next(error); } });
  api.use((error, _req, res, _next) => { const known = error instanceof CommerceError; res.status(known ? error.status : 503).json({ error: { code: known ? error.code : 'CATALOG_UNAVAILABLE', message: known ? error.message : 'El catálogo no está disponible.' } }); });
  pages.get('/catalog-assets/catalog.css', (_req, res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(fileURLToPath(new URL('./assets/catalog.css', import.meta.url))); });
  pages.get('/catalog-assets/cart.js', (_req, res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(fileURLToPath(new URL('./assets/cart.js', import.meta.url))); });
  pages.use('/c', headers, (_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
  pages.get('/c/:shop', async (req, res, next) => { try {
    const filters = Object.fromEntries(Object.entries(req.query).filter(([key]) => ['q', 'team', 'season', 'version', 'sleeve', 'kit', 'cursor', 'limit'].includes(key)));
    res.type('html').send(renderCatalogList(await catalog.list(req.params.shop, filters), filters, origin));
  } catch (error) { next(error); } });
  pages.get('/c/:shop/consulta', async (req, res, next) => { try { res.type('html').send(renderInquiryPage(await catalog.brand(req.params.shop), origin)); } catch (error) { next(error); } });
  pages.get('/c/:shop/p/:slug', async (req, res, next) => { try { res.type('html').send(renderCatalogProduct(await catalog.detail(req.params.shop, req.params.slug), origin)); } catch (error) { next(error); } });
  pages.use((error, req, res, next) => { if (!req.path.startsWith('/c/')) return next(error); const status = error instanceof CommerceError ? error.status : 503; res.status(status).type('html').send(renderCatalogError(status)); });
  return { api, pages };
}
