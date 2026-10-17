import assert from 'node:assert/strict';

export async function runUniversalDraftChecks({ db, sql, check }) {
  const owner = '59899000967', other = '59899000968'; let sequence = 0;
  const id = () => `universal-draft-check-${++sequence}`;
  const context = (businessId = owner, actorId = owner) => ({ businessId, actorId, channel: 'panel', permissions: ['inventory:receive', 'accounts:charge', 'accounts:payment'] });
  const seed = async () => ({
    product: await db.createProductRecord({ name: `Draft SKU ${id()}`, stockAvailable: 2, unit: 'unit', price: 99 }, owner, { operationId: id() }),
    client: await db.createClientRecord({ name: `Draft cliente ${id()}`, operationId: id() }, owner),
  });
  const text = 'Ingresaron tres unidades y cargá siete a la cuenta.';
  const actions = ({ product, client }) => [
    { itemId: 'stock', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 3, unit: 'unit' } },
    { itemId: 'money', type: 'account.charge', target: { kind: 'existing', clientId: client.id }, amount: { value: 7, unit: 'legacy-money' }, reason: 'Cargo explícito revisado' },
  ];
  const model = (items, quote = text) => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions: items, evidence: items.map(({ itemId }) => ({ itemId, quote })) } });
  const provider = (response) => {
    const fake = { calls: 0, complete: async () => { fake.calls++; return response; } }; return fake;
  };
  const forbiddenProvider = async () => { assert.fail('replay or stale reply must not call the interpretation provider'); };
  const confirmation = ({ version, digest }) => ({ version, digest });
  const prepare = (request, fake, ctx = context()) => db.prepareUniversalDraft(request, ctx, { complete: fake.complete });
  const confirm = (preview, ctx = context()) => db.confirmUniversalDraft(preview.draftId, confirmation(preview), ctx);
  const state = async (drafts = false) => {
    const result = {};
    for (const table of ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'inventory_operations', 'account_operations', 'party_operations', 'order_operations', 'inventory_movements', 'account_movements', 'transactions', ...(drafts ? ['universal_drafts', 'universal_draft_commands'] : [])]) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
    return result;
  };
  const laterStock = (product) => db.executeInventoryOperation({ contractVersion: 1, businessId: owner, operationId: id(), actions: [{ itemId: 'later', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 1, unit: 'unit' } }] }, context());

  await check('universal draft: ready mixed preview is effect free and concurrent confirmation stores exact effects and frozen receipts once', async () => {
    const fixture = await seed(), fake = provider(model(actions(fixture))), request = { requestId: id(), text };
    await sql.query("UPDATE products SET name='River',product_type='Camiseta',product_model='Titular',size='M' WHERE owner_phone=$1 AND id=$2",[owner,fixture.product.id]);
    const before=await state();
    const preview = await prepare(request, fake); assert.equal(fake.calls, 1); assert.equal(preview.status, 'awaiting_confirmation'); assert.equal(preview.version, 1);
    assert.deepEqual(await state(), before); assert.equal(preview.plan.operationId, `draft-operation:${preview.draftId}`); assert.equal(preview.evidence.length, 2); assert.ok(preview.trace);
    assert.equal(preview.review[0].title,'Ingreso de existencias · River');
    assert.ok(preview.review[0].details.includes('Tipo: Camiseta'));
    assert.deepEqual(await db.getUniversalDraft(preview.draftId, context()), preview);
    const [one, two] = await Promise.all([confirm(preview), confirm(preview)]); assert.deepEqual(one, two); assert.equal(one.status, 'applied'); assert.equal(one.result.domain, 'mixed');
    assert.deepEqual(one.result.receipts.map(({ items }) => items[0].type), ['stock.receive', 'account.charge']);
    const after = await state(); assert.equal(Number(after.products.find(({ id }) => id === fixture.product.id).stock_available), 5); assert.equal(Number(after.clients.find(({ id }) => id === fixture.client.id).debt), 7);
    assert.equal(after.universal_operations.length, before.universal_operations.length + 1); assert.equal(after.inventory_movements.length, before.inventory_movements.length + 1); assert.equal(after.account_movements.length, before.account_movements.length + 1); assert.equal(after.transactions.length, before.transactions.length + 2);
    assert.deepEqual(after.universal_operations.find(({ operation_id }) => operation_id === one.result.operationId).result_json, one.result);
    await laterStock(fixture.product); const later = await state(true);
    assert.deepEqual(await db.prepareUniversalDraft(request, context(), { complete: forbiddenProvider }), preview); assert.deepEqual(await confirm(preview), one); assert.deepEqual(await state(true), later);
  });

  await check('universal draft: clarification reply advances version, combines text and replays original commands without provider calls', async () => {
    const fixture = await seed(), firstProvider = provider({ ok: true, json: { contractVersion: 1, kind: 'clarification', question: '¿Cuántas unidades ingresaron?' } });
    const initialRequest = { requestId: id(), text: 'Recibí mercadería.' }, initial = await prepare(initialRequest, firstProvider), before = await state();
    assert.equal(initial.status, 'awaiting_clarification'); assert.match(initial.question, /Cuántas/); assert.equal(initial.plan, undefined);
    const replyRequest = { requestId: id(), text, version: initial.version }, readyProvider = provider(model(actions(fixture)));
    const complete=readyProvider.complete;
    readyProvider.complete=async options=>{
      const supplied=JSON.parse(options.messages[1].content);
      assert.deepEqual(supplied.clarifications,[{question:initial.question,answer:text}]);
      return complete(options);
    };
    const ready = await db.replyUniversalDraft(initial.draftId, replyRequest, context(), { complete: readyProvider.complete });
    assert.equal(ready.version, 2); assert.equal(ready.text, `${initial.text}\n${text}`); assert.equal(ready.status, 'awaiting_confirmation'); assert.equal(readyProvider.calls, 1); assert.deepEqual(await state(), before);
    assert.deepEqual(ready.clarifications,[{question:initial.question,answer:text}]);
    assert.deepEqual(await db.prepareUniversalDraft(initialRequest, context(), { complete: forbiddenProvider }), initial);
    assert.deepEqual(await db.replyUniversalDraft(initial.draftId, replyRequest, context(), { complete: forbiddenProvider }), ready);
    await assert.rejects(db.replyUniversalDraft(initial.draftId, { requestId: id(), text: 'otra respuesta', version: 1 }, context(), { complete: forbiddenProvider }), { code: 'DRAFT_VERSION_MISMATCH' });
    assert.equal((await confirm(ready)).status, 'applied');
  });

  await check('universal draft: invalid/unavailable interpretation leaves all state unchanged and permits retry with the same request ID', async () => {
    const fixture = await seed();
    for (const [response, code] of [[{ ok: true, json: { contractVersion: 1, kind: 'proposal', actions: [], evidence: [] } }, 'INTERPRETATION_INVALID'], [{ ok: false, reason: 'provider_unavailable' }, 'INTERPRETATION_UNAVAILABLE']]) {
      const request = { requestId: id(), text }, before = await state(true), fake = provider(response);
      await assert.rejects(prepare(request, fake), { code }); assert.equal(fake.calls, 1); assert.deepEqual(await state(true), before);
      const ready = await prepare(request, provider(model(actions(fixture)))); assert.equal(ready.status, 'awaiting_confirmation');
    }
  });

  await check('universal draft: stale catalog snapshot rejects every mixed effect without changing pending draft or receipts', async () => {
    const fixture = await seed(), preview = await prepare({ requestId: id(), text }, provider(model(actions(fixture))));
    await laterStock(fixture.product); const before = await state(true);
    await assert.rejects(confirm(preview), { code: 'REVISION_MISMATCH' }); assert.deepEqual(await state(true), before);
    assert.equal((await db.getUniversalDraft(preview.draftId, context())).status, 'awaiting_confirmation');
  });

  await check('universal draft: actor/tenant, expiry, digest/version and cancellation scope protect confirmation', async () => {
    const fixture = await seed(), preview = await prepare({ requestId: id(), text }, provider(model(actions(fixture)))), before = await state();
    for (const ctx of [context(other), context(owner, other)]) {
      await assert.rejects(db.getUniversalDraft(preview.draftId, ctx), { code: 'DRAFT_NOT_FOUND' }); await assert.rejects(confirm(preview, ctx), { code: 'DRAFT_NOT_FOUND' });
    }
    await assert.rejects(db.confirmUniversalDraft(preview.draftId, { ...confirmation(preview), version: preview.version + 1 }, context()), { code: 'DRAFT_VERSION_MISMATCH' });
    await assert.rejects(db.confirmUniversalDraft(preview.draftId, { ...confirmation(preview), digest: preview.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) }, context()), { code: 'DRAFT_VERSION_MISMATCH' });
    const cancelled = await db.cancelUniversalDraft(preview.draftId, confirmation(preview), context()); assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(await db.cancelUniversalDraft(preview.draftId, confirmation(preview), context()), cancelled);
    await assert.rejects(confirm(preview), { code: 'DRAFT_NOT_PENDING' }); assert.deepEqual(await state(), before);
    const expiring = await prepare({ requestId: id(), text }, provider(model(actions(fixture))));
    await sql.query("UPDATE universal_drafts SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND draft_id=$2", [owner, expiring.draftId]);
    await assert.rejects(confirm(expiring), { code: 'DRAFT_EXPIRED' }); assert.deepEqual(await state(), before);
    assert.equal((await db.cancelUniversalDraft(expiring.draftId,confirmation(expiring),context())).status,'cancelled');
  });

  await check('universal draft: request collisions fail before provider execution and preserve original prepare/reply responses', async () => {
    const fixture = await seed(), request = { requestId: id(), text }, preview = await prepare(request, provider(model(actions(fixture)))), before = await state(true);
    await assert.rejects(db.prepareUniversalDraft({ ...request, text: 'Intención distinta' }, context(), { complete: forbiddenProvider }), { code: 'IDEMPOTENCY_CONFLICT' }); assert.deepEqual(await state(true), before);
    const initial = await prepare({ requestId: id(), text: 'Falta una cantidad' }, provider({ ok: true, json: { contractVersion: 1, kind: 'clarification', question: '¿Cantidad?' } }));
    const reply = { requestId: id(), version: initial.version, text }, ready = await db.replyUniversalDraft(initial.draftId, reply, context(), { complete: provider(model(actions(fixture))).complete });
    const after = await state(true); await assert.rejects(db.replyUniversalDraft(initial.draftId, { ...reply, text: 'Otra cantidad' }, context(), { complete: forbiddenProvider }), { code: 'IDEMPOTENCY_CONFLICT' }); assert.deepEqual(await state(true), after);
    assert.deepEqual(await db.prepareUniversalDraft(request, context(), { complete: forbiddenProvider }), preview); assert.deepEqual(await db.replyUniversalDraft(initial.draftId, reply, context(), { complete: forbiddenProvider }), ready);
  });

  await check('universal draft: command persistence and applied-status SQL failures roll back drafts/effects/receipts and permit exact retry', async () => {
    const fixture = await seed(), request = { requestId: id(), text }, before = await state(true);
    await sql.query(`CREATE FUNCTION universal_draft_command_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.request_id='${request.requestId}' THEN RAISE EXCEPTION 'draft command persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_draft_command_failure BEFORE INSERT ON universal_draft_commands FOR EACH ROW EXECUTE FUNCTION universal_draft_command_failure()`);
    try { await assert.rejects(prepare(request, provider(model(actions(fixture)))), /draft command persistence failure/); } finally { await sql.query('DROP TRIGGER universal_draft_command_failure ON universal_draft_commands; DROP FUNCTION universal_draft_command_failure()'); }
    assert.deepEqual(await state(true), before); const preview = await prepare(request, provider(model(actions(fixture)))), pending = await state(true);
    await sql.query(`CREATE FUNCTION universal_draft_applied_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.draft_id='${preview.draftId}' AND NEW.status='applied' THEN RAISE EXCEPTION 'draft applied persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_draft_applied_failure BEFORE UPDATE ON universal_drafts FOR EACH ROW EXECUTE FUNCTION universal_draft_applied_failure()`);
    try { await assert.rejects(confirm(preview), /draft applied persistence failure/); } finally { await sql.query('DROP TRIGGER universal_draft_applied_failure ON universal_drafts; DROP FUNCTION universal_draft_applied_failure()'); }
    assert.deepEqual(await state(true), pending); const result = await confirm(preview); assert.equal(result.status, 'applied'); const after = await state(true); assert.deepEqual(await confirm(preview), result); assert.deepEqual(await state(true), after);
  });
}
