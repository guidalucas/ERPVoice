import http from 'node:http';

// Datos descartables para probar el inventario sin una conexión a PostgreSQL.
const products = [
  { id: 'demo-1', name: 'Camiseta Argentina 2026 Suplente En Version Jugador S', productType: 'Camiseta', productModel: 'Argentina 2026 Suplente En Version Jugador', size: 'S', stockAvailable: 1, stockReserved: 0, price: 65000 },
  { id: 'demo-2', name: 'Camiseta Argentina Titular 2025 2026 M', productType: 'Camiseta', productModel: 'Argentina Titular 2025 2026', size: 'M', stockAvailable: 2, stockReserved: 0, price: 65000 },
  { id: 'demo-3', name: 'Camiseta Argentina Titular Version Jugador L', productType: 'Camiseta', productModel: 'Argentina Titular Version Jugador', size: 'L', stockAvailable: 0, stockReserved: 0, price: 65000 },
];
const transactions = [];
const port = Number(process.env.INVENTORY_FIXTURE_PORT || 3001);
const snapshot = () => ({ products, clients: [], proveedores: [], pedidos: [], transactions });
const readJson = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
};

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173' });
  res.end(JSON.stringify(value));
};

http.createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (path === '/api/auth/dev-status') return send(res, 200, { enabled: true, defaultPhone: '5491100000000' });
  if (path === '/api/auth/dev-login') return send(res, 200, { token: 'inventory-demo', tokenType: 'Bearer', phoneNumber: '5491100000000' });
  if (path === '/api/auth/me') return send(res, 200, { phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Inventario de prueba', businessCategory: 'indumentaria', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
  if (path === '/api/state' && req.method === 'GET') return send(res, 200, snapshot());
  if (path === '/api/state/apply' && req.method === 'POST') {
    const { sourceText, actions } = await readJson(req);
    if (!Array.isArray(actions) || !actions.length) return send(res, 400, { error: 'No hay movimientos para aplicar.' });
    for (const action of actions) {
      if (!['add_stock', 'sell'].includes(action.type) || !Number.isSafeInteger(action.qty) || action.qty <= 0) {
        return send(res, 400, { error: 'Este catálogo de prueba solo admite ingresos y ventas con cantidad válida.' });
      }
      const product = products.find((item) =>
        String(item.productType || '') === String(action.productType || '')
        && String(item.productModel || '') === String(action.productModel || '')
        && String(item.size || '') === String(action.size || '')
        && item.name === action.productName,
      );
      if (!product) return send(res, 404, { error: 'No se encontró el talle seleccionado.' });
      if (action.type === 'sell' && product.stockAvailable < action.qty) return send(res, 400, { error: 'Stock insuficiente.' });
      product.stockAvailable += action.type === 'add_stock' ? action.qty : -action.qty;
    }
    transactions.unshift({ id: `demo-movement-${Date.now()}`, timestamp: new Date().toISOString(), sourceText: String(sourceText || 'Movimiento de prueba'), actions, summary: String(sourceText || 'Movimiento de prueba') });
    return send(res, 200, snapshot());
  }
  if (path === '/api/products/model' && req.method === 'POST') {
    const input = await readJson(req);
    const productType = String(input.productType ?? '').trim();
    const productModel = String(input.productModel ?? '').trim();
    const variants = input.variants;
    if (!productType || !productModel || !Array.isArray(variants) || !variants.length) return send(res, 400, { error: 'Completá el modelo y sus talles.' });
    const sizes = new Set();
    for (const variant of variants) {
      const size = String(variant?.size ?? '').trim();
      const normalizedSize = size.toLocaleLowerCase('es');
      if (!size || sizes.has(normalizedSize) || ![variant?.stockAvailable, variant?.price].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        return send(res, 400, { error: 'Revisá los talles, el stock y el precio.' });
      }
      sizes.add(normalizedSize);
    }
    if (products.some((product) => String(product.productType ?? '').toLocaleLowerCase('es') === productType.toLocaleLowerCase('es') && String(product.productModel ?? '').toLocaleLowerCase('es') === productModel.toLocaleLowerCase('es'))) {
      return send(res, 400, { error: 'Ese modelo ya existe. Agregá el talle desde su tarjeta.' });
    }
    const created = variants.map((variant) => ({
      id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${productType} ${productModel}`,
      productType,
      productModel,
      size: String(variant.size).trim(),
      stockAvailable: variant.stockAvailable,
      stockReserved: 0,
      price: variant.price,
    }));
    products.push(...created);
    return send(res, 201, created);
  }
  if (path === '/api/products' && req.method === 'POST') {
    const product = { id: `demo-${Date.now()}`, ...await readJson(req) };
    products.push(product);
    return send(res, 201, product);
  }
  if (path === '/api/products/model' && req.method === 'PUT') {
    const input = await readJson(req);
    const ids = new Set(input.ids);
    const matching = products.filter((product) => ids.has(product.id));
    if (!ids.size || matching.length !== ids.size) return send(res, 400, { error: 'El modelo cambió. Actualizá la página.' });
    for (const product of matching) {
      product.name = input.name;
      product.productType = input.productType;
      product.productModel = input.productModel;
    }
    return send(res, 200, matching);
  }
  if (path === '/api/products/batch' && req.method === 'DELETE') {
    const input = await readJson(req);
    const ids = [...new Set(Array.isArray(input.ids) ? input.ids : [])];
    if (!ids.length || ids.some((id) => !products.some((product) => product.id === id))) return send(res, 400, { error: 'El inventario cambió. Actualizá la página.' });
    for (const id of ids) products.splice(products.findIndex((product) => product.id === id), 1);
    return send(res, 200, { deleted: ids.length });
  }
  const id = path.startsWith('/api/products/') ? decodeURIComponent(path.slice('/api/products/'.length)) : null;
  const index = id ? products.findIndex((product) => product.id === id) : -1;
  if (index >= 0 && req.method === 'PUT') {
    products[index] = { ...products[index], ...await readJson(req) };
    return send(res, 200, products[index]);
  }
  if (index >= 0 && req.method === 'DELETE') {
    products.splice(index, 1);
    res.writeHead(204);
    return res.end();
  }
  send(res, 404, { error: 'Ruta no disponible en el catálogo de prueba.' });
}).listen(port, '127.0.0.1', () => {
  console.log(`Catálogo de prueba listo en http://127.0.0.1:${port}`);
});
