import assert from 'node:assert/strict';
import { operationRequestDigest } from '../server/operationHash.js';

export async function runPartyDeleteMergeChecks({ db, sql, check }) {
  const a = '59899000951', b = '59899000952';
  let sequence = 0;
  const id = () => `party-delete-merge-${++sequence}`;
  const context = (businessId = a, permissions = ['clients:delete', 'suppliers:delete', 'suppliers:merge']) => ({ businessId, actorId: 'party-delete-merge-actor', permissions });
  const plan = (actions, operationId = id()) => ({ contractVersion: 1, businessId: a, operationId, actions });
  const run = (p, ctx = context()) => db.executePartyOperation(p, ctx);
  const create = (name, supplier = false, owner = a, notas = 'Nota inicial') => (supplier ? db.createProveedorRecord : db.createClientRecord)({ operationId: id(), name, notas }, owner);
  const deletion = (party, supplier = false, extra = {}) => ({ operationId: id(), expectedRevision: party.metadataRevision, ...(!supplier ? { expectedAccountRevision: party.accountRevision } : {}), reason: 'Baja explícita revisada', ...extra });
  const deleteAction = (party, supplier = false, itemId = 'one') => ({ itemId, type: supplier ? 'supplier.delete' : 'client.delete', target: { kind: 'existing', partyId: party.id, expectedRevision: party.metadataRevision, ...(!supplier ? { expectedAccountRevision: party.accountRevision } : {}) }, reason: 'Baja explícita revisada' });
  const mergeInput = (keep, source, extra = {}) => ({ operationId: id(), expectedKeepRevision: keep.metadataRevision, expectedMergeRevision: source.metadataRevision, reason: 'Fusión explícita revisada', ...extra });
  const mergeAction = (keep, source, itemId = 'one') => ({ itemId, type: 'supplier.merge', target: { kind: 'existing', partyId: source.id, expectedRevision: source.metadataRevision }, destination: { partyId: keep.id, expectedRevision: keep.metadataRevision }, reason: 'Fusión explícita revisada' });
  const state = async () => {
    const result = {};
    for (const table of ['clients', 'proveedores', 'pedidos', 'products', 'party_operations', 'account_operations', 'transactions', 'inventory_movements', 'account_movements']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [a])).rows;
    return result;
  };
  const account = (party, type, value) => db.executeAccountOperation({ contractVersion: 1, businessId: a, operationId: id(), actions: [{ itemId: 'money', type, target: { kind: 'existing', clientId: party.id }, amount: { value, unit: 'legacy-money' }, reason: 'Saldo verificado antes de baja' }] }, { businessId: a, actorId: a, permissions: ['accounts:charge', 'accounts:payment'] });
  const order = (client, supplier, product = null, extra = {}) => db.createPedidoRecord({ operationId: id(), clienteId: client.id, proveedorId: supplier?.id ?? null, producto: product?.name ?? 'Pedido vinculado a participante', ...(product ? { productId: product.id } : {}), qty: 2, ...extra }, a);
  const newRows = (after, before, table) => after[table].filter(({ id, operation_id }) => !before[table].some((row) => table.endsWith('_operations') ? row.operation_id === operation_id : row.id === id));

  await check('party delete concurrent replay persists one frozen receipt and one history after rows are gone', async () => {
    for (const supplier of [false, true]) {
      const party = await create(`Baja concurrente ${supplier}`, supplier), input = deletion(party, supplier), remove = supplier ? db.deleteProveedorRecord : db.deleteClientRecord;
      const before = await state(), [one, two] = await Promise.all([remove(party.id, a, input), remove(party.id, a, input)]);
      assert.deepEqual(one, two); assert.equal(one.items.length, 1);
      assert.equal(one.items[0].type, supplier ? 'supplier.delete' : 'client.delete');
      assert.deepEqual(one.items[0].party, party); assert.equal(one.items[0].deleted, true); assert.deepEqual(one.items[0].affectedOrders, []);
      const after = await state();
      assert.equal(after[supplier ? 'proveedores' : 'clients'].some(({ id }) => id === party.id), false);
      assert.equal(newRows(after, before, 'party_operations').length, 1); assert.equal(newRows(after, before, 'transactions').length, 1);
      assert.deepEqual(after.account_movements, before.account_movements); assert.deepEqual(after.inventory_movements, before.inventory_movements);
      await create('Alta posterior a eliminación', supplier);
      const later = await state(); assert.deepEqual(await remove(party.id, a, input), one); assert.deepEqual(await state(), later);
      await assert.rejects(remove(party.id, a, { ...input, reason: 'Otra intención de baja' }), { code: 'IDEMPOTENCY_CONFLICT' });
      await assert.rejects(remove(party.id, a, { ...input, operationId: id() }), { code: 'PARTY_NOT_FOUND' });
    }
  });

  await check('client deletion validates financial and metadata revisions and refuses debt or orders without effects', async () => {
    const debtor = await create('Cliente saldo protegido');
    await account(debtor, 'account.charge', 5);
    let before = await state();
    await assert.rejects(db.deleteClientRecord(debtor.id, a, deletion(debtor, false, { expectedAccountRevision: 1 })), { code: 'CLIENT_HAS_BALANCE' });
    assert.deepEqual(await state(), before);
    await account(debtor, 'account.payment', 5);
    before = await state();
    await assert.rejects(db.deleteClientRecord(debtor.id, a, deletion(debtor)), { code: 'ACCOUNT_REVISION_MISMATCH' });
    assert.deepEqual(await state(), before);
    const edited = await db.updateClientRecord(debtor.id, { operationId: id(), expectedRevision: 0, notas: 'Nota más reciente' }, a);
    before = await state();
    await assert.rejects(db.deleteClientRecord(debtor.id, a, deletion(debtor, false, { expectedAccountRevision: 2 })), { code: 'PARTY_REVISION_MISMATCH' });
    assert.deepEqual(await state(), before);
    const linked = await create('Cliente con pedido protegido'); await order(linked, null);
    before = await state();
    await assert.rejects(db.deleteClientRecord(linked.id, a, deletion(linked)), { code: 'CLIENT_HAS_ORDERS' });
    assert.deepEqual(await state(), before);
    assert.equal((await db.deleteClientRecord(debtor.id, a, deletion(edited))).items[0].deleted, true);
  });

  await check('supplier deletion freezes exact unlink order revisions and preserves procurement postings and stock', async () => {
    const client = await create('Cliente baja proveedor'), supplier = await create('Proveedor baja con pedidos', true);
    const product = await db.createProductRecord({ name: 'SKU baja proveedor', stockAvailable: 3 }, a, { operationId: id() });
    const pending = await order(client, supplier), achieved = await order(client, supplier, product, { estado: 'conseguido' });
    const input = deletion(supplier, true), before = await state();
    const receipt = await db.deleteProveedorRecord(supplier.id, a, input);
    const after = await state();
    assert.deepEqual(receipt.items[0].affectedOrders.slice().sort((x, y) => x.id.localeCompare(y.id)), [pending, achieved].map((pedido) => ({ id: pedido.id, revision: pedido.revision + 1, proveedorId: null })).sort((x, y) => x.id.localeCompare(y.id)));
    for (const prior of before.pedidos) {
      const actual = after.pedidos.find(({ id }) => id === prior.id);
      assert.deepEqual(actual, [pending.id, achieved.id].includes(prior.id) ? { ...prior, proveedor_id: null, revision: Number(prior.revision) + 1 } : prior);
    }
    assert.deepEqual(after.products, before.products); assert.deepEqual(after.inventory_movements, before.inventory_movements); assert.deepEqual(after.account_movements, before.account_movements);
    await db.updatePedidoRecord(pending.id, { operationId: id(), expectedRevision: pending.revision + 1, notas: 'Pedido modificado después de baja' }, a);
    const later = await state(); assert.deepEqual(await db.deleteProveedorRecord(supplier.id, a, input), receipt); assert.deepEqual(await state(), later);
  });

  await check('supplier merge concurrently stores one immutable receipt while replay returns a fresh keeper snapshot', async () => {
    const client = await create('Cliente fusión proveedor'), keep = await create('Proveedor conservar', true, a, 'Nota conservar'), source = await create('Proveedor quitar', true, a, 'Nota quitar');
    const product = await db.createProductRecord({ name: 'SKU fusión proveedor', stockAvailable: 4 }, a, { operationId: id() });
    const moved = await order(client, source, product, { estado: 'conseguido' }), retained = await order(client, keep);
    const input = mergeInput(keep, source), before = await state();
    const [one, two] = await Promise.all([db.mergeProveedorRecords(keep.id, source.id, a, input), db.mergeProveedorRecords(keep.id, source.id, a, input)]);
    assert.deepEqual(one.operationResult, two.operationResult);
    const item = one.operationResult.items[0];
    assert.equal(item.type, 'supplier.merge'); assert.equal(item.deleted, false); assert.deepEqual(item.removedParty, source);
    assert.equal(item.party.id, keep.id); assert.equal(item.party.metadataRevision, keep.metadataRevision + 1); assert.equal(item.party.notas, 'Nota conservar\nNota quitar');
    assert.deepEqual(item.affectedOrders, [{ id: moved.id, revision: moved.revision + 1, proveedorId: keep.id }]);
    const after = await state();
    assert.equal(after.proveedores.some(({ id }) => id === source.id), false);
    assert.equal(newRows(after, before, 'party_operations').length, 1); assert.equal(newRows(after, before, 'transactions').length, 1);
    for (const prior of before.pedidos) assert.deepEqual(after.pedidos.find(({ id }) => id === prior.id), prior.id === moved.id ? { ...prior, proveedor_id: keep.id, revision: Number(prior.revision) + 1 } : prior);
    assert.equal(after.pedidos.find(({ id }) => id === retained.id).revision, retained.revision);
    assert.deepEqual(after.products, before.products); assert.deepEqual(after.inventory_movements, before.inventory_movements); assert.deepEqual(after.account_movements, before.account_movements);
    const changed = await db.updateProveedorRecord(keep.id, { operationId: id(), expectedRevision: 1, notas: 'Nota actual del conservado' }, a);
    const later = await state(), replay = await db.mergeProveedorRecords(keep.id, source.id, a, input);
    assert.deepEqual(replay.operationResult, one.operationResult); assert.deepEqual(replay.proveedores.find(({ id }) => id === keep.id), changed); assert.deepEqual(await state(), later);
    await assert.rejects(db.mergeProveedorRecords(keep.id, source.id, a, { ...input, reason: 'Intención distinta' }), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await check('supplier merge metadata revisions and foreign source are guarded without changes', async () => {
    const keep = await create('Proveedor destino protegido', true), source = await create('Proveedor origen protegido', true), foreign = await create('Proveedor ajeno protegido', true, b);
    await db.updateProveedorRecord(keep.id, { operationId: id(), expectedRevision: 0, notas: 'Destino cambió' }, a);
    const before = await state();
    await assert.rejects(db.mergeProveedorRecords(keep.id, source.id, a, mergeInput(keep, source)), { code: 'PARTY_REVISION_MISMATCH' });
    await assert.rejects(db.mergeProveedorRecords(keep.id, foreign.id, a, mergeInput({ ...keep, metadataRevision: 1 }, foreign)), { code: 'PARTY_NOT_FOUND' });
    assert.deepEqual(await state(), before);
  });

  await check('party delete and merge inputs require IDs, reason, revisions and unique touched parties', async () => {
    const client = await create('Cliente baja validada'), keep = await create('Proveedor fusión validada conservar', true), source = await create('Proveedor fusión validada quitar', true), before = await state();
    await assert.rejects(db.deleteClientRecord(client.id, a), { code: 'OPERATION_ID_REQUIRED' });
    await assert.rejects(db.deleteProveedorRecord(source.id, a), { code: 'OPERATION_ID_REQUIRED' });
    await assert.rejects(db.mergeProveedorRecords(keep.id, source.id, a), { code: 'OPERATION_ID_REQUIRED' });
    for (const extra of [{ reason: '' }, { reason: undefined }, { expectedRevision: -1 }, { expectedAccountRevision: undefined }, { ownerPhone: b }]) await assert.rejects(db.deleteClientRecord(client.id, a, deletion(client, false, extra)), { code: 'INVALID_PARTY_OPERATION' });
    for (const extra of [{ reason: '' }, { expectedKeepRevision: undefined }, { expectedMergeRevision: -1 }, { debt: 0 }]) await assert.rejects(db.mergeProveedorRecords(keep.id, source.id, a, mergeInput(keep, source, extra)), { code: 'INVALID_PARTY_OPERATION' });
    await assert.rejects(run(plan([mergeAction(keep, source), deleteAction(keep, true, 'two')])), { code: 'INVALID_PARTY_OPERATION' });
    await assert.rejects(run(plan([deleteAction(client), deleteAction(client, false, 'two')])), { code: 'INVALID_PARTY_OPERATION' });
    assert.deepEqual(await state(), before);
  });

  await check('party delete and merge permission, scope and missing-party failures preserve all data', async () => {
    const client = await create('Cliente autorización baja'), keep = await create('Proveedor autorización conservar', true), source = await create('Proveedor autorización quitar', true), foreign = await create('Cliente ajeno baja', false, b);
    const p = plan([deleteAction(client)]), before = await state();
    await assert.rejects(run(p, {}), { code: 'BUSINESS_SCOPE_REQUIRED' });
    await assert.rejects(run(p, context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(p, context(a, ['clients:update'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([deleteAction(source, true)]), context(a, ['suppliers:merge'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([mergeAction(keep, source)]), context(a, ['suppliers:delete'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([deleteAction(foreign)])), { code: 'PARTY_NOT_FOUND' });
    assert.deepEqual(await state(), before);
    const receipt = await run(p), after = await state();
    await assert.rejects(run(p, context(a, [])), { code: 'FORBIDDEN' });
    assert.deepEqual(await state(), after); assert.deepEqual(await run(p), receipt);
  });

  for (const merge of [false, true]) {
    await check(`supplier ${merge ? 'merge' : 'delete'} receipt failure rolls back removed parties, keeper notes and order links`, async () => {
      const client = await create('Cliente rollback relaciones'), keep = await create('Proveedor rollback conservar', true), source = await create('Proveedor rollback quitar', true);
      await order(client, source);
      const before = await state(), input = merge ? mergeInput(keep, source) : deletion(source, true);
      await sql.query(`CREATE FUNCTION reject_party_relation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN RAISE EXCEPTION 'party relation receipt failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_party_relation_receipt BEFORE INSERT ON party_operations FOR EACH ROW EXECUTE FUNCTION reject_party_relation_receipt();`);
      const execute = () => merge ? db.mergeProveedorRecords(keep.id, source.id, a, input) : db.deleteProveedorRecord(source.id, a, input);
      try { await assert.rejects(execute(), /party relation receipt failure/); }
      finally { await sql.query('DROP TRIGGER reject_party_relation_receipt ON party_operations; DROP FUNCTION reject_party_relation_receipt()'); }
      assert.deepEqual(await state(), before);
      const result = await execute(); assert.deepEqual(merge ? (await execute()).operationResult : await execute(), merge ? result.operationResult : result);
    });
  }

  await check('client merge requires reviewed metadata revisions and rejects stale metadata without transfer or deletion', async () => {
    const keep = await create('Cliente merge conservar'), source = await create('Cliente merge origen');
    const input = { operationId: id(), expectedKeepRevision: 0, expectedMergeRevision: 0, expectedKeepMetadataRevision: 0, expectedMergeMetadataRevision: 0 };
    const beforeMissing = await state();
    await assert.rejects(db.mergeClientRecords(keep.id, source.id, a, { operationId: id(), expectedKeepRevision: 0, expectedMergeRevision: 0 }), { code: 'INVALID_ACCOUNT_OPERATION' });
    assert.deepEqual(await state(), beforeMissing);
    await db.updateClientRecord(source.id, { operationId: id(), expectedRevision: 0, notas: 'Origen editado después de revisión' }, a);
    const before = await state();
    await assert.rejects(db.mergeClientRecords(keep.id, source.id, a, input), { code: 'PARTY_REVISION_MISMATCH' });
    assert.deepEqual(await state(), before);
    const merged = await db.mergeClientRecords(keep.id, source.id, a, { ...input, operationId: id(), expectedMergeMetadataRevision: 1 });
    assert.equal(merged.operationResult.client.metadataRevision, 1);
  });

  await check('supplier order relinking rejects trigger changes to dates, quantities and stock postings with complete rollback', async () => {
    const effects = ["NEW.fecha_pedido := NEW.fecha_pedido + INTERVAL '1 day';", 'NEW.qty := NEW.qty + 1;', "NEW.stock_posting_json := NEW.stock_posting_json || '{\"quantity\":999}'::jsonb;"];
    for (const merge of [false, true]) {
      for (const effect of effects) {
        const client = await create('Cliente enlaces protegidos'), keep = await create('Proveedor enlaces conservar', true), source = await create('Proveedor enlaces origen', true);
        const product = await db.createProductRecord({ name: `SKU enlaces protegidos ${id()}`, stockAvailable: 3 }, a, { operationId: id() });
        const pedido = await order(client, source, product, { estado: 'conseguido' });
        const input = merge ? mergeInput(keep, source) : deletion(source, true), before = await state();
        await sql.query(`CREATE FUNCTION corrupt_party_linked_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${pedido.id}' THEN ${effect} END IF; RETURN NEW; END $$;
          CREATE TRIGGER corrupt_party_linked_order BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION corrupt_party_linked_order();`);
        const execute = () => merge ? db.mergeProveedorRecords(keep.id, source.id, a, input) : db.deleteProveedorRecord(source.id, a, input);
        try { await assert.rejects(execute(), { code: 'PERSISTED_EFFECT_MISMATCH' }); }
        finally { await sql.query('DROP TRIGGER corrupt_party_linked_order ON pedidos; DROP FUNCTION corrupt_party_linked_order()'); }
        assert.deepEqual(await state(), before);
        const result = await execute(), item = (merge ? result.operationResult : result).items[0];
        assert.deepEqual(item.affectedOrders, [{ id: pedido.id, revision: pedido.revision + 1, proveedorId: merge ? keep.id : null }]);
        const after = await state();
        assert.deepEqual(after.products, before.products); assert.deepEqual(after.inventory_movements, before.inventory_movements);
      }
    }
  });

  await check('client merge shared order verification and child party receipt failure roll back transfer, links and both writers', async () => {
    const keep = await create('Cliente child conservar', false, a, 'Nota conservar'), source = await create('Cliente child origen', false, a, 'Nota origen');
    await account(keep, 'account.charge', 7); await account(source, 'account.charge', 4);
    const product = await db.createProductRecord({ name: 'SKU client merge child rollback', stockAvailable: 3 }, a, { operationId: id() });
    const pedido = await order(source, null, product, { estado: 'conseguido' });
    const input = { operationId: id(), expectedKeepRevision: 1, expectedMergeRevision: 1, expectedKeepMetadataRevision: 0, expectedMergeMetadataRevision: 0 };
    const before = await state(), execute = () => db.mergeClientRecords(keep.id, source.id, a, input);
    await sql.query(`CREATE FUNCTION corrupt_client_merge_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${pedido.id}' THEN NEW.fecha_pedido := NEW.fecha_pedido + INTERVAL '1 day'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_client_merge_link BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION corrupt_client_merge_link();`);
    try { await assert.rejects(execute(), { code: 'PERSISTED_EFFECT_MISMATCH' }); }
    finally { await sql.query('DROP TRIGGER corrupt_client_merge_link ON pedidos; DROP FUNCTION corrupt_client_merge_link()'); }
    assert.deepEqual(await state(), before);
    await sql.query(`CREATE FUNCTION reject_client_merge_party_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' AND NEW.operation_id LIKE 'client-merge-party:%' THEN RAISE EXCEPTION 'client merge child party receipt failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_client_merge_party_receipt BEFORE INSERT ON party_operations FOR EACH ROW EXECUTE FUNCTION reject_client_merge_party_receipt();`);
    try { await assert.rejects(execute(), /client merge child party receipt failure/); }
    finally { await sql.query('DROP TRIGGER reject_client_merge_party_receipt ON party_operations; DROP FUNCTION reject_client_merge_party_receipt()'); }
    assert.deepEqual(await state(), before);
    const merged = await execute(), result = merged.operationResult, after = await state();
    assert.equal(result.client.debt, 11); assert.equal(result.client.accountRevision, 2); assert.equal(result.client.metadataRevision, 1);
    assert.equal(result.client.notas, 'Nota conservar\nNota origen'); assert.equal(after.clients.some(({ id }) => id === source.id), false);
    assert.deepEqual(result.affectedOrders, [{ id: pedido.id, revision: pedido.revision + 1, clienteId: keep.id }]);
    assert.ok(result.metadataResult.operationId.startsWith('client-merge-party:'));
    assert.deepEqual(result.metadataResult.items.map(({ itemId, type }) => [itemId, type]), [['keep', 'client.update'], ['source', 'client.delete']]);
    assert.deepEqual(result.metadataResult.items[0].party, result.client);
    const removed = result.metadataResult.items[1];
    assert.equal(removed.party.id, source.id); assert.equal(removed.party.debt, 0); assert.equal(removed.party.accountRevision, 2); assert.equal(removed.deleted, true); assert.deepEqual(removed.affectedOrders, []);
    for (const prior of before.pedidos) assert.deepEqual(after.pedidos.find(({ id }) => id === prior.id), prior.id === pedido.id ? { ...prior, cliente_id: keep.id, revision: Number(prior.revision) + 1 } : prior);
    assert.deepEqual(after.products, before.products); assert.deepEqual(after.inventory_movements, before.inventory_movements);
    assert.equal(newRows(after, before, 'party_operations').length, 1); assert.equal(newRows(after, before, 'account_operations').length, 2); assert.equal(newRows(after, before, 'transactions').length, 4);
    const movementDeltas = after.account_movements.filter(({ operation_id }) => operation_id === result.accountResult.operationId).map(({ delta }) => Number(delta)).sort((x, y) => x - y);
    assert.deepEqual(movementDeltas, [-4, 4]);
    assert.deepEqual((await execute()).operationResult, result); assert.deepEqual(await state(), after);
  });

  await check('stored legacy client merge receipt replays its original hash without new metadata revision fields', async () => {
    const operationId = id(), request = { kind: 'client.merge', keepId: 'legacy-merge-keeper-gone', mergeId: 'legacy-merge-source-gone', expectedKeepRevision: 0, expectedMergeRevision: 0 };
    const result = { contractVersion: 1, kind: 'client.merge', operationId: `client-merge:${operationId}`, businessId: a, status: 'applied', removedClientId: request.mergeId,
      client: { id: request.keepId, ownerPhone: a, name: 'Cliente Histórico', debt: 0, notas: null, accountRevision: 0 }, accountResult: null };
    await sql.query('INSERT INTO account_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [a, result.operationId, a, operationRequestDigest(request), JSON.stringify(request), JSON.stringify(result)]);
    const before = await state();
    assert.deepEqual((await db.mergeClientRecords(request.keepId, request.mergeId, a, { operationId, expectedKeepRevision: 0, expectedMergeRevision: 0 })).operationResult, result);
    assert.deepEqual(await state(), before);
    await assert.rejects(db.mergeClientRecords(request.keepId, request.mergeId, a, { operationId, expectedKeepRevision: 1, expectedMergeRevision: 0 }), { code: 'IDEMPOTENCY_CONFLICT' });
  });
}
