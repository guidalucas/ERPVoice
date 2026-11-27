// Explicit business configuration repair. No schema, inventory or publication changes.
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCommerceProductService } from '../server/commerce/productService.js';

const envPath = process.argv.find(arg => arg.startsWith('--env-file='))?.slice(11);
if (!envPath) throw new Error('EXPLICIT_ENV_FILE_REQUIRED');
const env = dotenv.parse(await fs.readFile(envPath));
const connectionString = env.COMMERCE_DATABASE_URL || env.SUPABASE_DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_NOT_CONFIGURED');
const remote = !['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname);
if (remote && !process.argv.includes('--allow-remote-database')) throw new Error('EXPLICIT_REMOTE_DATABASE_REQUIRED');
const caPath = process.argv.find(arg => arg.startsWith('--ca-file='))?.slice(10);
const runtime = createDatabaseRuntime({ connectionString, ssl: remote ? { rejectUnauthorized: true, ...(caPath ? { ca: await fs.readFile(caPath, 'utf8') } : {}) } : false });
const contactOnly = process.argv.includes('--contact-only');
try {
  const target = await runtime.withClient(async client => (await client.query(`SELECT c.owner_phone,c.slug,p.brand_name,p.sales_whatsapp FROM commerce_catalogs c
    JOIN commerce_profiles p ON p.owner_phone=c.owner_phone WHERE c.slug=$1 AND c.public_enabled AND p.enabled`, ['fullmatch-casacas'])).rows[0]);
  if (!target || target.brand_name !== 'FullMatch Casacas' || !['3454326660', '5493454326660'].includes(target.sales_whatsapp)) throw new Error('EXPECTED_CATALOG_CONTACT_MISMATCH');
  const context = { actorId: target.owner_phone, businessId: target.owner_phone, role: 'owner' };
  const service = createCommerceProductService(runtime), profile = await service.profile(context);
  const appearance = { ...profile.appearance, storeInfo: { shipping: '', sizeGuide: '', ...profile.appearance.storeInfo,
    address: 'Alvear 818 · Concordia, Entre Ríos', instagram: 'fmcasacas', payments: 'Todos los medios de pago. Coordiná el pago por WhatsApp al confirmar tu pedido.' } };
  const unchanged = profile.salesWhatsapp === '5493454326660' && (contactOnly || JSON.stringify(profile.appearance) === JSON.stringify(appearance));
  console.log(JSON.stringify({ catalog: target.slug, mode: process.argv.includes('--apply') ? 'apply' : 'preview', unchanged,
    contactOnly, salesWhatsapp: '5493454326660', ...(!contactOnly ? { storeInfo: appearance.storeInfo } : {}) }));
  if (process.argv.includes('--apply') && !unchanged) {
    const operationId = randomUUID();
    const receipt = await service.updateProfile(context, { operationId, expectedRevision: profile.revision, brandName: profile.brandName, salesWhatsapp: '5493454326660', ...(!contactOnly ? { appearance } : {}) });
    const saved = await service.profile(context);
    if (saved.salesWhatsapp !== '5493454326660' || (!contactOnly && saved.appearance.storeInfo.address !== appearance.storeInfo.address)) throw new Error('PROFILE_VERIFICATION_FAILED');
    console.log(JSON.stringify({ applied: true, operationId, status: receipt.status, revision: saved.revision }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : 'STOREFRONT_CONFIGURATION_FAILED') }));
  process.exitCode = 1;
} finally { await runtime.close(); }
