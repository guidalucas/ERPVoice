import assert from 'node:assert/strict';

export async function runUniversalQueryChecks({ db, sql, check }) {
  const owner = '59899000976', other = '59899000977';
  let sequence = 0;
  const id = () => `universal-query-check-${++sequence}`;
  const context = (businessId = owner, actorId = owner, permissions = ['inventory:read', 'orders:read', 'accounts:read', 'inventory:receive', 'accounts:charge']) => ({
    businessId, actorId, channel: 'panel', permissions,
  });
  const text = '¿Qué hay en inventario, qué pedidos históricos tenemos y cuánto deben las cuentas?';
  const queryResponse = (queries, quote = text) => ({ ok: true, json: {
    contractVersion: 1, kind: 'query', queries,
    evidence: queries.map(({ itemId }) => ({ itemId, quote })),
  } });
  const inventory = (itemId, selector = { kind: 'all' }) => ({ itemId, type: 'inventory.query', selector });
  const orders = (itemId, selector = { kind: 'all' }, estado = 'todos') => ({ itemId, type: 'orders.query', selector, estado });
  const accounts = (itemId, selector = { kind: 'all' }) => ({ itemId, type: 'accounts.query', selector });
  const provider = (response) => {
    const fake = { calls: 0, complete: async () => { fake.calls++; return response; } };
    return fake;
  };
  const forbidden = async () => assert.fail('an answered replay must not call the provider');
  const prepare = (request, fake, ctx = context()) => db.prepareUniversalDraft(request, ctx, { complete: fake.complete });
  const state = async (commands = true) => {
    const result = {};
    const tables = ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'inventory_operations',
      'account_operations', 'party_operations', 'order_operations', 'inventory_movements', 'account_movements',
      'transactions'];
    if (commands) tables.push('universal_drafts', 'universal_draft_commands', 'universal_meta_commands');
    for (const table of tables) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
    if (commands) result.outbox = (await sql.query("SELECT * FROM meta_reply_outbox WHERE event_id LIKE 'universal-query-check-%' ORDER BY event_id")).rows;
    return result;
  };
  const seed = async () => {
    const product = await db.createProductRecord({ name: `Query SKU ${id()}`, stockAvailable: 8, unit: 'unit', price: 120 }, owner, { operationId: id() });
    const client = await db.createClientRecord({ name: `Query cliente ${id()}`, operationId: id() }, owner);
    await db.executeAccountOperation({ contractVersion: 1, businessId: owner, operationId: id(), actions: [
      { itemId: 'charge', type: 'account.charge', target: { kind: 'existing', clientId: client.id }, amount: { value: 31, unit: 'legacy-money' }, reason: 'saldo de prueba' },
    ] }, context());
    const pedido = await db.createPedidoRecord({ operationId: id(), clienteId: client.id, producto: `Query pedido ${id()}`, qty: 4, estado: 'pendiente', notas: 'histórico' }, owner);
    return { product, client, pedido };
  };

  await check('universal query: mixed inventory/orders/accounts answer uses one read-only snapshot', async () => {
    const fixture = await seed(), before = await state(true), beforeLedgers = await state(false), fake = provider(queryResponse([
      inventory('stock'), orders('orders', { kind: 'all' }, 'todos'), accounts('accounts'),
    ]));
    const preview = await prepare({ requestId: id(), text }, fake);
    assert.equal(fake.calls, 1); assert.equal(preview.status, 'answered'); assert.equal(preview.version, 1);
    assert.equal(preview.plan, undefined); assert.deepEqual(preview.queries.map(({ type }) => type), ['inventory.query', 'orders.query', 'accounts.query']);
    assert.equal(preview.answer.items[0].rows.find(({ id: rowId }) => rowId === fixture.product.id).stockAvailable, 8);
    assert.equal(preview.answer.items[1].rows.find(({ id: rowId }) => rowId === fixture.pedido.id).estado, 'pendiente');
    assert.equal(preview.answer.items[2].summary.totalDebt, 31);
    assert.ok(preview.answer.observedAt); assert.deepEqual(await state(false), beforeLedgers);
    const after = await state(true);
    assert.equal(after.universal_drafts.length, before.universal_drafts.length + 1);
    assert.equal(after.universal_draft_commands.length, before.universal_draft_commands.length + 1);
    assert.deepEqual(after.universal_drafts.find(({ draft_id }) => draft_id === preview.draftId)?.preview_json, preview);
    assert.deepEqual(await db.getUniversalDraft(preview.draftId, context()), preview);
  });

  await check('universal query: replay and get return frozen answer after catalog drift and deletion; terminal commands cannot mutate it', async () => {
    const product = await db.createProductRecord({ name: `Replay original ${id()}`, stockAvailable: 6, unit: 'unit', price: 50 }, owner, { operationId: id() });
    const deleted = await db.createProductRecord({ name: `Replay delete ${id()}`, stockAvailable: 3, unit: 'unit', price: 50 }, owner, { operationId: id() });
    const request = { requestId: id(), text: '¿Cuánto stock tiene el producto consultado?' };
    const response = queryResponse([inventory('stock', { kind: 'ids', ids: [product.id] })], request.text);
    const preview = await prepare(request, provider(response));
    await sql.query('UPDATE products SET name=$3,stock_available=99 WHERE owner_phone=$1 AND id=$2', [owner, product.id, 'Nombre cambiado después']);
    await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=$2', [owner, deleted.id]);
    const before = await state(true);
    assert.deepEqual(await prepare(request, { complete: forbidden }), preview);
    assert.deepEqual(await db.getUniversalDraft(preview.draftId, context()), preview);
    await assert.rejects(db.getUniversalDraft(preview.draftId, context(owner, owner, ['accounts:read'])), { code: 'FORBIDDEN' });
    for (const action of [
      () => db.confirmUniversalDraft(preview.draftId, { version: preview.version, digest: preview.digest }, context()),
      () => db.cancelUniversalDraft(preview.draftId, { version: preview.version, digest: preview.digest }, context()),
      () => db.replyUniversalDraft(preview.draftId, { requestId: id(), text: 'cambio', version: preview.version }, context(), { complete: forbidden }),
    ]) await assert.rejects(action, { code: 'DRAFT_NOT_PENDING' });
    assert.deepEqual(await state(true), before);
    assert.ok(preview.answer.items[0].rows[0].name.startsWith('Replay original '));
    assert.equal(preview.answer.items[0].rows[0].stockAvailable, 6);
  });

  await check('universal query: forged catalog IDs and missing read permissions reject without saving an answer', async () => {
    const fixture = await seed();
    const forged = { requestId: id(), text: '¿Qué stock tiene el artículo indicado?' }, before = await state(true);
    const invalidProvider = provider(queryResponse([inventory('stock', { kind: 'ids', ids: [`forged-${fixture.product.id}`] })], forged.text));
    await assert.rejects(prepare(forged, invalidProvider), { code: 'INTERPRETATION_INVALID' });
    assert.equal(invalidProvider.calls, 1); assert.deepEqual(await state(true), before);
    const denied = { requestId: id(), text: '¿Qué deben las cuentas?' }, deniedBefore = await state(true);
    const fake = provider(queryResponse([accounts('accounts')], denied.text));
    await assert.rejects(prepare(denied, fake, context(owner, owner, ['inventory:read'])), { code: 'INTERPRETATION_INVALID' });
    assert.equal(fake.calls, 1); assert.deepEqual(await state(true), deniedBefore);
  });

  await check('universal query: clarification reply advances to an answered version 2', async () => {
    const fixture = await seed(), initialText = '¿Cuánto stock tiene ese producto?', initialRequest = { requestId: id(), text: initialText };
    const initial = await prepare(initialRequest, provider({ ok: true, json: { contractVersion: 1, kind: 'clarification', question: '¿Qué producto querés consultar?' } }));
    assert.equal(initial.status, 'awaiting_clarification');
    const replyText = `Consultá el ID ${fixture.product.id}.`, request = { requestId: id(), text: replyText, version: initial.version };
    const fake = provider(queryResponse([inventory('stock', { kind: 'ids', ids: [fixture.product.id] })], replyText));
    const before = await state(true), beforeLedgers = await state(false), answered = await db.replyUniversalDraft(initial.draftId, request, context(), { complete: fake.complete });
    assert.equal(fake.calls, 1); assert.equal(answered.status, 'answered'); assert.equal(answered.version, 2);
    assert.equal(answered.text, `${initialText}\n${replyText}`); assert.equal(answered.answer.items[0].rows[0].stockAvailable, 8);
    assert.deepEqual(answered.clarifications, [{ question: initial.question, answer: replyText }]);
    assert.deepEqual(await state(false), beforeLedgers);
    const after = await state(true);
    assert.equal(after.universal_drafts.length, before.universal_drafts.length);
    assert.equal(after.universal_draft_commands.length, before.universal_draft_commands.length + 1);
    assert.deepEqual(after.universal_drafts.find(({ draft_id }) => draft_id === initial.draftId)?.preview_json, answered);
    assert.deepEqual(await db.replyUniversalDraft(initial.draftId, request, context(), { complete: forbidden }), answered);
  });

  await check('universal query: draft-save and command-write SQL failures roll back answer and allow exact retry', async () => {
    const request = { requestId: id(), text: '¿Qué saldo tiene el cliente?' }, fakeResponse = queryResponse([accounts('accounts')], request.text);
    const before = await state(true);
    await sql.query(`CREATE FUNCTION universal_query_answer_save_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.status='answered' THEN RAISE EXCEPTION 'answer save failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_query_answer_save_failure BEFORE INSERT ON universal_drafts FOR EACH ROW EXECUTE FUNCTION universal_query_answer_save_failure()`);
    try { await assert.rejects(prepare(request, provider(fakeResponse)), /answer save failure/); }
    finally { await sql.query('DROP TRIGGER universal_query_answer_save_failure ON universal_drafts; DROP FUNCTION universal_query_answer_save_failure()'); }
    assert.deepEqual(await state(true), before);
    const triggerRequest = { requestId: id(), text: request.text };
    await sql.query(`CREATE FUNCTION universal_query_command_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.request_id='${triggerRequest.requestId}' THEN RAISE EXCEPTION 'answer command failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_query_command_failure BEFORE INSERT ON universal_draft_commands FOR EACH ROW EXECUTE FUNCTION universal_query_command_failure()`);
    try { await assert.rejects(prepare(triggerRequest, provider(queryResponse([accounts('accounts')], triggerRequest.text)), context()), /answer command failure/); }
    finally { await sql.query('DROP TRIGGER universal_query_command_failure ON universal_draft_commands; DROP FUNCTION universal_query_command_failure()'); }
    assert.deepEqual(await state(true), before);
    const answered = await prepare(triggerRequest, provider(queryResponse([accounts('accounts')], triggerRequest.text)));
    assert.equal(answered.status, 'answered');
    assert.deepEqual(await prepare(triggerRequest, { complete: forbidden }), answered);
  });

  await check('universal query: provider-time catalog mutation cannot change snapshot facts or observed timestamp', async () => {
    const product = await db.createProductRecord({ name: `Snapshot before ${id()}`, stockAvailable: 13, unit: 'unit', price: 77 }, owner, { operationId: id() });
    const request = { requestId: id(), text: '¿Cuánto stock hay?' };
    let mutationTime;
    const fake = { calls: 0, complete: async ({ messages }) => {
      fake.calls++;
      const supplied = JSON.parse(messages[1].content);
      const catalogRow = supplied.catalog.products.find(({ id: rowId }) => rowId === product.id);
      assert.ok(catalogRow.name.startsWith('Snapshot before ')); assert.equal(catalogRow.stockAvailable, 13);
      await sql.query("UPDATE products SET name='Snapshot after',stock_available=91 WHERE owner_phone=$1 AND id=$2", [owner, product.id]);
      mutationTime = (await sql.query('SELECT CURRENT_TIMESTAMP AS at')).rows[0].at;
      return queryResponse([inventory('stock', { kind: 'ids', ids: [product.id] })], request.text);
    } };
    const answered = await prepare(request, fake);
    assert.equal(fake.calls, 1); assert.ok(answered.answer.items[0].rows[0].name.startsWith('Snapshot before '));
    assert.equal(answered.answer.items[0].rows[0].stockAvailable, 13);
    assert.ok(new Date(answered.answer.observedAt).getTime() <= new Date(mutationTime).getTime());
  });

  await check('universal query: ordinary Meta question saves an immutable answer and outbox reply on replay', async () => {
    const fixture = await seed(), request = { ownerPhone: owner, senderPhone: owner, messageId: id(), sourceText: '¿Qué stock hay?' };
    const fake = provider(queryResponse([inventory('stock', { kind: 'ids', ids: [fixture.product.id] })], request.sourceText));
    const result = await db.processMetaUniversalMessage(request, { ordinary: true, complete: fake.complete });
    assert.equal(fake.calls, 1); assert.equal(result.handled, true); assert.equal(result.status, 'answered');
    assert.equal(result.requiresConfirmation, false); assert.deepEqual(result.actions, []);
    assert.equal(result.answer.items[0].rows[0].stockAvailable, 8);
    assert.deepEqual((await sql.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1', [request.messageId])).rows,
      [{ recipient: owner, reply_text: result.replyText }]);
    const before = await state(true);
    assert.deepEqual(await db.processMetaUniversalMessage(request, { ordinary: true, complete: forbidden }), result);
    assert.deepEqual(await state(true), before);
  });

  await check('universal query: long Meta answer is rejected whole without draft or parser fallback', async () => {
    for (let index = 0; index < 20; index++) await db.createProductRecord({
      name: `Respuesta extensa ${index} ${'detalle identificador de producto '.repeat(5)} ${id()}`,
      stockAvailable: index + 1, unit: 'unit', price: 10,
    }, owner, { operationId: id() });
    const request = { ownerPhone: owner, senderPhone: owner, messageId: id(), sourceText: '¿Qué hay en inventario?' };
    const fake = provider(queryResponse([inventory('stock')], request.sourceText)), before = await state(true);
    const result = await db.processMetaUniversalMessage(request, { ordinary: true, complete: fake.complete });
    const after = await state(true);
    assert.equal(fake.calls, 1); assert.equal(result.errorCode, 'DRAFT_PREVIEW_TOO_LARGE');
    assert.equal(result.requiresConfirmation, false); assert.deepEqual(result.actions, []);
    for (const [table, rows] of Object.entries(before)) {
      if (!['universal_meta_commands', 'outbox'].includes(table)) assert.deepEqual(after[table], rows, `${table} must remain unchanged for a rejected long answer`);
    }
    assert.equal(after.universal_meta_commands.length, before.universal_meta_commands.length + 1);
    assert.equal(after.outbox.length, before.outbox.length + 1);
    assert.deepEqual(after.universal_drafts, before.universal_drafts, 'the rejected answer must leave no draft');
    assert.deepEqual(await db.processMetaUniversalMessage(request, { ordinary: true, complete: forbidden }), result);
  });
}
