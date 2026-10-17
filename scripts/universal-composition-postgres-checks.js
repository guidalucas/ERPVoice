import assert from 'node:assert/strict';

export async function runUniversalCompositionChecks({ db, sql, check }) {
  const owner = '59899000963', foreign = '59899000964';
  let sequence = 0;
  const id = () => `universal-composition-${++sequence}`;
  const permissions = ['inventory:receive', 'inventory:update', 'inventory:deactivate', 'accounts:charge', 'accounts:payment', 'clients:create', 'clients:delete', 'suppliers:update'];
  const context = (businessId = owner, allowed = permissions) => ({ businessId, actorId: 'composition-actor', permissions: allowed });
  const plan = (actions, operationId = id()) => ({ contractVersion: 1, businessId: owner, operationId, actions });
  const run = (input, ctx = context()) => db.executeUniversalOperation(input, ctx);
  const client = (business = owner) => db.createClientRecord({ operationId: id(), name: `Composición cuenta ${id()}` }, business);
  const supplier = () => db.createProveedorRecord({ operationId: id(), name: `Composición proveedor ${id()}` }, owner);
  const receive = (product) => ({ itemId: 'stock', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 3, unit: 'unit' } });
  const account = (party, type = 'account.charge', value = 7) => ({ itemId: 'money', type, target: { kind: 'existing', clientId: party.id }, amount: { value, unit: 'legacy-money' }, reason: 'Importe explícito de composición' });
  const update = (party) => ({ itemId: 'supplier', type: 'supplier.update', target: { kind: 'existing', partyId: party.id, expectedRevision: party.metadataRevision }, changes: { notas: 'Actualizado dentro de composición' } });
  const remove = (party, expectedAccountRevision) => ({ itemId: 'delete', type: 'client.delete', target: { kind: 'existing', partyId: party.id, expectedRevision: party.metadataRevision, expectedAccountRevision }, reason: 'Baja después del pago' });
  const product = () => db.createProductRecord({ name: `Composición SKU ${id()}`, stockAvailable: 2, price: 99 }, owner, { operationId: id() });
  const state = async () => {
    const result = {};
    for (const table of ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'inventory_operations', 'account_operations', 'party_operations', 'inventory_movements', 'account_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
    return result;
  };
  const parent = async (operationId) => (await sql.query('SELECT * FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, operationId])).rows[0];
  const assertReceipts = async (result, input, domains) => {
    assert.deepEqual([result.contractVersion, result.businessId, result.operationId, result.status, result.domain], [1, owner, input.operationId, 'applied', 'mixed']);
    assert.equal(result.receipts.length, domains.length); assert.equal(new Set(result.receipts.map(({ operationId }) => operationId)).size, domains.length);
    for (const [index, domain] of domains.entries()) {
      const receipt = result.receipts[index]; assert.ok(receipt.operationId.startsWith('universal-child:'));
      const table = { inventory: 'inventory_operations', accounts: 'account_operations', parties: 'party_operations' }[domain];
      assert.deepEqual((await sql.query(`SELECT result_json FROM ${table} WHERE owner_phone=$1 AND operation_id=$2`, [owner, receipt.operationId])).rows[0].result_json, receipt);
    }
    assert.deepEqual((await parent(input.operationId)).result_json, result);
  };

  await check('universal composition: ordered inventory/account/supplier blocks persist exact effects, ledgers and every receipt/history', async () => {
    const sku = await product(), customer = await client(), provider = await supplier(), before = await state();
    const input = plan([receive(sku), account(customer), update(provider)]), result = await run(input);
    await assertReceipts(result, input, ['inventory', 'accounts', 'parties']);
    assert.deepEqual(result.receipts.map(({ items }) => items[0].type), ['stock.receive', 'account.charge', 'supplier.update']);
    const after = await state(); assert.equal(Number(after.products.find(({ id }) => id === sku.id).stock_available), 5);
    assert.equal(Number(after.clients.find(({ id }) => id === customer.id).debt), 7);
    assert.equal(after.proveedores.find(({ id }) => id === provider.id).notas, 'Actualizado dentro de composición');
    assert.equal(after.inventory_movements.length, before.inventory_movements.length + 1); assert.equal(after.account_movements.length, before.account_movements.length + 1);
    const newHistory = after.transactions.filter(({ id }) => !before.transactions.some((row) => row.id === id));
    assert.equal(newHistory.length, 3); assert.deepEqual(newHistory.flatMap(({ actions_json }) => actions_json.map(({ type }) => type)).sort(), ['add_debt', 'add_stock', 'supplier.update'].sort());
  });

  await check('universal composition: concurrent roots execute once and replay frozen ordered receipts after later changes', async () => {
    const sku = await product(), customer = await client(), provider = await supplier();
    const input = plan([receive(sku), account(customer), update(provider)]), before = await state();
    const [one, two] = await Promise.all([run(input), run(input)]); assert.deepEqual(one, two);
    await assertReceipts(one, input, ['inventory', 'accounts', 'parties']);
    const after = await state();
    for (const table of ['universal_operations', 'inventory_operations', 'account_operations', 'party_operations', 'inventory_movements', 'account_movements']) assert.equal(after[table].length, before[table].length + 1);
    await run(plan([receive(sku)])); await run(plan([account(customer, 'account.payment', 2)]));
    await db.updateProveedorRecord(provider.id, { operationId: id(), expectedRevision: provider.metadataRevision + 1, notas: 'Cambio posterior' }, owner);
    const later = await state(); assert.deepEqual(await run(input), one); assert.deepEqual(await state(), later);
    await assert.rejects(run({ ...input, actions: [input.actions[0], account(customer, 'account.charge', 8), input.actions[2]] }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await state(), later);
  });

  await check('universal composition: payment then deletion observes user order; reversed order rejects and rolls back', async () => {
    const customer = await client(); await run(plan([account(customer)]));
    const before = await state(), reverse = plan([remove(customer, 1), account(customer, 'account.payment', 7)]);
    await assert.rejects(run(reverse), { code: 'CLIENT_HAS_BALANCE' }); assert.deepEqual(await state(), before);
    const input = plan([account(customer, 'account.payment', 7), remove(customer, 2)]), result = await run(input);
    await assertReceipts(result, input, ['accounts', 'parties']); assert.equal(result.receipts[0].items[0].balance, 0); assert.equal(result.receipts[1].items[0].deleted, true);
    assert.equal((await state()).clients.some(({ id }) => id === customer.id), false);
    const after = await state(); assert.deepEqual(await run(input), result); assert.deepEqual(await state(), after);
  });

  await check('universal composition: missing last party and excessive last payment roll back previous stock and child receipts', async () => {
    const sku = await product(), customer = await client();
    for (const [last, code] of [[{ ...update({ id: 'missing-composition-party', metadataRevision: 0 }) }, 'PARTY_NOT_FOUND'], [account(customer, 'account.payment', 1), 'PAYMENT_EXCEEDS_DEBT']]) {
      const before = await state(), input = plan([receive(sku), last]);
      await assert.rejects(run(input), { code }); assert.deepEqual(await state(), before); assert.equal(await parent(input.operationId), undefined);
    }
  });

  await check('universal composition: malformed and unauthorized last blocks validate before any execution', async () => {
    const sku = await product(), customer = await client(), before = await state();
    await sql.query(`CREATE FUNCTION composition_no_early_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' THEN RAISE EXCEPTION 'unexpected early inventory write'; END IF; RETURN NEW; END $$; CREATE TRIGGER composition_no_early_write BEFORE INSERT ON inventory_operations FOR EACH ROW EXECUTE FUNCTION composition_no_early_write()`);
    try {
      await assert.rejects(run(plan([receive(sku), { ...account(customer), amount: { value: -1, unit: 'legacy-money' } }])), { code: 'INVALID_ACCOUNT_OPERATION' });
      await assert.rejects(run(plan([receive(sku), account(customer)]), context(owner, ['inventory:receive'])), { code: 'FORBIDDEN' });
    } finally { await sql.query('DROP TRIGGER composition_no_early_write ON inventory_operations; DROP FUNCTION composition_no_early_write()'); }
    assert.deepEqual(await state(), before);
  });

  await check('universal composition: root receipt SQL failure rolls back all domain state and retry applies once', async () => {
    const input = plan([receive(await product()), account(await client()), update(await supplier())]), before = await state();
    await sql.query(`CREATE FUNCTION composition_parent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.operation_id='${input.operationId}' THEN RAISE EXCEPTION 'composition root receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER composition_parent_failure BEFORE INSERT ON universal_operations FOR EACH ROW EXECUTE FUNCTION composition_parent_failure()`);
    try { await assert.rejects(run(input), /composition root receipt failure/); } finally { await sql.query('DROP TRIGGER composition_parent_failure ON universal_operations; DROP FUNCTION composition_parent_failure()'); }
    assert.deepEqual(await state(), before); const result = await run(input); await assertReceipts(result, input, ['inventory', 'accounts', 'parties']);
    const after = await state(); assert.deepEqual(await run(input), result); assert.deepEqual(await state(), after);
  });

  await check('universal composition: every block enforces business scope and reserved child IDs stay inaccessible', async () => {
    const sku = await product(), local = await client(), other = await client(foreign), before = await state();
    const input = plan([receive(sku), account(local)]);
    await assert.rejects(run(input, context(foreign)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(plan([receive(sku), account(other)])), { code: 'CLIENT_NOT_FOUND' });
    const foreignSku = await db.createProductRecord({ name: `Foreign ${id()}`, stockAvailable: 3 }, foreign, { operationId: id() });
    await assert.rejects(run(plan([receive(foreignSku), account(local)])), { code: 'SKU_NOT_FOUND' });
    const foreignSupplier = await db.createProveedorRecord({ name: `Foreign supplier ${id()}`, operationId: id() }, foreign);
    await assert.rejects(run(plan([receive(sku), account(local), update(foreignSupplier)])), { code: 'PARTY_NOT_FOUND' });
    assert.deepEqual(await state(), before);
    const result = await run(input);
    await assert.rejects(db.executeInventoryOperation(plan([receive(sku)], result.receipts[0].operationId), context()), { code: 'FORBIDDEN' });
    await assert.rejects(db.executeAccountOperation(plan([account(local)], result.receipts[1].operationId), context()), { code: 'FORBIDDEN' });
  });

  await check('universal composition: domain reentry, global duplicate IDs and selection bypass reject every effect', async () => {
    const sku = await product(), second = await product(), customer = await client(), before = await state();
    await assert.rejects(run(plan([receive(sku), account(customer), { ...receive(second), itemId: 'stock-again' }])), { code: 'UNSUPPORTED_OPERATION_ORDER' });
    await assert.rejects(run(plan([receive(sku), { ...account(customer), itemId: 'stock' }])), { code: 'INVALID_OPERATION_PLAN' });
    const target = (product) => ({ kind: 'existing', skuId: product.id, expectedRevision: product.revision });
    const edits = [sku, second].map((product, index) => ({ itemId: `edit-${index}`, type: 'sku.update', target: target(product), changes: { price: 0 }, reason: 'Sin selección revisada' }));
    await assert.rejects(run(plan([...edits, account(customer)])), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(run(plan([{ itemId: 'archive', type: 'sku.deactivate', target: target(sku), reason: 'Sin selección revisada' }, account(customer)])), { code: 'SELECTION_REQUIRED' });
    assert.deepEqual(await state(), before);
  });
}
