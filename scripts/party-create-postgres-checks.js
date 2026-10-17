import assert from 'node:assert/strict';

/** Real PostgreSQL checks for the closed, atomic party creation contract. */
export async function runPartyCreateChecks({ db, sql, check }) {
  const a = '59899000931', b = '59899000932';
  let sequence = 0;
  const id = () => `party-create-check-${++sequence}`;
  const context = (businessId = a, permissions = ['clients:create', 'suppliers:create']) => ({ businessId, actorId: 'party-check-actor', permissions });
  const action = (type = 'client.create', name = 'Cliente alta verificada', itemId = 'one', extra = {}) => ({ itemId, type, name, ...extra });
  const plan = (actions, operationId = id(), businessId = a) => ({ contractVersion: 1, businessId, operationId, actions });
  const run = (p, ctx = context()) => db.executePartyOperation(p, ctx);
  const state = async (owner = a) => {
    const result = {};
    for (const table of ['clients', 'proveedores', 'party_operations', 'transactions', 'inventory_movements', 'account_movements']) {
      result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
    }
    return result;
  };
  const history = async (owner = a) => (await sql.query('SELECT actions_json FROM transactions WHERE owner_phone=$1 ORDER BY id', [owner])).rows;

  await check('party creation concurrent batch replay stores exact parties, one receipt and one history per item', async () => {
    const before = await state();
    const p = plan([action('client.create', 'Cliente alta concurrente', 'client', { notas: 'Nota original' }), action('supplier.create', 'Proveedor alta concurrente', 'supplier')]);
    const [one, two] = await Promise.all([run(p), run(p)]);
    assert.deepEqual(one, two);
    assert.deepEqual(one.items.map(({ itemId, type }) => [itemId, type]), [['client', 'client.create'], ['supplier', 'supplier.create']]);
    assert.equal(one.items[0].party.debt, 0);
    const after = await state();
    assert.equal(after.clients.length, before.clients.length + 1);
    assert.equal(after.proveedores.length, before.proveedores.length + 1);
    assert.equal(after.party_operations.length, before.party_operations.length + 1);
    assert.equal(after.transactions.length, before.transactions.length + 2);
    assert.deepEqual(after.inventory_movements, before.inventory_movements);
    assert.deepEqual(after.account_movements, before.account_movements);
    const stored = after.party_operations.find((row) => row.operation_id === p.operationId);
    assert.deepEqual(stored.result_json, one); assert.equal(stored.actor_id, context().actorId);
    assert.equal(stored.request_hash.length > 0, true);
    const types = (await history()).flatMap(({ actions_json }) => actions_json.map(({ type }) => type));
    assert.equal(types.filter((type) => type === 'client.create').length, 1);
    assert.equal(types.filter((type) => type === 'supplier.create').length, 1);
    for (const item of one.items) {
      const table = item.type === 'client.create' ? 'clients' : 'proveedores';
      const actual = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 AND id=$2`, [a, item.party.id])).rows[0];
      assert.equal(actual.name, item.party.name); assert.equal(actual.notas ?? undefined, item.party.notas ?? undefined);
    }
    await assert.rejects(run({ ...p, actions: [{ ...p.actions[0], name: 'Nombre cambiado' }, p.actions[1]] }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(run({ ...p, actions: [action('supplier.create', p.actions[0].name, 'client'), p.actions[1]] }), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await check('party compatibility creation returns frozen originals after edits and deletion without resurrection', async () => {
    for (const [create, update, remove, table] of [
      [db.createClientRecord, db.updateClientRecord, db.deleteClientRecord, 'clients'],
      [db.createProveedorRecord, db.updateProveedorRecord, db.deleteProveedorRecord, 'proveedores'],
    ]) {
      const input = { operationId: id(), name: `Alta original ${table}`, notas: 'Nota original' };
      const [original, concurrent] = await Promise.all([create(input, a), create(input, a)]);
      assert.deepEqual(original, concurrent);
      await update(original.id, { operationId: id(), expectedRevision: original.metadataRevision, name: 'Nombre posterior', notas: 'Nota posterior' }, a);
      assert.deepEqual(await create(input, a), original);
      await remove(original.id, a);
      const before = await state();
      assert.deepEqual(await create(input, a), original);
      assert.deepEqual(await state(), before);
      assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE id=$1`, [original.id])).rowCount, 0);
      await assert.rejects(create({ ...input, notas: 'Cambio de intención' }, a), { code: 'IDEMPOTENCY_CONFLICT' });
    }
  });

  await check('party creation rejects missing IDs, unsafe fields and debt without any persistence', async () => {
    const before = await state();
    for (const create of [db.createClientRecord, db.createProveedorRecord]) {
      for (const operationId of [undefined, '', '   ', 'x'.repeat(181), 1]) {
        await assert.rejects(create({ name: 'Alta sin ID', operationId }, a), { code: 'OPERATION_ID_REQUIRED' });
      }
      for (const extra of [{ ownerPhone: b }, { id: 'injected' }, { type: 'client.create' }, { name: '' }, { name: 9 }, { notas: {} }]) {
        await assert.rejects(create({ operationId: id(), name: 'Alta inválida', ...extra }, a), { code: 'INVALID_PARTY_OPERATION' });
      }
    }
    await assert.rejects(db.createClientRecord({ name: 'Deuda inicial prohibida', debt: 1 }, a), { code: 'ACCOUNT_OPERATION_REQUIRED' });
    await assert.rejects(db.createProveedorRecord({ operationId: id(), name: 'Deuda proveedor inválida', debt: 0 }, a), { code: 'INVALID_PARTY_OPERATION' });
    for (const extra of [{ contractVersion: 2 }, { extra: true }, { actions: [] }, { actions: [action('account.charge')] }, { actions: [action('client.create', 'Uno', 'same'), action('supplier.create', 'Dos', 'same')] }]) {
      await assert.rejects(run({ ...plan([action()]), ...extra }), { code: 'INVALID_PARTY_OPERATION' });
    }
    assert.deepEqual(await state(), before);
  });

  await check('party creation authorization runs before replay and operation IDs are tenant scoped', async () => {
    const p = plan([action()], id());
    const local = await run(p);
    const before = await state();
    await assert.rejects(run(p, {}), { code: 'BUSINESS_SCOPE_REQUIRED' });
    await assert.rejects(run(p, context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(p, context(a, ['suppliers:create'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([action('supplier.create')]), context(a, ['clients:create'])), { code: 'FORBIDDEN' });
    assert.deepEqual(await state(), before);
    const foreign = await run({ ...p, businessId: b }, context(b));
    assert.notEqual(foreign.items[0].party.id, local.items[0].party.id);
    assert.equal((await sql.query('SELECT 1 FROM party_operations WHERE operation_id=$1', [p.operationId])).rowCount, 2);
    assert.deepEqual(await run(p), local);
  });

  await check('party creation source metadata does not change canonical intent or frozen receipt', async () => {
    const p = plan([action('client.create', '  cliente canonico  ', 'one', { notas: '  Nota canónica  ' })]);
    const receipt = await run({ ...p, source: { channel: 'panel', text: 'Texto inicial' } });
    assert.deepEqual(await run({ ...p, actions: [action('client.create', 'Cliente Canonico', 'one', { notas: 'Nota canónica' })], source: { channel: 'whatsapp', text: 'Otra fuente' } }), receipt);
    const input = { operationId: id(), name: 'Alta saldo cero', debt: 0 };
    assert.equal((await db.createClientRecord(input, a)).debt, 0);
    assert.deepEqual(await db.createClientRecord({ operationId: input.operationId, name: input.name }, a), await db.createClientRecord(input, a));
    await assert.rejects(db.createProveedorRecord({ operationId: input.operationId, name: input.name }, a), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await check('concurrent interpreted orders share new exact-name parties and replay adds no history', async () => {
    const before = await state();
    const ordersBefore = (await sql.query('SELECT * FROM pedidos WHERE owner_phone=$1 ORDER BY id', [a])).rows;
    const actions = [{ type: 'client_order', clientName: 'Cliente Pedidos Concurrentes', proveedorName: 'Proveedor Pedidos Concurrentes', productName: 'Artículo pedido concurrente', qty: 1 }];
    const source = 'Dos solicitudes independientes con los mismos participantes exactos';
    const options = [{ operationId: id(), channel: 'whatsapp' }, { operationId: id(), channel: 'whatsapp' }];
    const [one, two] = await Promise.all(options.map((opts) => db.applyActionsToDatabase(actions, source, a, opts)));
    const first = one.operationResult.receipts[0].pedido, second = two.operationResult.receipts[0].pedido;
    assert.notEqual(first.id, second.id);
    assert.equal(first.clienteId, second.clienteId); assert.equal(first.proveedorId, second.proveedorId);
    const after = await state();
    assert.equal(after.clients.length, before.clients.length + 1);
    assert.equal(after.proveedores.length, before.proveedores.length + 1);
    assert.equal(after.clients.find(({ id }) => id === first.clienteId).name, actions[0].clientName);
    assert.equal(after.proveedores.find(({ id }) => id === first.proveedorId).name, actions[0].proveedorName);
    const parties = after.party_operations.filter(({ operation_id }) => !before.party_operations.some((row) => row.operation_id === operation_id));
    assert.equal(parties.length, 2); assert.ok(parties.every(({ operation_id }) => operation_id.startsWith('order-party:')));
    assert.deepEqual(parties.flatMap(({ result_json }) => result_json.items.map(({ type, party }) => [type, party.id])).sort(), [['client.create', first.clienteId], ['supplier.create', first.proveedorId]].sort());
    const history = after.transactions.filter(({ id }) => !before.transactions.some((row) => row.id === id));
    assert.equal(history.length, 4);
    assert.deepEqual(history.flatMap(({ actions_json }) => actions_json.map(({ type }) => type)).sort(), ['client.create', 'client_order', 'client_order', 'supplier.create']);
    assert.deepEqual(history.flatMap(({ actions_json }) => actions_json.filter(({ type }) => type === 'client_order').map(({ pedidoId }) => pedidoId)).sort(), [first.id, second.id].sort());
    assert.deepEqual(after.account_movements, before.account_movements); assert.deepEqual(after.inventory_movements, before.inventory_movements);
    const ordersAfter = (await sql.query('SELECT * FROM pedidos WHERE owner_phone=$1 ORDER BY id', [a])).rows;
    assert.equal(ordersAfter.length, ordersBefore.length + 2);
    assert.deepEqual((await db.applyActionsToDatabase(actions, source, a, options[0])).operationResult, one.operationResult);
    assert.deepEqual(await state(), after);
    assert.deepEqual((await sql.query('SELECT * FROM pedidos WHERE owner_phone=$1 ORDER BY id', [a])).rows, ordersAfter);
  });

  for (const failure of ['receipt', 'second-party', 'persisted-mismatch', 'persisted-debt']) {
    await check(`party creation ${failure} failure rolls back whole batch, receipt and history before retry`, async () => {
      const p = plan([action('client.create', 'Cliente transacción atómica'), action('supplier.create', 'Proveedor transacción atómica', 'two')]);
      const before = await state();
      const table = failure === 'receipt' ? 'party_operations' : failure === 'persisted-debt' ? 'clients' : 'proveedores';
      const effect = failure === 'persisted-mismatch' ? "NEW.name := NEW.name || ' alterado';" : failure === 'persisted-debt' ? 'NEW.debt := 1;' : `RAISE EXCEPTION 'party ${failure} failure';`;
      await sql.query(`CREATE FUNCTION reject_party_create_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN ${effect} END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_party_create_check BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_party_create_check();`);
      try {
        await assert.rejects(run(p), failure.startsWith('persisted-') ? { code: 'PERSISTED_EFFECT_MISMATCH' } : new RegExp(`party ${failure} failure`));
      } finally {
        await sql.query(`DROP TRIGGER reject_party_create_check ON ${table}; DROP FUNCTION reject_party_create_check()`);
      }
      assert.deepEqual(await state(), before);
      const receipt = await run(p); assert.equal(receipt.items.length, 2);
      assert.deepEqual(await run(p), receipt);
    });
  }
}
