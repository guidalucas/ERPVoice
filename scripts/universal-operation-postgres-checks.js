import assert from 'node:assert/strict';

export async function runUniversalOperationChecks({ db, sql, check }) {
  const a = '59899000961', b = '59899000962';
  let sequence = 0;
  const id = () => `universal-check-${++sequence}`;
  const allPermissions = ['inventory:create', 'inventory:receive', 'inventory:sell', 'inventory:reserve', 'inventory:adjust', 'inventory:update', 'inventory:deactivate', 'accounts:charge', 'accounts:payment', 'accounts:adjust', 'accounts:transfer', 'clients:create', 'clients:update', 'clients:delete', 'suppliers:create', 'suppliers:update', 'suppliers:delete', 'suppliers:merge'];
  const context = (businessId = a, permissions = allPermissions) => ({ businessId, actorId: 'universal-check-actor', permissions });
  const plan = (actions, operationId = id(), businessId = a) => ({ contractVersion: 1, businessId, operationId, actions });
  const run = (p, ctx = context()) => db.executeUniversalOperation(p, ctx);
  const receive = (name = `SKU universal ${id()}`) => ({ itemId: 'stock', type: 'stock.receive', target: { kind: 'new', sku: { name, unit: 'unit' } }, quantity: { value: 3, unit: 'unit' }, price: { amount: 0, currency: 'UYU', policy: 'initialize' } });
  const party = (name = `Cliente Universal ${id()}`) => ({ itemId: 'party', type: 'client.create', name, notas: 'Nota universal' });
  const customer = () => db.createClientRecord({ operationId: id(), name: `Cuenta Universal ${id()}` }, a);
  const charge = (clientId, value = 11) => ({ itemId: 'charge', type: 'account.charge', target: { kind: 'existing', clientId }, amount: { value, unit: 'legacy-money' }, reason: 'Cargo universal explícito' });
  const state = async () => {
    const result = {};
    for (const table of ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'inventory_operations', 'account_operations', 'party_operations', 'inventory_movements', 'account_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [a])).rows;
    return result;
  };
  const verifyStored = async (result, p, domain) => {
    assert.equal(result.contractVersion, 1); assert.equal(result.businessId, p.businessId); assert.equal(result.operationId, p.operationId); assert.equal(result.status, 'applied'); assert.equal(result.domain, domain);
    assert.ok(result.domainResult.operationId.startsWith('universal-child:')); assert.notEqual(result.domainResult.operationId, p.operationId);
    const parent = (await sql.query('SELECT * FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [p.businessId, p.operationId])).rows;
    assert.equal(parent.length, 1); assert.deepEqual(parent[0].result_json, result); assert.equal(parent[0].actor_id, context().actorId); assert.ok(parent[0].request_hash);
    const table = { inventory: 'inventory_operations', accounts: 'account_operations', parties: 'party_operations' }[domain];
    const child = (await sql.query(`SELECT result_json FROM ${table} WHERE owner_phone=$1 AND operation_id=$2`, [p.businessId, result.domainResult.operationId])).rows;
    assert.equal(child.length, 1); assert.deepEqual(child[0].result_json, result.domainResult);
  };

  for (const domain of ['inventory', 'accounts', 'parties']) {
    await check(`universal ${domain} concurrent replay stores exact domain effect, child and root receipts once`, async () => {
      const client = domain === 'accounts' ? await customer() : null;
      const actions = domain === 'inventory' ? [receive()] : domain === 'accounts' ? [charge(client.id)] : [party(), { itemId: 'supplier', type: 'supplier.create', name: 'Proveedor Universal Persistido' }];
      const p = plan(actions), before = await state(), [one, two] = await Promise.all([run(p), run(p)]);
      assert.deepEqual(one, two); await verifyStored(one, p, domain);
      const after = await state();
      assert.equal(after.universal_operations.length, before.universal_operations.length + 1);
      const newHistory = after.transactions.filter(({ id }) => !before.transactions.some((row) => row.id === id));
      assert.deepEqual(newHistory.flatMap(({ actions_json }) => actions_json.map(({ type }) => type)).sort(), domain === 'inventory' ? ['add_stock'] : domain === 'accounts' ? ['add_debt'] : actions.map(({ type }) => type).sort());
      if (domain === 'inventory') {
        const skuId = one.domainResult.items[0].skuId;
        assert.equal(Number(after.products.find(({ id }) => id === skuId).stock_available), 3);
        const moves = after.inventory_movements.filter(({ operation_id }) => operation_id === one.domainResult.operationId);
        assert.equal(moves.length, 1); assert.equal(Number(moves[0].delta_available), 3); assert.deepEqual(after.account_movements, before.account_movements);
        await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=$2', [a, skuId]);
      } else if (domain === 'accounts') {
        assert.equal(Number(after.clients.find(({ id }) => id === client.id).debt), 11);
        assert.equal(one.domainResult.items[0].balance, 11);
        const moves = after.account_movements.filter(({ operation_id }) => operation_id === one.domainResult.operationId);
        assert.equal(moves.length, 1); assert.equal(Number(moves[0].delta), 11); assert.deepEqual(after.inventory_movements, before.inventory_movements);
        await run(plan([{ ...charge(client.id, 3), type: 'account.payment' }]));
      } else {
        for (const item of one.domainResult.items) {
          const table = item.type === 'client.create' ? 'clients' : 'proveedores', actual = after[table].find(({ id }) => id === item.party.id);
          assert.equal(actual.name, item.party.name); assert.equal(Number(actual.metadata_revision), 0);
        }
        assert.deepEqual(after.inventory_movements, before.inventory_movements); assert.deepEqual(after.account_movements, before.account_movements);
        const created = one.domainResult.items[0].party;
        await db.deleteClientRecord(created.id, a, { operationId: id(), expectedRevision: 0, expectedAccountRevision: 0, reason: 'Baja posterior al recibo universal' });
      }
      const later = await state();
      assert.deepEqual(await run(p), one); assert.deepEqual(await state(), later);
    });
  }

  await check('universal root IDs conflict across supported domains and changed same-domain intent', async () => {
    const client = await customer(), p = plan([party()]), receipt = await run(p), before = await state();
    await assert.rejects(run({ ...p, actions: [receive()] }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(run({ ...p, actions: [charge(client.id)] }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(run({ ...p, actions: [{ ...p.actions[0], notas: 'Otra intención' }] }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await state(), before); assert.deepEqual(await run(p), receipt);
  });

  await check('universal registry is tenant scoped and authorized actors can replay while denied contexts cannot', async () => {
    const p = plan([party('Cliente Universal Aislado')]), local = await run(p), before = await state();
    await assert.rejects(run(p, {}), { code: 'BUSINESS_SCOPE_REQUIRED' });
    await assert.rejects(run(p, context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(p, context(a, ['clients:update'])), { code: 'FORBIDDEN' });
    assert.deepEqual(await run(p, { ...context(), actorId: 'another-authorized-actor' }), local);
    assert.deepEqual(await state(), before);
    const foreign = await run({ ...p, businessId: b }, context(b));
    assert.notEqual(foreign.domainResult.items[0].party.id, local.domainResult.items[0].party.id);
    assert.equal((await sql.query('SELECT 1 FROM universal_operations WHERE operation_id=$1', [p.operationId])).rowCount, 2);
    assert.deepEqual(await state(), before);
  });

  await check('universal source channel and text do not change intent while account requestHash remains semantic', async () => {
    const client = await customer();
    for (const actions of [[receive()], [party()], [charge(client.id)]]) {
      const p = { ...plan(actions), source: { channel: 'panel', text: 'Fuente inicial' } }, one = await run(p), before = await state();
      assert.deepEqual(await run({ ...p, source: { channel: 'whatsapp', text: 'Fuente posterior' } }), one); assert.deepEqual(await state(), before);
    }
    const p = { ...plan([charge(client.id)]), source: { channel: 'panel', requestHash: 'semantic-intent-one' } };
    await run(p); const before = await state();
    await assert.rejects(run({ ...p, source: { channel: 'panel', requestHash: 'semantic-intent-two' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await state(), before);
  });

  await check('universal gateway rejects domain reentry, unsupported, malformed and unkeyed plans without any writes', async () => {
    const before = await state();
    for (const operationId of [undefined, '', ' ', 1, 'x'.repeat(181)]) await assert.rejects(run({ ...plan([party()]), operationId }), { code: 'OPERATION_ID_REQUIRED' });
    for (const extra of [{ contractVersion: 2 }, { ownerPhone: b }, { actions: [] }, { actions: [null] }, { actions: [{ type: 'order.unknown' }] }, { actions: [{ type: 'client.merge' }] }, { actions: [{ type: 'stock.unknown' }] }]) await assert.rejects(run({ ...plan([party()]), ...extra }), { code: 'INVALID_OPERATION_PLAN' });
    await assert.rejects(run(plan([party(), receive(), { ...party(), itemId: 'party-again' }])), { code: 'UNSUPPORTED_OPERATION_ORDER' });
    await assert.rejects(run(plan([{ ...party(), debt: 0 }])), { code: 'INVALID_PARTY_OPERATION' });
    assert.deepEqual(await state(), before);
  });

  await check('universal inventory updates and deactivation cannot bypass reviewed selections', async () => {
    const product = await db.createProductRecord({ name: 'Universal selección requerida A', stockAvailable: 3 }, a, { operationId: id() });
    const other = await db.createProductRecord({ name: 'Universal selección requerida B', stockAvailable: 3 }, a, { operationId: id() }), before = await state();
    const target = (sku) => ({ kind: 'existing', skuId: sku.id, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint });
    const batch = [product, other].map((sku, index) => ({ itemId: `edit-${index}`, type: 'sku.update', target: target(sku), changes: { price: 0 }, reason: 'Sin selección revisada' }));
    await assert.rejects(run(plan(batch)), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(run(plan([{ itemId: 'archive', type: 'sku.deactivate', target: target(product), reason: 'Sin selección revisada' }])), { code: 'SELECTION_REQUIRED' });
    assert.deepEqual(await state(), before);
  });

  await check('reserved universal child IDs cannot be invoked externally through any domain engine', async () => {
    const client = await customer(), before = await state();
    for (const [execute, actions] of [[db.executeInventoryOperation, [receive()]], [db.executeAccountOperation, [charge(client.id)]], [db.executePartyOperation, [party()]]]) await assert.rejects(execute(plan(actions, `universal-child:${'a'.repeat(64)}`), context()), { code: 'FORBIDDEN' });
    assert.deepEqual(await state(), before);
  });

  for (const domain of ['inventory', 'accounts', 'parties']) {
    await check(`universal ${domain} parent receipt SQL failure rolls back child effects, ledger, history and receipts before retry`, async () => {
      const client = domain === 'accounts' ? await customer() : null, actions = domain === 'inventory' ? [receive()] : domain === 'accounts' ? [charge(client.id)] : [party()];
      const p = plan(actions), before = await state();
      await sql.query(`CREATE FUNCTION reject_universal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' AND NEW.operation_id='${p.operationId}' THEN RAISE EXCEPTION 'universal parent receipt failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_universal_receipt BEFORE INSERT ON universal_operations FOR EACH ROW EXECUTE FUNCTION reject_universal_receipt();`);
      try { await assert.rejects(run(p), /universal parent receipt failure/); }
      finally { await sql.query('DROP TRIGGER reject_universal_receipt ON universal_operations; DROP FUNCTION reject_universal_receipt()'); }
      assert.deepEqual(await state(), before);
      const result = await run(p); await verifyStored(result, p, domain); const after = await state();
      assert.deepEqual(await run(p), result); assert.deepEqual(await state(), after);
    });
  }

  await check('universal and domain registries have RLS and repeated migration preserves all stored state', async () => {
    const tables = ['universal_operations', 'party_operations', 'inventory_operations', 'inventory_movements', 'account_operations', 'account_movements', 'order_operations', 'inventory_selections'];
    const rows = (await sql.query('SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY($1) ORDER BY relname', [tables])).rows;
    assert.equal(rows.length, tables.length); assert.ok(rows.every(({ relrowsecurity }) => relrowsecurity));
    const before = await state(); await db.migrateDatabase(); assert.deepEqual(await state(), before);
  });
}
