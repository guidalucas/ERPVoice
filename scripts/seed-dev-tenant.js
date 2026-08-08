import dotenv from 'dotenv';
import {
  applyActionsToDatabase,
  createClientRecord,
  createPedidoRecord,
  createProductRecord,
  getStateSnapshot,
  hasDatabaseConfig,
  upsertAuthUser,
} from '../server/postgresDatabase.js';
import { normalizePhone } from '../server/phone.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const ownerPhone = normalizePhone(process.env.AUTH_DEV_PHONE || process.argv[2] || '5491100000000');

if (!ownerPhone) {
  console.error('[seed-dev] Número inválido. Usá AUTH_DEV_PHONE o pasá el teléfono como argumento.');
  process.exit(1);
}

if (!hasDatabaseConfig()) {
  console.error('[seed-dev] Falta SUPABASE_DATABASE_URL / DATABASE_URL en el entorno.');
  process.exit(1);
}

const seedProducts = [
  { productType: 'Camiseta', productModel: 'Boca Titular', size: 'S', stockAvailable: 8, stockReserved: 1, price: 45000 },
  { productType: 'Camiseta', productModel: 'Boca Titular', size: 'M', stockAvailable: 12, stockReserved: 2, price: 45000 },
  { productType: 'Camiseta', productModel: 'Boca Titular', size: 'L', stockAvailable: 5, stockReserved: 0, price: 45000 },
  { productType: 'Camiseta', productModel: 'River Titular', size: 'M', stockAvailable: 10, stockReserved: 0, price: 48000 },
  { productType: 'Camiseta', productModel: 'River Titular', size: 'L', stockAvailable: 2, stockReserved: 1, price: 48000 },
  { productType: 'Camiseta', productModel: 'Argentina', size: 'M', stockAvailable: 1, stockReserved: 0, price: 65000 },
  { productType: 'Camiseta', productModel: 'Argentina', size: 'L', stockAvailable: 0, stockReserved: 0, price: 65000 },
  { productType: 'Short', productModel: 'Boca', size: 'M', stockAvailable: 15, stockReserved: 0, price: 22000 },
];

const seedClients = [
  { name: 'Jere', notas: 'Cliente demo' },
  { name: 'Lucas', notas: 'Cliente demo' },
  { name: 'Maru', notas: null },
];

const main = async () => {
  console.log(`[seed-dev] Sembrando datos para owner_phone=${ownerPhone}`);

  await upsertAuthUser(ownerPhone);

  const before = await getStateSnapshot(ownerPhone);
  if (before.products.length > 0 || before.clients.length > 0 || before.pedidos.length > 0) {
    console.log(
      `[seed-dev] Ya había data: ${before.products.length} productos, ${before.clients.length} clientes, ${before.pedidos.length} pedidos.`,
    );
    console.log('[seed-dev] No borro nada; agrego un set adicional de demo.');
  }

  const products = [];
  for (const product of seedProducts) {
    const created = await createProductRecord(product, ownerPhone);
    products.push(created);
    console.log(`[seed-dev] producto ${created.name} (stock ${created.stockAvailable})`);
  }

  const clients = [];
  for (const client of seedClients) {
    const created = await createClientRecord(client, ownerPhone);
    clients.push(created);
    console.log(`[seed-dev] cliente ${created.name}`);
  }

  const jere = clients.find((client) => client.name === 'Jere');
  const lucas = clients.find((client) => client.name === 'Lucas');
  const maru = clients.find((client) => client.name === 'Maru');

  if (jere) {
    await createPedidoRecord(
      {
        clienteId: jere.id,
        producto: 'Camiseta Boca Titular',
        productType: 'Camiseta',
        productModel: 'Boca Titular',
        talle: 'M',
        qty: 1,
        estado: 'pendiente',
        notas: 'Pedido demo por voz',
      },
      ownerPhone,
    );
  }

  if (lucas) {
    await createPedidoRecord(
      {
        clienteId: lucas.id,
        producto: 'Camiseta Argentina',
        productType: 'Camiseta',
        productModel: 'Argentina',
        talle: 'L',
        qty: 2,
        estado: 'pendiente',
      },
      ownerPhone,
    );
  }

  if (maru) {
    await createPedidoRecord(
      {
        clienteId: maru.id,
        producto: 'Short Boca',
        productType: 'Short',
        productModel: 'Boca',
        talle: 'M',
        qty: 1,
        estado: 'conseguido',
      },
      ownerPhone,
    );
  }

  await applyActionsToDatabase(
    [
      {
        type: 'add_stock',
        productName: 'Camiseta Boca Titular',
        productType: 'Camiseta',
        productModel: 'Boca Titular',
        size: 'M',
        qty: 3,
        price: 45000,
      },
      {
        type: 'add_stock',
        productName: 'Camiseta River Titular',
        productType: 'Camiseta',
        productModel: 'River Titular',
        size: 'L',
        qty: 2,
        price: 48000,
      },
    ],
    'compré 3 boca titular M y 2 river titular L',
    ownerPhone,
  );

  await applyActionsToDatabase(
    [
      {
        type: 'sell',
        productName: 'Short Boca',
        productType: 'Short',
        productModel: 'Boca',
        size: 'M',
        qty: 1,
        price: 22000,
      },
    ],
    'vendí 1 short boca M',
    ownerPhone,
  );

  if (jere) {
    await applyActionsToDatabase(
      [
        {
          type: 'client_order',
          clientName: 'Jere',
          productName: 'Camiseta Boca Titular',
          productType: 'Camiseta',
          productModel: 'Boca Titular',
          size: 'S',
          qty: 1,
        },
      ],
      'Jere me pidió una camiseta de Boca talle S',
      ownerPhone,
    );
  }

  const after = await getStateSnapshot(ownerPhone);
  console.log('[seed-dev] Listo.');
  console.log(
    `[seed-dev] Totales: ${after.products.length} productos, ${after.clients.length} clientes, ${after.pedidos.length} pedidos, ${after.transactions.length} movimientos.`,
  );
  console.log(`[seed-dev] Entrá en modo local con el teléfono ${ownerPhone}.`);
};

main().catch((error) => {
  console.error('[seed-dev] Falló:', error instanceof Error ? error.message : error);
  process.exit(1);
});
