import assert from 'node:assert/strict';

export async function runProductFamilyChecks({ db, sql, check }) {
  const owner = '59899000973', foreign = '59899000974'; let sequence = 0;
  const id = () => `family-check-${++sequence}`;
  const permissions = ['inventory:schema', 'inventory:create', 'inventory:receive', 'inventory:sell', 'inventory:update', 'inventory:adjust'];
  const context = (businessId = owner, allowed = permissions) => ({ businessId, actorId: 'family-check-actor', permissions: allowed });
  const schema = (extra = {}) => ({ name: 'Componentes eléctricos', unit: 'unit', attributes: {
    voltage: { type: 'number', required: true, unit: 'v', values: [12, 24] }, direction: { type: 'text', required: true, values: ['entrada', 'salida'] },
  }, allowAdditionalAttributes: false, ...extra });
  const attributes = (voltage = 12, direction = 'entrada') => ({ voltage: { type: 'number', state: 'known', unit: 'v', value: voltage }, direction: { type: 'text', state: 'known', value: direction } });
  const publication = (familyId = id(), expectedVersion = 0, value = schema()) => ({ operationId: id(), familyId, expectedVersion, schema: value });
  const publish = (input, ctx = context()) => db.publishProductFamily(input, ctx);
  const family = (entry) => ({ id: entry.family.familyId, version: entry.family.version });
  const create = (reference, extra = {}, itemId = 'create') => ({ itemId, type: 'sku.create', target: { kind: 'new', sku: { name: `Componente ${id()}`, unit: 'unit', family: reference, attributes: attributes(), ...extra } }, initialStock: { available: 3, reserved: 0 }, reason: 'Alta explícita con familia' });
  const plan = (actions, operationId = id(), businessId = owner) => ({ contractVersion: 1, businessId, operationId, actions });
  const execute = (input, ctx = context()) => db.executeInventoryOperation(input, ctx);
  const product = async (skuId) => (await db.getStateSnapshotStrict(owner)).products.find(({ id }) => id === skuId);
  const target = (sku) => ({ kind: 'existing', skuId: sku.id, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint });
  const update = (sku, changes) => ({ itemId: 'edit', type: 'sku.update', target: target(sku), changes, reason: 'Cambio explícito validado contra familia' });
  const state = async () => {
    const result = {};
    for (const table of ['products', 'product_family_schemas', 'product_family_operations', 'inventory_operations', 'inventory_movements', 'transactions', 'inventory_selections']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
    return result;
  };

  await check('product family: concurrent publication persists one immutable normalized version and receipt; content/version conflicts reject', async () => {
    const input = publication(), [one, two] = await Promise.all([publish(input), publish(input)]); assert.deepEqual(one, two);
    assert.deepEqual([one.operationId, one.businessId, one.status, one.family.familyId, one.family.version], [input.operationId, owner, 'applied', input.familyId, 1]);
    assert.deepEqual(one.family.schema.attributes.voltage.allowedStates, ['known']);
    const list = await db.listProductFamilies(context()); assert.deepEqual(list.find(({ familyId, version }) => familyId === input.familyId && version === 1), one.family);
    assert.equal((await sql.query('SELECT 1 FROM product_family_schemas WHERE owner_phone=$1 AND family_id=$2', [owner, input.familyId])).rowCount, 1);
    assert.deepEqual((await sql.query('SELECT result_json FROM product_family_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, input.operationId])).rows[0].result_json, one);
    const before = await state(); await assert.rejects(publish({ ...input, schema: schema({ name: 'Otro contrato' }) }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(publish({ ...input, operationId: id() }), { code: 'PRODUCT_SCHEMA_VERSION_MISMATCH' }); assert.deepEqual(await state(), before);
    const optional = await publish(publication(id(), 0, schema({ attributes: { note: { type: 'text' } } }))); assert.equal(optional.family.schema.attributes.note.required, false); assert.deepEqual(optional.family.schema.attributes.note.allowedStates, ['known']);
  });

  await check('product family: tenant and publication permissions isolate schema lists and unsupported schemas leave no receipts', async () => {
    const input = publication(), before = await state();
    await assert.rejects(publish(input, context(owner, ['inventory:create'])), { code: 'FORBIDDEN' });
    for (const invalidSchema of [schema({ unit: '' }), schema({ attributes: { voltage: { type: 'number', required: true, allowedStates: ['unknown'] } } }), schema({ attributes: { voltage: { type: 'number', values: ['twelve'] } } })]) await assert.rejects(publish({ ...input, operationId: id(), schema: invalidSchema }), { code: 'INVALID_PRODUCT_SCHEMA' });
    assert.deepEqual(await state(), before);
    const outsider = await publish(input, context(foreign)); assert.equal(outsider.businessId, foreign); assert.equal((await db.listProductFamilies(context())).some(({ familyId }) => familyId === input.familyId), false);
    const local = await publish(input); assert.equal(local.businessId, owner); assert.equal((await db.listProductFamilies(context(foreign))).filter(({ familyId }) => familyId === input.familyId).length, 1);
  });

  await check('product family: required attributes, units, types, enum, states and additional keys validate before ledger/history effects', async () => {
    const published = await publish(publication()), reference = family(published), before = await state();
    const variants = [
      { attributes: { direction: attributes().direction } }, { unit: 'box' },
      { attributes: { ...attributes(), voltage: { state: 'known', type: 'text', value: '12', unit: 'v' } } },
      { attributes: attributes(36) }, { attributes: { ...attributes(), voltage: { state: 'unknown', type: 'number', unit: 'v' } } },
      { attributes: { ...attributes(), voltage: { ...attributes().voltage, unit: 'kv' } } },
      { attributes: { ...attributes(), extra: { state: 'known', type: 'boolean', value: true } } },
    ];
    for (const extra of variants) await assert.rejects(execute(plan([create(reference, extra)])), { code: 'PRODUCT_SCHEMA_MISMATCH' });
    const validFirst = create(reference), invalidLast = create(reference, { attributes: attributes(36) }, 'invalid-last');
    await assert.rejects(execute(plan([validFirst, invalidLast])), { code: 'PRODUCT_SCHEMA_MISMATCH' }); assert.deepEqual(await state(), before);
  });

  await check('product family: create, receive, sell and update share exact persisted family metadata and optimistic revision checks', async () => {
    const reference = family(await publish(publication())), created = await execute(plan([create(reference)])), skuId = created.items[0].skuId;
    let sku = await product(skuId); assert.deepEqual(sku.family, reference); assert.equal(sku.revision, 0); assert.deepEqual(sku.attributes, attributes());
    const raw = (await sql.query('SELECT family_id,family_version FROM products WHERE owner_phone=$1 AND id=$2', [owner, skuId])).rows[0]; assert.deepEqual({...raw,family_version:Number(raw.family_version)}, { family_id: reference.id, family_version: 1 });
    const receive = { itemId: 'receive', type: 'stock.receive', target: target(sku), quantity: { value: 4, unit: 'unit' } };
    await execute(plan([receive])); sku = await product(skuId); assert.equal(sku.stockAvailable, 7); assert.equal(sku.revision, 1);
    await execute(plan([{ itemId: 'sell', type: 'stock.sell', target: target(sku), quantity: { value: 2, unit: 'unit' } }])); sku = await product(skuId); assert.equal(sku.stockAvailable, 5); assert.equal(sku.revision, 2);
    await execute(plan([update(sku, { attributes: attributes(24, 'salida') })])); sku = await product(skuId); assert.deepEqual(sku.family, reference); assert.equal(sku.revision, 3); assert.equal(sku.attributes.voltage.value, 24);
    const before = await state(); await assert.rejects(execute(plan([update(sku, { attributes: attributes(36) })])), { code: 'PRODUCT_SCHEMA_MISMATCH' }); assert.deepEqual(await state(), before);
    const receiveNew = { itemId: 'receive-new', type: 'stock.receive', target: create(reference).target, quantity: { value: 2, unit: 'unit' } };
    const received = await execute(plan([receiveNew])); assert.deepEqual((await product(received.items[0].skuId)).family, reference);
  });

  await check('product family: new schema versions do not migrate prior SKUs and identity spans versions but distinguishes family IDs', async () => {
    const input = publication(), first = await publish(input), reference = family(first), name = `Identidad familia ${id()}`;
    const created = await execute(plan([create(reference, { name })])), skuId = created.items[0].skuId, original = await product(skuId);
    const second = await publish(publication(input.familyId, 1, schema({ attributes: { ...schema().attributes, certified: { type: 'boolean', required: true } } })));
    assert.deepEqual(await product(skuId), original); const before = await state();
    await assert.rejects(execute(plan([update(original, { family: family(second) })])), { code: 'PRODUCT_SCHEMA_MISMATCH' }); assert.deepEqual(await state(), before);
    const upgradedAttributes = { ...attributes(), certified: { type: 'boolean', state: 'known', value: true } };
    await execute(plan([update(original, { family: family(second), attributes: upgradedAttributes })])); const upgraded = await product(skuId); assert.deepEqual(upgraded.family, family(second)); assert.notEqual(upgraded.identityFingerprint, original.identityFingerprint);
    const equivalentSecond = await publish(publication(id(), 0)), equivalentV2 = await publish(publication(equivalentSecond.family.familyId, 1));
    const identityName = `Versiones equivalentes ${id()}`; await execute(plan([create(family(equivalentSecond), { name: identityName })]));
    await assert.rejects(execute(plan([create(family(equivalentV2), { name: identityName })])), { code: 'DUPLICATE_SKU_IDENTITY' });
    const another = await publish(publication()); const distinct = await execute(plan([create(family(another), { name: identityName })])); assert.ok(distinct.items[0].skuId);
    assert.equal((await db.listProductFamilies(context())).filter(({ familyId }) => familyId === input.familyId).length, 2);
  });

  await check('product family: missing/cross-business schemas reject without effects and receipt replay does not read later schema state', async () => {
    const outside = await publish(publication(), context(foreign)), before = await state();
    for (const reference of [{ id: id(), version: 1 }, family(outside)]) await assert.rejects(execute(plan([create(reference)])), { code: 'PRODUCT_SCHEMA_NOT_FOUND' });
    assert.deepEqual(await state(), before);
    const input = publication(), published = await publish(input), operation = plan([create(family(published))]), result = await execute(operation);
    await publish(publication(input.familyId, 1));
    await sql.query('DELETE FROM product_family_schemas WHERE owner_phone=$1 AND family_id=$2 AND version=$3', [owner, input.familyId, 1]);
    const later = await state(); assert.deepEqual(await execute(operation), result); assert.deepEqual(await publish(input), published); assert.deepEqual(await state(), later);
  });

  await check('product family: metadata corruption and publication receipt SQL failures roll back effects and allow exact retry', async () => {
    const input = publication(), before = await state();
    await sql.query(`CREATE FUNCTION family_publication_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.operation_id='${input.operationId}' THEN RAISE EXCEPTION 'family publication receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER family_publication_receipt_failure BEFORE INSERT ON product_family_operations FOR EACH ROW EXECUTE FUNCTION family_publication_receipt_failure()`);
    try { await assert.rejects(publish(input), /family publication receipt failure/); } finally { await sql.query('DROP TRIGGER family_publication_receipt_failure ON product_family_operations; DROP FUNCTION family_publication_receipt_failure()'); }
    assert.deepEqual(await state(), before); const published = await publish(input), operation = plan([create(family(published))]), pending = await state();
    await sql.query(`CREATE FUNCTION family_product_metadata_corruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.family_id='${input.familyId}' THEN NEW.family_version=99; END IF; RETURN NEW; END $$; CREATE TRIGGER family_product_metadata_corruption BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION family_product_metadata_corruption()`);
    try { await assert.rejects(execute(operation), { code: 'PERSISTED_EFFECT_MISMATCH' }); } finally { await sql.query('DROP TRIGGER family_product_metadata_corruption ON products; DROP FUNCTION family_product_metadata_corruption()'); }
    assert.deepEqual(await state(), pending); assert.equal((await execute(operation)).status, 'applied');
  });

  await check('product family: frozen selection previews preserve family validation and reject an invalid whole-set mutation', async () => {
    const reference = family(await publish(publication())), products = [];
    for (let index = 0; index < 2; index++) products.push(await product((await execute(plan([create(reference)]))).items[0].skuId));
    const input = { requestId: id(), selector: { kind: 'ids', skuIds: products.map(({ id }) => id) }, mutation: { type: 'sku.update', changes: { attributes: attributes(24) }, reason: 'Cambio de familia revisado' } };
    const before = await state(), preview = await db.previewInventorySelection(input, context());
    assert.deepEqual((await state()).products, before.products); assert.equal(preview.members.length, 2);
    const result = await db.confirmInventorySelection(preview.selectionId, preview.digest, context()); assert.equal(result.items.length, 2);
    for (const sku of products) { const current = await product(sku.id); assert.deepEqual(current.family, reference); assert.equal(current.attributes.voltage.value, 24); }
    const after = await state(); await assert.rejects(db.previewInventorySelection({ ...input, requestId: id(), mutation: { ...input.mutation, changes: { attributes: attributes(36) } } }, context()), { code: 'PRODUCT_SCHEMA_MISMATCH' }); assert.deepEqual(await state(), after);
    assert.deepEqual(await db.confirmInventorySelection(preview.selectionId, preview.digest, context()), result);
  });
}
