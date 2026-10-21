import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Client } from 'pg';
import * as db from '../../server/postgresDatabase.js';
import { issueJwt } from '../../server/auth.js';
import { migrateCommerce } from '../../server/commerce/migration.js';
import { createCommerceProductService } from '../../server/commerce/productService.js';
import { createCommerceMediaService } from '../../server/commerce/mediaService.js';
import { sha256 } from '../../server/commerce/imageProcessor.js';
import { migrateCatalog } from '../../server/commerce/catalogMigration.js';
import { createCatalogService } from '../../server/commerce/catalogService.js';
import { migrateAppearance } from '../../server/commerce/appearanceMigration.js';
import { migrateContent } from '../../server/commerce/contentMigration.js';

const connection = new URL(process.env.COMMERCE_DATABASE_URL ?? 'invalid:');
const manifest = path.resolve(process.env.FULLMATCH_FIXTURE_MANIFEST ?? 'invalid');
if (process.env.FULLMATCH_FIXTURE_SEED !== 'isolated-local-only' || !['127.0.0.1', 'localhost'].includes(connection.hostname)
  || !/^\/fullmatch_fixture_[a-f0-9]+$/.test(connection.pathname) || path.dirname(manifest) !== process.cwd()
  || !path.basename(process.cwd()).startsWith('fullmatch-fixture-') || process.env.NODE_ENV !== 'test') throw new Error('ISOLATED_FIXTURE_REQUIRED');
const owner = '59899000088', context = { businessId: owner, actorId: owner, role: 'owner' }, sql = new Client({ connectionString: connection.toString() });
try {
  await db.migrateDatabase(); await sql.connect(); await migrateCommerce(sql); await migrateCatalog(sql); await migrateContent(sql); await migrateAppearance(sql);
  await db.saveBusinessProfile(owner, { businessName: 'FullMatch · DEMO', businessCategory: 'indumentaria' });
  await sql.query("INSERT INTO commerce_profiles(owner_phone,id,brand_name,enabled,created_by,sales_whatsapp) VALUES($1,$2,'FULLMATCH CASACAS · DEMO',true,$1,'59899000088')", [owner, randomUUID()]);
  await sql.query("INSERT INTO inventory_money_policies(owner_phone,currency,storage_unit,fraction_digits,confirmed_by,confirmed_at) VALUES($1,'ARS','major_integer',2,'fixture',NOW())", [owner]);
  const catalog = createCatalogService(db.stockyDatabaseRuntime);
  await catalog.configure(context, { operationId: randomUUID(), expectedRevision: 0, slug: 'fullmatch-demo', publicEnabled: true });
  const products = createCommerceProductService(db.stockyDatabaseRuntime), media = createCommerceMediaService(db.stockyDatabaseRuntime), created = [];
  const teams = [{ name: 'Barcelona', key: 'barcelona', color: '#b91e4a', accent: '#173c8a', stock: [2, 1], price: 65000 },
    { name: 'Argentina', key: 'argentina', color: '#76c8ef', accent: '#ffffff', stock: [1], price: 70000 },
    { name: 'Real Madrid', key: 'real-madrid', color: '#f7f7f7', accent: '#c2ae63', stock: [0, 3], price: 62000 }];
  for (const team of teams) {
    const skus = [];
    for (const [index, stock] of team.stock.entries()) skus.push(await db.createProductRecord({ name: `Demo ${team.name} 2025`, size: ['M', 'L'][index], stockAvailable: stock,
      price: team.price, priceCurrency: 'ARS', productType: 'Camiseta', productModel: `Demo ${team.name}` }, owner, { operationId: randomUUID() }));
    let product = (await products.create(context, { operationId: randomUUID(), product: { title: `${team.name} titular 2025`, description: 'Ilustración y datos descartables de demostración. No es una foto comercial.', teamKey: team.key,
      teamName: team.name, teamKind: team.name === 'Argentina' ? 'national_team' : 'club', season: '2025', kitKey: 'home', versionKey: 'player', sleeveKey: 'short' },
    skuLinks: skus.map(sku => ({ skuId: sku.id, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint })) })).result;
    // Synthetic fixture art, clearly separate from real commercial photographs.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#eceff4"/><ellipse cx="400" cy="850" rx="220" ry="20" fill="#d9dfe8"/><path d="M260 190L140 275L205 410L270 380L260 810L540 810L530 380L595 410L660 275L540 190L460 160Q400 225 340 160Z" fill="${team.color}" stroke="#293b5b" stroke-width="3"/><path d="M350 207L350 807L410 807L410 207Z M470 197L470 807L525 807L520 215Z M275 218L275 807L295 807L295 200Z" fill="${team.accent}"/><path d="M340 160Q400 225 460 160L450 187Q400 240 350 187Z" fill="#001a4d"/><text x="400" y="530" font-family="Arial" font-weight="bold" font-size="42" fill="white" text-anchor="middle">FULLMATCH</text><text x="400" y="930" font-family="Arial" font-size="20" fill="#8090a8" text-anchor="middle">ILUSTRACIÓN DE PRUEBA · DEMO</text></svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    const initialized = (await media.initialize(context, product.id, { operationId: randomUUID(), expectedRevision: product.revision, sourceSha256: sha256(bytes), sourceSizeBytes: bytes.length, altText: `Ilustración de prueba ${team.name}` })).result;
    product = await media.upload(context, product.id, initialized.imageId, bytes);
    product = (await products.setStatus(context, product.id, { operationId: randomUUID(), expectedRevision: product.revision, status: 'ready', reason: 'Isolated demonstration fixture' })).result;
    await catalog.publish(context, product.id, { operationId: randomUUID(), expectedRevision: 0, expectedProductRevision: product.revision, status: 'published', reason: 'Only isolated DEMO fixture' });
    created.push({ id: product.id, title: product.title, skuIds: skus.map(sku => sku.id) });
  }
  await db.createProductRecord({ name: 'Demo Boca Juniors pendiente', size: 'XL', stockAvailable: 2, price: 63000, priceCurrency: 'ARS' }, owner, { operationId: randomUUID() });
  const freshOwners = ['59899000091', '59899000092', '59899000094'].map(phoneNumber => ({ owner: phoneNumber, token: issueJwt({ phoneNumber }) }));
  for (const fresh of freshOwners) await sql.query('INSERT INTO auth_users(phone_number) VALUES($1)', [fresh.owner]);
  const member = { owner: '59899000093', token: issueJwt({ phoneNumber: '59899000093' }) };
  await sql.query('INSERT INTO auth_users(phone_number) VALUES($1)', [member.owner]);
  await sql.query("INSERT INTO business_members(tenant_phone,member_phone,role) VALUES($1,$2,'member')", [owner, member.owner]);
  await fs.writeFile(manifest, JSON.stringify({ owner, token: issueJwt({ phoneNumber: owner }), products: created, freshOwners, member }), { mode: 0o600 });
} finally { await db.closeDatabase(); await sql.end().catch(() => {}); }
