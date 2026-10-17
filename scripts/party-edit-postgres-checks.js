import assert from 'node:assert/strict';

export async function runPartyEditChecks({ db, sql, check }) {
  const a = '59899000941', b = '59899000942';
  let sequence = 0;
  const id = () => `party-edit-check-${++sequence}`;
  const context = (businessId = a, permissions = ['clients:create', 'suppliers:create', 'clients:update', 'suppliers:update']) => ({ businessId, actorId: 'party-edit-actor', permissions });
  const plan = (actions, operationId = id()) => ({ contractVersion: 1, businessId: a, operationId, actions });
  const update = (party, changes, type = 'client.update', itemId = 'one', expectedRevision = party.metadataRevision) => ({ itemId, type, target: { kind: 'existing', partyId: party.id, expectedRevision }, changes });
  const run = (p, ctx = context()) => db.executePartyOperation(p, ctx);
  const create = (name, owner = a, supplier = false) => (supplier ? db.createProveedorRecord : db.createClientRecord)({ operationId: id(), name, notas: 'Nota inicial' }, owner);
  const row = async (party, supplier = false) => (await sql.query(`SELECT * FROM ${supplier ? 'proveedores' : 'clients'} WHERE id=$1`, [party.id])).rows[0];
  const state = async () => {
    const result = {};
    for (const table of ['clients', 'proveedores', 'party_operations', 'transactions', 'inventory_movements', 'account_movements']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [a])).rows;
    return result;
  };

  await check('party edits concurrently replay once and preserve independent metadata/account revisions', async () => {
    for (const supplier of [false, true]) {
      const original = await create(`Alta edición ${supplier}`, a, supplier);
      assert.equal(original.metadataRevision, 0);
      const before = await state();
      const p = plan([update(original, { name: 'Nombre Editado', notas: 'Notas editadas' }, supplier ? 'supplier.update' : 'client.update')]);
      const [one, two] = await Promise.all([run(p), run(p)]);
      assert.deepEqual(one, two);
      const actual = await row(original, supplier), party = one.items[0].party;
      assert.equal(party.name, actual.name); assert.equal(party.notas, actual.notas);
      assert.equal(party.metadataRevision, 1); assert.equal(Number(actual.metadata_revision), 1);
      if (!supplier) { assert.equal(Number(actual.account_revision), 0); assert.equal(Number(actual.debt), 0); }
      const after = await state();
      assert.equal(after.party_operations.length, before.party_operations.length + 1);
      assert.equal(after.transactions.length, before.transactions.length + 1);
      assert.deepEqual(after.inventory_movements, before.inventory_movements); assert.deepEqual(after.account_movements, before.account_movements);
      assert.deepEqual(after.party_operations.find(({ operation_id }) => operation_id === p.operationId).result_json, one);
      const history = after.transactions.filter(({ id }) => !before.transactions.some((entry) => entry.id === id));
      assert.deepEqual(history.flatMap(({ actions_json }) => actions_json.map(({ type }) => type)), [p.actions[0].type]);
      await assert.rejects(run({ ...p, actions: [update(original, { name: 'Intención diferente' }, p.actions[0].type)] }), { code: 'IDEMPOTENCY_CONFLICT' });
      const noop = await run(plan([update(party, { name: party.name }, p.actions[0].type)]));
      assert.equal(noop.items[0].party.metadataRevision, 2);
      assert.deepEqual(await run(p), one);
    }
  });

  await check('different concurrent metadata edit IDs have one winner and one stale revision without duplicate history', async () => {
    const party = await create('Edición competencia');
    const before = await state();
    const outcomes = await Promise.allSettled([run(plan([update(party, { notas: 'Cambio A' })])), run(plan([update(party, { notas: 'Cambio B' })]))]);
    assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(({ status }) => status === 'rejected').reason.code, 'PARTY_REVISION_MISMATCH');
    const after = await state();
    assert.equal(Number((await row(party)).metadata_revision), 1);
    assert.equal(after.party_operations.length, before.party_operations.length + 1);
    assert.equal(after.transactions.length, before.transactions.length + 1);
  });

  await check('metadata edits and account payment concurrently preserve debt and independent revision counters', async () => {
    const party = await create('Cuenta edición concurrente');
    const account = (operationId, type, value) => ({ contractVersion: 1, businessId: a, operationId, actions: [{ itemId: 'money', type, target: { kind: 'existing', clientId: party.id }, amount: { value, unit: 'legacy-money' }, reason: 'Cuenta independiente de metadatos' }] });
    const accountContext = { businessId: a, actorId: a, permissions: ['accounts:charge', 'accounts:payment'] };
    await db.executeAccountOperation(account(id(), 'account.charge', 20), accountContext);
    assert.equal(Number((await row(party)).metadata_revision), 0);
    const payment = account(id(), 'account.payment', 7), p = plan([update(party, { notas: 'Nota sin cambio de saldo' })]);
    const [edited] = await Promise.all([run(p), db.executeAccountOperation(payment, accountContext)]);
    const actual = await row(party);
    assert.equal(Number(actual.debt), 13); assert.equal(Number(actual.account_revision), 2); assert.equal(Number(actual.metadata_revision), 1);
    const before = await state();
    assert.deepEqual(await run(p), edited); assert.deepEqual(await state(), before);
  });

  await check('party edits require closed explicit intent and reject repeated batch targets without effects', async () => {
    const party = await create('Validación edición'), supplier = await create('Validación proveedor edición', a, true);
    const before = await state();
    for (const [edit, target] of [[db.updateClientRecord, party], [db.updateProveedorRecord, supplier]]) {
      for (const operationId of [undefined, '', ' ', 1, 'x'.repeat(181)]) await assert.rejects(edit(target.id, { operationId, expectedRevision: 0, notas: 'Nota' }, a), { code: 'OPERATION_ID_REQUIRED' });
      for (const expectedRevision of [undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(edit(target.id, { operationId: id(), expectedRevision, notas: 'Nota' }, a), { code: 'INVALID_PARTY_OPERATION' });
      for (const changes of [{}, { ownerPhone: b }, { name: '' }, { name: 1 }, { notas: {} }, { id: 'forged' }]) await assert.rejects(edit(target.id, { operationId: id(), expectedRevision: 0, ...changes }, a), { code: 'INVALID_PARTY_OPERATION' });
    }
    await assert.rejects(db.updateClientRecord(party.id, { debt: 0 }, a), { code: 'ACCOUNT_OPERATION_REQUIRED' });
    await assert.rejects(run(plan([update(party, { notas: 'Primero' }), update(party, { notas: 'Segundo' }, 'client.update', 'two')])), { code: 'INVALID_PARTY_OPERATION' });
    assert.deepEqual(await state(), before);
  });

  await check('party edit scope and permissions precede replay and foreign parties remain isolated', async () => {
    const party = await create('Edición autorizada'), foreign = await create('Edición ajena', b), supplier = await create('Proveedor permiso edición', a, true);
    const p = plan([update(party, { notas: 'Edición propia' })]), receipt = await run(p), before = await state();
    await assert.rejects(run(p, {}), { code: 'BUSINESS_SCOPE_REQUIRED' });
    await assert.rejects(run(p, context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(p, context(a, ['clients:create'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([update(supplier, { notas: 'No autorizado' }, 'supplier.update')]), context(a, ['clients:update'])), { code: 'FORBIDDEN' });
    await assert.rejects(run(plan([update(foreign, { notas: 'Ajeno' })])), { code: 'PARTY_NOT_FOUND' });
    await assert.rejects(run(plan([update({ id: 'missing-party', metadataRevision: 0 }, { notas: 'Ausente' })])), { code: 'PARTY_NOT_FOUND' });
    assert.deepEqual(await state(), before); assert.deepEqual(await run(p), receipt);
    assert.equal((await row(foreign)).notas, 'Nota inicial');
  });

  await check('compatibility edits return frozen receipts after later edit and delete without resurrection', async () => {
    for (const supplier of [false, true]) {
      const party = await create('Edición recibo inmutable', a, supplier), edit = supplier ? db.updateProveedorRecord : db.updateClientRecord, remove = supplier ? db.deleteProveedorRecord : db.deleteClientRecord;
      const input = { operationId: id(), expectedRevision: 0, name: 'Recibo Editado', notas: null };
      const edited = await edit(party.id, input, a);
      assert.equal(edited.metadataRevision, 1); assert.equal(edited.notas, null);
      const later = await edit(party.id, { operationId: id(), expectedRevision: 1, notas: 'Nota posterior' }, a);
      assert.deepEqual(await edit(party.id, input, a), edited);
      await remove(party.id, a, { operationId: id(), expectedRevision: later.metadataRevision, ...(!supplier ? { expectedAccountRevision: later.accountRevision } : {}), reason: 'Baja posterior a edición' });
      const before = await state();
      assert.deepEqual(await edit(party.id, input, a), edited); assert.deepEqual(await state(), before);
      assert.equal(await row(party, supplier), undefined);
    }
  });

  await check('client merge invalidates metadata revisions captured before the merge', async () => {
    const keep = await create('Conservar revisión metadata'), source = await create('Origen revisión metadata');
    await db.mergeClientRecords(keep.id, source.id, a, { operationId: id(), expectedKeepRevision: 0, expectedMergeRevision: 0, expectedKeepMetadataRevision: keep.metadataRevision, expectedMergeMetadataRevision: source.metadataRevision });
    assert.equal(Number((await row(keep)).metadata_revision), 1);
    const before = await state();
    await assert.rejects(db.updateClientRecord(keep.id, { operationId: id(), expectedRevision: keep.metadataRevision, notas: 'Borrador anterior a merge' }, a), { code: 'PARTY_REVISION_MISMATCH' });
    assert.deepEqual(await state(), before);
  });

  await check('mixed party create and edit batch rolls back earlier actions when a later target is absent', async () => {
    const party = await create('Editar lote parcial'), before = await state();
    await assert.rejects(run(plan([{ itemId: 'new', type: 'supplier.create', name: 'Proveedor lote parcial' }, update(party, { notas: 'No persistir' }), update({ id: 'missing-party', metadataRevision: 0 }, { notas: 'Falla final' }, 'client.update', 'last')])), { code: 'PARTY_NOT_FOUND' });
    assert.deepEqual(await state(), before);
    const receipt = await run(plan([{ itemId: 'new', type: 'supplier.create', name: 'Proveedor lote válido' }, update(party, { notas: 'Persistencia conjunta' })]));
    assert.deepEqual(receipt.items.map(({ type }) => type), ['supplier.create', 'client.update']);
  });

  for (const failure of ['receipt', 'persisted-mismatch']) {
    await check(`party edit ${failure} SQL failure rolls back metadata revisions, batch creations and history`, async () => {
      const party = await create('Edición rollback SQL'), before = await state();
      const p = plan([{ itemId: 'new', type: 'supplier.create', name: 'Proveedor rollback edición' }, update(party, { notas: 'Nota prevista' })]);
      const table = failure === 'receipt' ? 'party_operations' : 'clients';
      const event = failure === 'receipt' ? 'INSERT' : 'UPDATE';
      const effect = failure === 'receipt' ? "RAISE EXCEPTION 'party edit receipt failure';" : "NEW.notas := 'Efecto divergente';";
      await sql.query(`CREATE FUNCTION reject_party_edit_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN ${effect} END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_party_edit_check BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_party_edit_check();`);
      try { await assert.rejects(run(p), failure === 'receipt' ? /party edit receipt failure/ : { code: 'PERSISTED_EFFECT_MISMATCH' }); }
      finally { await sql.query(`DROP TRIGGER reject_party_edit_check ON ${table}; DROP FUNCTION reject_party_edit_check()`); }
      assert.deepEqual(await state(), before);
      const result = await run(p); assert.equal(result.items[1].party.metadataRevision, 1); assert.deepEqual(await run(p), result);
    });
  }
}
