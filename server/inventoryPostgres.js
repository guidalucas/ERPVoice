import crypto from 'node:crypto';
import { validateOperationPlan, operationDigest, planInventoryOperation, inventoryProductFingerprint, productIdentity, InventoryOperationError } from './inventoryOperations.js';
import { loadProductFamilySchemas } from './productFamilyPostgres.js';
import { enforceInventoryMoneyPolicy, inventoryPriceToMoney } from './inventoryMoneyPolicy.js';

// Additive metadata; numeric widening preserves the existing integer values.
export const INVENTORY_SCHEMA_SQL = `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_unit TEXT NOT NULL DEFAULT 'unit';
  ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS price_currency TEXT NOT NULL DEFAULT 'XXX';
  ALTER TABLE products ADD COLUMN IF NOT EXISTS family_id TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS family_version BIGINT;
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='products'::regclass AND conname='products_family_reference_check') THEN
      ALTER TABLE products ADD CONSTRAINT products_family_reference_check CHECK(
        (family_id IS NULL AND family_version IS NULL) OR (family_id IS NOT NULL AND family_version IS NOT NULL AND family_version>0));
    END IF;
  END $$;
  ALTER TABLE products ALTER COLUMN stock_available TYPE BIGINT;
  ALTER TABLE products ALTER COLUMN stock_reserved TYPE BIGINT;
  ALTER TABLE products ALTER COLUMN price TYPE BIGINT;
  CREATE TABLE IF NOT EXISTS inventory_operations (
    owner_phone TEXT NOT NULL, operation_id TEXT NOT NULL, contract_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL, request_hash TEXT NOT NULL, plan_json JSONB NOT NULL,
    result_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_phone, operation_id)
  );
  CREATE TABLE IF NOT EXISTS inventory_movements (
    owner_phone TEXT NOT NULL, operation_id TEXT NOT NULL, item_id TEXT NOT NULL,
    sku_id TEXT NOT NULL, delta_available BIGINT NOT NULL, delta_reserved BIGINT NOT NULL,
    unit TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_phone, operation_id, item_id),
    FOREIGN KEY (owner_phone, operation_id) REFERENCES inventory_operations(owner_phone, operation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_movements_sku ON inventory_movements(owner_phone, sku_id, created_at);
  CREATE TABLE IF NOT EXISTS inventory_selections (
    owner_phone TEXT NOT NULL, selection_id TEXT NOT NULL, request_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, request_hash TEXT NOT NULL, preview_json JSONB NOT NULL,
    plan_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL, result_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,selection_id), UNIQUE(owner_phone,actor_id,request_id),
    CHECK(status IN ('pending','applied'))
  );
  ALTER TABLE inventory_selections ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
`;

export const inventoryRowToProduct = (row) => ({
  id: row.id, ownerPhone: row.owner_phone, name: row.name,
  productType: row.product_type, productModel: row.product_model, size: row.size,
  attributes: row.attributes_json, unit: row.inventory_unit, status: row.inventory_status,
  revision: Number(row.inventory_revision), stockAvailable: Number(row.stock_available),
  stockReserved: Number(row.stock_reserved), price: Number(row.price), priceCurrency: row.price_currency,
  ...(row.family_id == null ? {} : {family:{id:row.family_id,version:Number(row.family_version)}}),
});

/** Caller owns BEGIN/COMMIT. Batch state, legacy transactions and outbox can share it. */
export async function executeInventoryPlanInTransaction(client, input, context) {
  const plan = validateOperationPlan(input, context);
  const requestHash = operationDigest(plan);
  const scope = [context.businessId, plan.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(scope)]);
  const replay = await client.query('SELECT request_hash, result_json FROM inventory_operations WHERE owner_phone = $1 AND operation_id = $2', scope);
  if (replay.rowCount) {
    if (replay.rows[0].request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID de operación ya fue utilizado con otro contenido.');
    return replay.rows[0].result_json;
  }

  // Serialize new effects with first-time money confirmation. Keep the same
  // table-first order used by orders/selections; historical replay is above.
  // LLM calls never run while this lock is held.
  await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
  // Optional, explicitly migrated/confirmed per-business policy.
  const policyTable = (await client.query("SELECT to_regclass('public.inventory_money_policies') AS relation")).rows[0].relation;
  const policyRow = policyTable ? (await client.query('SELECT currency,storage_unit,fraction_digits,revision FROM inventory_money_policies WHERE owner_phone=$1', [context.businessId])).rows[0] : null;
  const moneyPolicy = policyRow ? { currency: policyRow.currency, storageUnit: policyRow.storage_unit,
    fractionDigits: Number(policyRow.fraction_digits), revision: Number(policyRow.revision) } : null;
  if (moneyPolicy) enforceInventoryMoneyPolicy(plan.actions, moneyPolicy);

  // Required until the legacy writer stops replacing whole tenant tables.
  const owners = context.ownerPhoneVariants ?? [context.businessId];
  const loaded = await client.query('SELECT * FROM products WHERE owner_phone = ANY($1) ORDER BY id FOR UPDATE', [owners]);
  const products = loaded.rows.map(inventoryRowToProduct);
  const existingIds = new Set(products.map((product) => product.id));
  const usesFamilies=products.some(product=>product.family)||plan.actions.some(action=>action.target.sku?.family||action.changes?.family);
  const familySchemas=usesFamilies ? await loadProductFamilySchemas(client,owners) : [];
  const effect = planInventoryOperation(plan, products, { createId: () => `sku-${crypto.randomUUID()}`,familySchemas });
  if (moneyPolicy) for (const action of plan.actions) {
    if (action.type === 'sku.update' && ['price', 'priceCurrency'].some(key => Object.hasOwn(action.changes, key))) {
      const product = effect.changedProducts.find(value => value.id === action.target.skuId);
      if (product) inventoryPriceToMoney(product.price, product.priceCurrency, moneyPolicy);
    }
  }
  const persisted = new Map();
  for (const product of effect.changedProducts) {
    const values = [product.id, context.businessId, product.name, product.productType ?? null,
      product.productModel ?? null, product.size ?? null, product.stockAvailable, product.stockReserved,
      product.price, JSON.stringify(product.attributes ?? {}), product.unit ?? 'unit',
      product.status ?? 'active', product.priceCurrency ?? 'XXX',product.family?.id ?? null,product.family?.version ?? null];
    const saved = existingIds.has(product.id)
      ? await client.query(`UPDATE products SET owner_phone=$2, stock_available=$3, stock_reserved=$4,
          price=$5, price_currency=$6, inventory_revision=inventory_revision+1,
          name=$9,product_type=$10,product_model=$11,size=$12,attributes_json=$13::jsonb,inventory_status=$14,family_id=$15,family_version=$16
          WHERE id=$1 AND owner_phone=ANY($7) AND inventory_revision=$8 RETURNING *`,
        [product.id, context.businessId, product.stockAvailable, product.stockReserved,
          product.price, product.priceCurrency, owners, product.revision, product.name,
          product.productType ?? null, product.productModel ?? null, product.size ?? null, JSON.stringify(product.attributes ?? {}), product.status ?? 'active',product.family?.id ?? null,product.family?.version ?? null])
      : await client.query(`INSERT INTO products
          (id,owner_phone,name,product_type,product_model,size,stock_available,stock_reserved,price,
           attributes_json,inventory_unit,inventory_status,price_currency,family_id,family_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15) RETURNING *`, values);
    if (saved.rowCount !== 1) throw new InventoryOperationError('CONCURRENT_INVENTORY_CHANGE', 'El producto cambió antes de guardar.');
    const actual = inventoryRowToProduct(saved.rows[0]);
    if (actual.stockAvailable !== product.stockAvailable || actual.stockReserved !== product.stockReserved
      || actual.price !== product.price || actual.priceCurrency !== product.priceCurrency || actual.status !== (product.status ?? 'active') || productIdentity(actual) !== productIdentity(product)
      || JSON.stringify(actual.family ?? null)!==JSON.stringify(product.family ?? null)) {
      throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El resultado persistido difiere del plan.');
    }
    persisted.set(product.id, actual);
  }
  const result = { contractVersion: 1, operationId: plan.operationId, businessId: context.businessId,
    status: 'applied', items: effect.items.map((item) => ({ ...item,
      skuName: persisted.get(item.skuId).name, productType: persisted.get(item.skuId).productType,
      productModel: persisted.get(item.skuId).productModel, size: persisted.get(item.skuId).size,
      stockAvailable: persisted.get(item.skuId).stockAvailable,
      stockReserved: persisted.get(item.skuId).stockReserved,
      ...(['stock.adjust', 'sku.update', 'sku.deactivate', 'sku.create'].includes(item.type) ? { revision: persisted.get(item.skuId).revision,
        product: { ...persisted.get(item.skuId), identityFingerprint: inventoryProductFingerprint(persisted.get(item.skuId)) },
        ...(item.changes ? { changes: Object.fromEntries(Object.keys(item.changes).map((key) => [key, persisted.get(item.skuId)[key] ?? null])) } : {}),
        ...(item.balances ? { balances: Object.fromEntries(Object.keys(item.balances).map((key) => [key, persisted.get(item.skuId)[key === 'available' ? 'stockAvailable' : 'stockReserved']])) } : {}),
      } : {}),
      ...(item.type === 'stock.withdraw' ? {} : ['stock.receive', 'stock.adjust', 'sku.update', 'sku.deactivate', 'sku.create'].includes(item.type)
        ? { price: persisted.get(item.skuId).price, currency: persisted.get(item.skuId).priceCurrency }
        : { catalogPrice: persisted.get(item.skuId).price, catalogCurrency: persisted.get(item.skuId).priceCurrency }),
    })) };
  await client.query(`INSERT INTO inventory_operations
    (owner_phone,operation_id,contract_version,actor_id,request_hash,plan_json,result_json)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [context.businessId, plan.operationId, plan.contractVersion, context.actorId, requestHash, JSON.stringify(plan), JSON.stringify(result)]);
  for (const movement of effect.movements) {
    await client.query(`INSERT INTO inventory_movements
      (owner_phone,operation_id,item_id,sku_id,delta_available,delta_reserved,unit)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [context.businessId, plan.operationId, movement.itemId, movement.skuId, movement.deltaAvailable, movement.deltaReserved, movement.unit]);
  }
  return result;
}
