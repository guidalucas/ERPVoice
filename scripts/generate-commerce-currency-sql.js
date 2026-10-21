import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizePhone } from '../server/phone.js';

// Explicit administrative correction, never called by HTTP or application startup.
export function buildCurrencyCorrectionSql({ owner, currency, expectedUnknownCount, confirmedMajorInteger = false, operationId = randomUUID() }) {
  const phone = normalizePhone(owner);
  if (!/^[0-9]{8,15}$/.test(phone)) throw new Error('EXPLICIT_OWNER_REQUIRED');
  if (!['ARS', 'UYU', 'USD'].includes(currency) || confirmedMajorInteger !== true) throw new Error('CONFIRMED_MONEY_POLICY_REQUIRED');
  if (!Number.isSafeInteger(expectedUnknownCount) || expectedUnknownCount < 1 || expectedUnknownCount > 1000) throw new Error('CONFIRMED_UNKNOWN_COUNT_REQUIRED');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) throw new Error('INVALID_OPERATION_ID');
  return `-- Correccion administrativa de moneda XXX al codigo confirmado por el propietario.
-- Archivo privado local. Verificar proyecto y respaldo; ejecutar COMPLETO en SQL Editor.
-- No convierte importes, no cambia stock, identidad, fotos ni otras monedas/negocios.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $confirmed_currency$
DECLARE
  owner_value text := '${phone}';
  operation_value uuid := '${operationId}';
  sku_ids text[];
  changed_count integer;
  before_rows jsonb;
  after_rows jsonb;
  before_revisions jsonb;
  request_value jsonb := jsonb_build_object('sourceCurrency', 'XXX', 'currency', '${currency}',
    'expectedUnknownCount', ${expectedUnknownCount}, 'storageUnit', 'major_integer',
    'reason', 'Moneda y escala confirmadas expresamente por el propietario');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('stocky:commerce:currency:' || owner_value));
  IF EXISTS(SELECT 1 FROM commercial_operations WHERE owner_phone = owner_value AND operation_id = operation_value) THEN
    IF NOT EXISTS(SELECT 1 FROM commercial_operations WHERE owner_phone = owner_value AND operation_id = operation_value
      AND operation_type = 'maintenance.currency_confirmed' AND request_json = request_value) THEN
      RAISE EXCEPTION 'CURRENCY_CORRECTION_RECEIPT_CONFLICT';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM auth_users WHERE phone_number = owner_value)
    OR EXISTS(SELECT 1 FROM business_members WHERE member_phone = owner_value AND tenant_phone <> owner_value)
    OR NOT EXISTS(SELECT 1 FROM commerce_profiles WHERE owner_phone = owner_value AND enabled) THEN
    RAISE EXCEPTION 'ENABLED_OWNER_REQUIRED';
  END IF;
  PERFORM 1 FROM inventory_money_policies WHERE owner_phone = owner_value
    AND currency = '${currency}' AND storage_unit = 'major_integer' AND fraction_digits = 2 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONFIRMED_MONEY_POLICY_REQUIRED'; END IF;
  PERFORM 1 FROM products WHERE owner_phone = owner_value AND price_currency = 'XXX' ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO sku_ids FROM products WHERE owner_phone = owner_value AND price_currency = 'XXX';
  IF COALESCE(cardinality(sku_ids), 0) <> ${expectedUnknownCount} THEN
    RAISE EXCEPTION 'UNKNOWN_CURRENCY_COUNT_CHANGED: revisar el conteo antes de corregir';
  END IF;
  IF EXISTS(SELECT 1 FROM products WHERE owner_phone = owner_value AND id = ANY(sku_ids)
    AND (price IS NULL OR price < 0 OR price > 9007199254740991 OR price <> trunc(price::numeric))) THEN
    RAISE EXCEPTION 'PRICE_SCALE_NOT_READY: hay importes fuera de la escala confirmada';
  END IF;
  SELECT jsonb_agg(to_jsonb(p) - 'price_currency' - 'inventory_revision' ORDER BY p.id),
    jsonb_agg(jsonb_build_object('skuId', p.id, 'revision', p.inventory_revision) ORDER BY p.id)
    INTO before_rows, before_revisions FROM products p WHERE owner_phone = owner_value AND id = ANY(sku_ids);

  UPDATE products SET price_currency = '${currency}', inventory_revision = inventory_revision + 1
    WHERE owner_phone = owner_value AND id = ANY(sku_ids) AND price_currency = 'XXX';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  SELECT jsonb_agg(to_jsonb(p) - 'price_currency' - 'inventory_revision' ORDER BY p.id)
    INTO after_rows FROM products p WHERE owner_phone = owner_value AND id = ANY(sku_ids);
  IF changed_count <> ${expectedUnknownCount} OR before_rows IS DISTINCT FROM after_rows THEN
    RAISE EXCEPTION 'CURRENCY_CORRECTION_DATA_MISMATCH: se revierte toda la correccion';
  END IF;
  INSERT INTO commercial_operations(owner_phone, operation_id, actor_id, operation_type, request_hash, request_json, result_json)
    VALUES(owner_value, operation_value, owner_value, 'maintenance.currency_confirmed',
      encode(sha256(convert_to(request_value::text, 'UTF8')), 'hex'), request_value,
      jsonb_build_object('contractVersion', 1, 'operationId', operation_value, 'status', 'applied', 'result',
        jsonb_build_object('changed', changed_count, 'currency', '${currency}', 'priceAmountsUnchanged', true,
          'stockUnchanged', true, 'previousRevisions', before_revisions)));
END
$confirmed_currency$;
COMMIT;

SELECT (result_json->'result'->>'changed')::integer AS variantes_corregidas,
  result_json->'result'->>'currency' AS moneda FROM commercial_operations
WHERE owner_phone = '${phone}' AND operation_id = '${operationId}';
SELECT price_currency AS moneda_sku, count(*) AS variantes FROM products
WHERE owner_phone = '${phone}' GROUP BY price_currency ORDER BY price_currency;
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = key => args.includes(key) ? args[args.indexOf(key) + 1] : '';
  const sql = buildCurrencyCorrectionSql({ owner: value('--owner'), currency: value('--currency'),
    expectedUnknownCount: Number(value('--expected-unknown-count')), confirmedMajorInteger: args.includes('--confirm-major-integer') });
  const root = new URL('../.fullmatch-runtime/', import.meta.url); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(new URL('CORRECT_FULLMATCH_CURRENCY.sql', root), sql, { mode: 0o600 });
  console.log('Generated .fullmatch-runtime/CORRECT_FULLMATCH_CURRENCY.sql (private; no database connection).');
}
