import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalizePhone } from '../server/phone.js';

export function buildBusinessEnableSql({ owner, currency, confirmedMajorInteger = false }) {
  const phone = normalizePhone(owner);
  if (!/^[0-9]{8,15}$/.test(phone)) throw new Error('EXPLICIT_OWNER_REQUIRED');
  if (!['ARS', 'UYU', 'USD'].includes(currency)) throw new Error('CONFIRMED_CURRENCY_REQUIRED');
  if (confirmedMajorInteger !== true) throw new Error('PRICE_SCALE_CONFIRMATION_REQUIRED');
  return `-- Habilitar el negocio confirmado. Archivo privado local: no subir a Git.
-- Ejecutar DESPUES de SUPABASE_COMMERCIAL_SCHEMA.sql, en el mismo proyecto Stocky.
-- No cambia precios, monedas de SKU, stock, membresias ni publicaciones.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $fullmatch_business$
DECLARE
  owner_phone_value text := '${phone}';
  brand_name_value text;
  existing_policy record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('stocky:commerce:enable:' || owner_phone_value));
  IF (SELECT count(*) FROM commerce_schema_migrations WHERE version IN (1, 2, 3)) <> 3 THEN
    RAISE EXCEPTION 'COMMERCE_SCHEMA_NOT_READY: ejecutar primero las tres migraciones';
  END IF;
  SELECT business_name INTO brand_name_value FROM auth_users
    WHERE phone_number = owner_phone_value FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_NOT_FOUND: el numero confirmado no esta registrado en Stocky'; END IF;
  IF EXISTS (SELECT 1 FROM business_members WHERE member_phone = owner_phone_value AND tenant_phone <> owner_phone_value) THEN
    RAISE EXCEPTION 'OWNER_REQUIRED: esa sesion pertenece a un miembro, no al propietario';
  END IF;
  SELECT * INTO existing_policy FROM inventory_money_policies WHERE owner_phone = owner_phone_value FOR UPDATE;
  IF FOUND THEN
    IF existing_policy.currency <> '${currency}' OR existing_policy.storage_unit <> 'major_integer' OR existing_policy.fraction_digits <> 2 THEN
      RAISE EXCEPTION 'MONEY_POLICY_CONFLICT: revisar la politica existente, no se reemplaza automaticamente';
    END IF;
  ELSE
    INSERT INTO inventory_money_policies(owner_phone, currency, storage_unit, fraction_digits, confirmed_by, confirmed_at)
      VALUES(owner_phone_value, '${currency}', 'major_integer', 2, owner_phone_value, NOW());
  END IF;
  INSERT INTO commerce_profiles(owner_phone, id, brand_name, enabled, created_by)
    VALUES(owner_phone_value, gen_random_uuid(), left(COALESCE(NULLIF(btrim(brand_name_value), ''), 'FullMatch Casacas'), 80), true, owner_phone_value)
    ON CONFLICT(owner_phone) DO UPDATE SET enabled = true,
      revision = commerce_profiles.revision + 1, updated_at = NOW()
      WHERE commerce_profiles.enabled = false;
END
$fullmatch_business$;
COMMIT;

SELECT p.enabled AS studio_habilitado, m.currency AS moneda, m.storage_unit AS escala
FROM commerce_profiles p JOIN inventory_money_policies m USING(owner_phone)
WHERE p.owner_phone = '${phone}';

-- Solo lectura: monedas actuales de los SKU. XXX requiere revision explicita,
-- porque habilitar el perfil no reescribe la moneda de productos existentes.
SELECT price_currency AS moneda_sku, count(*) AS variantes
FROM products WHERE owner_phone = '${phone}' GROUP BY price_currency ORDER BY price_currency;
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  const sql = buildBusinessEnableSql({ owner: args.includes('--owner') ? value('--owner') : '',
    currency: args.includes('--currency') ? value('--currency') : '', confirmedMajorInteger: args.includes('--confirm-major-integer') });
  const root = new URL('../.fullmatch-runtime/', import.meta.url);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(new URL('ENABLE_FULLMATCH_BUSINESS.sql', root), sql, { mode: 0o600 });
  console.log('Generated .fullmatch-runtime/ENABLE_FULLMATCH_BUSINESS.sql (private, ignored by Git; no database connection).');
}
