import assert from 'node:assert/strict';

export async function runInventoryDeactivationMetaChecks({ db, sql, check }) {
  const owner = '59899000969', sender = owner;
  const context = { businessId: owner, actorId: sender, permissions: ['inventory:receive', 'inventory:deactivate'] };
  const seed = async (id) => (await db.executeInventoryOperation({ contractVersion: 1, businessId: owner, operationId: `meta-${id}`,
    actions: [{ itemId: 'one', type: 'stock.receive', target: { kind: 'new', sku: { name: `Archivo Meta ${id}` } }, quantity: { value: 4, unit: 'unit' } }],
  }, context)).items[0].skuId;
  const prepare = async (id, skuId) => db.prepareMetaDeactivation({ actions: [{ type: 'delete_product', productId: skuId }],
    sourceText: 'Baja revisada por WhatsApp', messageId: id, ownerPhone: owner, senderPhone: sender });
  const previewFor = async (id) => (await sql.query('SELECT preview_json FROM inventory_selections WHERE owner_phone=$1 AND request_id=$2', [owner, `meta-deactivate:${id}`])).rows[0].preview_json;
  const command = async (preview, id, verb = 'CONFIRMAR', actor = sender) => db.processMetaDeactivationCommand({
    sourceText: `${verb} BAJA ${preview.digest.slice(0, 8)}`, messageId: id, ownerPhone: owner, senderPhone: actor });
  const row = async (id) => (await sql.query('SELECT * FROM products WHERE owner_phone=$1 AND id=$2', [owner,id])).rows[0];

  await check('Meta deactivation: preview, actor isolation, exact replay and archive recreation guard', async () => {
    const id = await seed('once');
    const first = await prepare('meta-archive-once', id), preview = await previewFor('meta-archive-once');
    assert.equal(first.pendingSelection, true); assert.deepEqual(first.actions, []);
    assert.deepEqual(await prepare('meta-archive-once', id), first);
    assert.equal((await row(id)).inventory_status, 'active');
    assert.equal((await command(preview, 'meta-archive-foreign', 'CONFIRMAR', '59899000979')).errorCode, 'SELECTION_NOT_FOUND');
    const result = await command(preview, 'meta-archive-confirm');
    assert.equal(result.actions[0].productId, id); assert.equal(result.actions[0].status, 'inactive');
    assert.equal((await row(id)).inventory_status, 'inactive'); assert.equal(Number((await row(id)).stock_available), 4);
    assert.deepEqual(await command(preview, 'meta-archive-confirm'), result);
    assert.equal((await sql.query('SELECT item_id FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner,result.operationResult.operationId])).rowCount, 1);
    const outbox = (await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', ['meta-archive-confirm'])).rows[0];
    assert.equal(outbox.reply_text, result.replyText);
    await assert.rejects(db.createProductRecord({ name: 'Archivo Meta once' }, owner, { operationId: 'meta-archive-recreate-guard' }), { code: 'SKU_INACTIVE' });
  });

  await check('Meta deactivation: cancel prevents later confirm and races serialize', async () => {
    const id = await seed('cancel'); await prepare('meta-archive-cancel', id);
    const preview = await previewFor('meta-archive-cancel');
    assert.match((await command(preview, 'meta-archive-cancel-command', 'CANCELAR')).replyText, /cancelada/);
    assert.equal((await command(preview, 'meta-archive-after-cancel')).errorCode, 'SELECTION_CANCELLED');
    assert.equal((await row(id)).inventory_status, 'active');
    const raceId = await seed('cancel-race'); await prepare('meta-archive-race', raceId);
    const racePreview = await previewFor('meta-archive-race');
    const results = await Promise.all([command(racePreview, 'meta-race-confirm'), command(racePreview, 'meta-race-cancel', 'CANCELAR')]);
    const state = (await row(raceId)).inventory_status;
    if (state === 'inactive') assert.equal(results[1].errorCode, 'SELECTION_ALREADY_APPLIED');
    else { assert.equal(state, 'active'); assert.equal(results[0].errorCode, 'SELECTION_CANCELLED'); }
  });

  await check('Meta deactivation: outbox failure rolls back archive, receipt and selection', async () => {
    const id = await seed('outbox'); await prepare('meta-archive-outbox', id);
    const preview = await previewFor('meta-archive-outbox');
    await sql.query(`CREATE FUNCTION deactivation_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='meta-archive-outbox-confirm' THEN RAISE EXCEPTION 'simulated archive outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER deactivation_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION deactivation_outbox_failure()`);
    try {
      await assert.rejects(command(preview, 'meta-archive-outbox-confirm'), /simulated archive outbox failure/);
      assert.equal((await row(id)).inventory_status, 'active');
      assert.equal((await sql.query('SELECT status FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [owner,preview.selectionId])).rows[0].status, 'pending');
      assert.equal((await sql.query('SELECT operation_id FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner,`selection:${preview.selectionId}`])).rowCount, 0);
    } finally { await sql.query('DROP TRIGGER deactivation_outbox_failure ON meta_reply_outbox; DROP FUNCTION deactivation_outbox_failure()'); }
    assert.equal((await command(preview, 'meta-archive-outbox-confirm')).operationResult.status, 'applied');
  });
}
