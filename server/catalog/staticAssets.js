import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

// Small, public, deployment-scoped assets: compress once, outside the request path.
export function createCatalogAssetHandler(asset) {
  let prepared;
  const prepare = () => prepared ??= (async () => {
    const sources = asset === 'catalog.js' ? ['cart.js', 'navigation.js'] : [asset];
    const content = Buffer.from((await Promise.all(sources.map(name => readFile(new URL(`./assets/${name}`, import.meta.url), 'utf8')))).join('\n;\n'));
    return { identity: content, gzip: gzipSync(content), br: brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
      etag: `W/"${createHash('sha256').update(content).digest('hex')}"` };
  })().catch(error => { prepared = undefined; throw error; });
  return async (req, res, next) => {
    try {
      const data = await prepare(), encoding = req.acceptsEncodings('br', 'gzip', 'identity');
      res.vary('Accept-Encoding').type(asset.endsWith('.css') ? 'css' : 'js')
        .set('Cache-Control', 'public, max-age=3600').set('ETag', data.etag).set('X-Content-Type-Options', 'nosniff');
      if (!encoding) return res.status(406).end();
      if (encoding !== 'identity') res.set('Content-Encoding', encoding);
      res.send(data[encoding]);
    } catch (error) { next(error); }
  };
}
