import assert from 'node:assert/strict';

export async function runInventoryMetaSelectionChecks({ db, sql, check }) {
  const owner = '59899000983', sender = owner;
  let sequence = 0;
  const next = () => `meta-selection-check-${++sequence}`;
  const seed = (extra = {}) => db.createProductRecord({ name: `Meta selection ${next()}`, stockAvailable: 10,
    stockReserved: 3, price: 99, unit: 'unit', ...extra }, owner, { operationId: next() });
  const prepare = (messageId, products, change = { price: 0, priceCurrency: 'UYU' }, sourceText = 'Cambio de precio revisado por WhatsApp') => db.prepareMetaInventorySelection({
    actions: products.map((product) => ({ type: 'update_product', productId: product.id, ...change })), sourceText, messageId, ownerPhone: owner, senderPhone: sender });
  const stored = async (messageId, prefix = 'meta-selection') => (await sql.query('SELECT * FROM inventory_selections WHERE owner_phone=$1 AND request_id=$2', [owner, `${prefix}:${messageId}`])).rows[0];
  const command = (preview, messageId, { verb = 'CONFIRMAR', label = preview.mutation.type === 'stock.adjust' ? 'AJUSTE' : preview.mutation.type === 'sku.deactivate' ? 'BAJA' : 'CAMBIO', actor = sender, business = owner, code = preview.digest.slice(0, 8) } = {}) =>
    db.processMetaInventorySelectionCommand({ sourceText: `${verb} ${label} ${code}`, messageId, ownerPhone: business, senderPhone: actor });
  const state = async () => {
    const result = {};
    for (const table of ['products', 'inventory_operations', 'inventory_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
    return result;
  };
  const receipt = async (messageId) => (await sql.query('SELECT * FROM meta_selection_commands WHERE owner_phone=$1 AND message_id=$2', [owner, messageId])).rows[0];
  const outbox = async (messageId) => (await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id=$1', [messageId])).rows[0];
  const changeCatalog = async (product) => {
    const current = (await db.getStateSnapshotStrict(owner)).products.find(({ id }) => id === product.id);
    return db.updateProductRecord(product.id, { price: 123 }, owner, { operationId: next(), expectedRevision: current.revision, reason: 'Cambio posterior de catálogo' });
  };

  await check('Meta selection: exact zero-price preview is frozen, complete, effect free and atomic with outbox', async () => {
    const products = [await seed(), await seed()], messageId = next(), before = await state();
    const first = await prepare(messageId, products), row = await stored(messageId), preview = row.preview_json;
    assert.equal(first.pendingSelection, true); assert.deepEqual(first.actions, []); assert.deepEqual(await state(), before);
    assert.equal(preview.mutation.type, 'sku.update'); assert.equal(preview.mutation.changes.price, 0);
    assert.deepEqual(preview.members.map(({ skuId }) => skuId).sort(), products.map(({ id }) => id).sort());
    for (const product of products) assert.ok(first.replyText.includes(product.name));
    assert.match(first.replyText, /Precio: 0/); assert.match(first.replyText, /Motivo:/); assert.match(first.replyText, /CONFIRMAR CAMBIO [A-F0-9]{8}/);
    assert.equal((await outbox(messageId)).reply_text, first.replyText);
    await changeCatalog(products[0]);
    assert.deepEqual(await prepare(messageId, products), first);
    const resumed = await db.resumeMetaInventorySelection({sourceText:'Cambio de precio revisado por WhatsApp',messageId,ownerPhone:owner,senderPhone:sender});
    assert.equal(resumed.replyText,first.replyText);assert.equal(resumed.selectionId,first.selectionId);assert.equal(resumed.handled,true);
    await assert.rejects(prepare(messageId, products, { price: 0, priceCurrency: 'UYU' }, 'Otro texto'), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await check('Meta selection: homogeneous stock SET previews preserve units and confirm every exact member once', async () => {
    for (const count of [1, 2]) {
    const products = [await seed({ unit: 'box' })]; if (count === 2) products.push(await seed());
    const messageId = next();
    const pending = await prepare(messageId, products, { stockAvailable: 0, stockReserved: 2 }, 'Conteo físico revisado'), preview = (await stored(messageId)).preview_json;
    assert.equal(preview.mutation.type, 'stock.adjust');
    for (const product of products) {
      const member = preview.members.find(({ skuId }) => skuId === product.id);
      assert.deepEqual([member.stockAvailable, member.stockReserved, member.finalAvailable, member.finalReserved, member.unit], [10, 3, 0, 2, product.unit]);
      assert.ok(pending.replyText.includes(`disponible 10 ${product.unit} → 0 ${product.unit}; reservado 3 ${product.unit} → 2 ${product.unit}`));
    }
    const confirmId = next(), results = await Promise.all([command(preview, confirmId), command(preview, next())]);
    assert.deepEqual(results[0], results[1]); assert.equal(results[0].actions.length, count);
    assert.ok(results[0].actions.every((action) => action.stockAvailable === 0 && action.stockReserved === 2));
    assert.deepEqual((await receipt(confirmId)).result_json, results[0]);
    assert.equal((await outbox(confirmId)).reply_text, results[0].replyText);
    const operationId = results[0].operationResult.operationId, after = await state();
    assert.equal(after.inventory_operations.filter((row) => row.operation_id === operationId).length, 1);
    assert.equal(after.inventory_movements.filter((row) => row.operation_id === operationId).length, count);
    assert.equal(after.transactions.filter((row) => row.batch_id === `${owner}:${operationId}`).length, count);
    await changeCatalog(products[0]); const later = await state();
    assert.deepEqual(await command(preview, confirmId), results[0]); assert.deepEqual(await command(preview, next()), results[0]); assert.deepEqual(await state(), later);
    assert.equal((await command(preview, confirmId, { verb: 'CANCELAR' })).errorCode, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await command(preview, confirmId, { actor: '59899000984' })).errorCode, 'IDEMPOTENCY_CONFLICT');
    }
  });

  await check('Meta selection: stale single and multi-SKU rejection rolls back all effects and freezes terminal replay', async () => {
    for (const count of [1, 2]) {
      const products = []; for (let index = 0; index < count; index++) products.push(await seed());
      const messageId = next(); await prepare(messageId, products); const preview = (await stored(messageId)).preview_json;
      await changeCatalog(products.at(-1)); const before = await state(), commandId = next();
      const result = await command(preview, commandId); assert.equal(result.errorCode, 'REVISION_MISMATCH'); assert.deepEqual(result.actions, []);
      assert.deepEqual(await state(), before); assert.equal((await stored(messageId)).status, 'pending');
      assert.deepEqual((await receipt(commandId)).result_json, result); assert.equal((await outbox(commandId)).reply_text, result.replyText);
      await changeCatalog(products[0]); const later = await state();
      assert.deepEqual(await command(preview, commandId), result); assert.deepEqual(await state(), later);
    }
  });

  await check('Meta selection: cancel terminal replay and confirm/cancel race serialize', async () => {
    const product = await seed(), messageId = next(); await prepare(messageId, [product]); const preview = (await stored(messageId)).preview_json;
    const cancelId = next(), cancelled = await command(preview, cancelId, { verb: 'CANCELAR' });
    assert.match(cancelled.replyText, /cancelad/i); assert.deepEqual(await command(preview, cancelId, { verb: 'CANCELAR' }), cancelled);
    assert.equal((await command(preview, next())).errorCode, 'SELECTION_CANCELLED');
    const raceId = next(); await prepare(raceId, [await seed()]); const race = (await stored(raceId)).preview_json;
    const results = await Promise.all([command(race, next()), command(race, next(), { verb: 'CANCELAR' })]);
    if ((await stored(raceId)).status === 'applied') assert.equal(results[1].errorCode, 'SELECTION_ALREADY_APPLIED');
    else assert.equal(results[0].errorCode, 'SELECTION_CANCELLED');
  });

  await check('Meta selection: wrong command type/code/actor/business and expiry never mutate inventory', async () => {
    const messageId = next(); await prepare(messageId, [await seed()]); const preview = (await stored(messageId)).preview_json, before = await state();
    for (const options of [{ label: 'AJUSTE' }, { code: preview.digest.startsWith('00000000') ? '11111111' : '00000000' }, { actor: '59899000984' }, { business: '59899000985' }]) assert.equal((await command(preview, next(), options)).errorCode, 'SELECTION_NOT_FOUND');
    assert.equal(await command(preview, next(), { verb: 'SI' }), null);
    await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [owner, preview.selectionId]);
    const expired = await command(preview, next()); assert.equal(expired.errorCode, 'SELECTION_EXPIRED'); assert.deepEqual(await state(), before);
  });

  await check('Meta selection: preview and confirm outbox failure roll back selection, receipt, stock and history and permit retry', async () => {
    const products = [await seed(), await seed()], previewId = next(), confirmId = next();
    await sql.query(`CREATE FUNCTION meta_selection_check_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id IN ('${previewId}','${confirmId}') THEN RAISE EXCEPTION 'simulated meta selection outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER meta_selection_check_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION meta_selection_check_outbox_failure()`);
    const before = await state();
    try {
      await assert.rejects(prepare(previewId, products), /simulated meta selection outbox failure/);
      assert.equal(await stored(previewId), undefined); assert.equal(await outbox(previewId), undefined); assert.deepEqual(await state(), before);
      const safePreviewId = next(); await prepare(safePreviewId, products, { stockAvailable: 0 }); const preview = (await stored(safePreviewId)).preview_json;
      await assert.rejects(command(preview, confirmId), /simulated meta selection outbox failure/);
      assert.equal(await receipt(confirmId), undefined); assert.equal(await outbox(confirmId), undefined); assert.equal((await stored(safePreviewId)).status, 'pending'); assert.deepEqual(await state(), before);
      await sql.query('DROP TRIGGER meta_selection_check_outbox_failure ON meta_reply_outbox');
      assert.equal((await command(preview, confirmId)).operationResult.status, 'applied');
      assert.equal((await prepare(previewId, products)).pendingSelection, true);
    } finally { await sql.query('DROP TRIGGER IF EXISTS meta_selection_check_outbox_failure ON meta_reply_outbox; DROP FUNCTION meta_selection_check_outbox_failure()'); }
  });

  await check('Meta selection: mixed effects, unequal changes and unbound IDs fail closed', async () => {
    const first = await seed(), second = await seed(), before = await state();
    const base = { sourceText: 'Cambio inválido', ownerPhone: owner, senderPhone: sender };
    for (const actions of [
      [{ type: 'update_product', productId: first.id, price: 0, stockAvailable: 0 }],
      [{ type: 'update_product', productId: first.id, price: 0 }, { type: 'update_product', productId: second.id, price: 1 }],
      [{ type: 'update_product', productId: first.id, price: 0 }, { type: 'delete_product', productId: second.id }],
    ]) { const messageId = next(); await assert.rejects(db.prepareMetaInventorySelection({ ...base, messageId, actions }), { code: 'UNSUPPORTED_MIXED_OPERATION' }); assert.equal(await stored(messageId), undefined); assert.equal(await outbox(messageId), undefined); }
    await assert.rejects(db.prepareMetaInventorySelection({ ...base, messageId: next(), actions: [{ type: 'update_product', productName: first.name, price: 0 }] }), { code: 'SKU_SELECTION_REQUIRED' });
    for (const extra of [{ messageId: '' }, { sourceText: '' }]) await assert.rejects(db.prepareMetaInventorySelection({ ...base, messageId: next(), actions: [{ type: 'update_product', productId: first.id, price: 0 }], ...extra }));
    assert.deepEqual(await state(), before);
  });

  await check('Meta selection: oversized human review leaves no persisted preview or outbox', async () => {
    const product = await seed(), messageId = next(), before = await state();
    await assert.rejects(prepare(messageId, [product], { price: 0 }, 'Motivo largo '.repeat(350)), { code: 'SELECTION_PREVIEW_TOO_LARGE' });
    assert.equal(await stored(messageId), undefined); assert.equal(await outbox(messageId), undefined); assert.deepEqual(await state(), before);
  });

  await check('Meta selection: legacy deactivation aliases retain request prefix and immutable command receipts', async () => {
    const product = await seed({stockReserved:0}), messageId = next();
    const pending = await db.prepareMetaDeactivation({ actions: [{ type: 'delete_product', productId: product.id }], sourceText: 'Baja revisada', messageId, ownerPhone: owner, senderPhone: sender });
    const preview = (await stored(messageId, 'meta-deactivate')).preview_json; assert.match(pending.replyText, /CONFIRMAR BAJA/);
    const commandId = next(), args = { sourceText: `CONFIRMAR BAJA ${preview.digest.slice(0, 8)}`, messageId: commandId, ownerPhone: owner, senderPhone: sender };
    const result = await db.processMetaDeactivationCommand(args); assert.equal(result.actions[0].status, 'inactive');
    assert.deepEqual((await receipt(commandId)).result_json, result); assert.deepEqual(await db.processMetaDeactivationCommand(args), result);
    assert.deepEqual(await command(preview, next()), result);
  });

  await check('Meta selection: persisted-effect rejection rolls back writes before storing a terminal command receipt', async () => {
    const product = await seed(), messageId=next();
    await prepare(messageId,[product],{stockAvailable:0},'Conteo con prueba de persistencia');
    const preview=(await stored(messageId)).preview_json,commandId=next(),before=await state();
    await sql.query(`CREATE FUNCTION corrupt_meta_selection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${product.id}' THEN NEW.price:=NEW.price+1; END IF; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_meta_selection BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION corrupt_meta_selection()`);
    let rejected;
    try {rejected=await command(preview,commandId);}
    finally {await sql.query('DROP TRIGGER corrupt_meta_selection ON products; DROP FUNCTION corrupt_meta_selection()');}
    assert.equal(rejected.errorCode,'PERSISTED_EFFECT_MISMATCH');assert.deepEqual(await state(),before);
    assert.deepEqual((await receipt(commandId)).result_json,rejected);assert.equal((await outbox(commandId)).reply_text,rejected.replyText);
    assert.deepEqual(await command(preview,commandId),rejected);assert.deepEqual(await state(),before);
    const recovered=await command(preview,next());assert.equal(recovered.operationResult.items[0].stockAvailable,0);
  });
}
