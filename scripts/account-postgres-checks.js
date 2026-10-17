import assert from 'node:assert/strict';
export async function runAccountChecks({ db, sql, check }) {
    const a = '59899000881', b = '59899000882';
    let sequence = 0;
    const id = () => `account-test-${++sequence}`;
    const context = (businessId = a) => ({ businessId, actorId: businessId, permissions: ['accounts:charge', 'accounts:payment', 'accounts:adjust', 'accounts:transfer'] });
    const action = (clientId, type = 'account.charge', value = 100, extra = {}) => ({ itemId: 'one', type, target: { kind: 'existing', clientId }, amount: { value, unit: 'legacy-money' }, reason: 'Movimiento verificado', ...extra });
    const plan = (actions, operationId = id(), businessId = a) => ({ contractVersion: 1, businessId, operationId, actions });
    const run = (p, ctx = context()) => db.executeAccountOperation(p, ctx);
    const row = async (clientId) => (await sql.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
    const client = await db.createClientRecord({ name: 'Cuenta exacta A' }, a), other = await db.createClientRecord({ name: 'Cuenta exacta B' }, a), foreign = await db.createClientRecord({ name: 'Cuenta ajena' }, b);
    await check('accounts concurrent replay applies once and receipt/history show exact final balances', async () => {
        const p = plan([action(client.id), action(client.id, 'account.payment', 30, { itemId: 'two' })]);
        const [one, two] = await Promise.all([run(p), run(p)]);
        assert.deepEqual(one, two);
        assert.equal(Number((await row(client.id)).debt), 70);
        assert.equal(Number((await row(client.id)).account_revision), 1);
        assert.deepEqual(one.items.map((i) => i.balance), [70, 70]);
        const moves = (await sql.query('SELECT delta FROM account_movements WHERE owner_phone=$1 AND operation_id=$2 ORDER BY item_id', [a, p.operationId])).rows;
        assert.deepEqual(moves.map((m) => Number(m.delta)), [100, -30]);
        await run(plan([action(client.id, 'account.charge', 10)]));
        assert.deepEqual(await run(p), one);
        assert.match(one.replyText, /saldo 70/);
        await assert.rejects(run({ ...p, actions: [action(client.id, 'account.charge', 101)] }), { code: 'IDEMPOTENCY_CONFLICT' });
    });
    await check('concurrent payments cannot overdraw or clip and absolute balances require current revision', async () => {
        const before = await row(client.id);
        const outcomes = await Promise.allSettled([run(plan([action(client.id, 'account.payment', 60)])), run(plan([action(client.id, 'account.payment', 60)]))]);
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find((r) => r.status === 'rejected').reason.code, 'PAYMENT_EXCEEDS_DEBT');
        assert.equal(Number((await row(client.id)).debt), 20);
        await assert.rejects(run(plan([action(client.id, 'account.adjust', 0, { target: { kind: 'existing', clientId: client.id, expectedRevision: Number(before.account_revision) } })])), { code: 'ACCOUNT_REVISION_MISMATCH' });
    });
    await check('account transfer conserves balances and client merges/deletions cannot discard debt', async () => {
        await assert.rejects(db.deleteClientRecord(client.id, a), { code: 'CLIENT_HAS_BALANCE' });
        await assert.rejects(db.mergeClientRecords(other.id, client.id, a), { code: 'OPERATION_ID_REQUIRED' });
        const source = await row(client.id), target = await row(other.id);
        const transfer = plan([action(client.id, 'account.transfer', 10, { target: { kind: 'existing', clientId: client.id, expectedRevision: Number(source.account_revision) }, destination: { clientId: other.id, expectedRevision: Number(target.account_revision) } })]);
        const receipt = await run(transfer);
        assert.equal(receipt.items[0].balance, 10);
        assert.equal(receipt.items[0].destinationBalance, 10);
        const mergeInput={operationId:id(),expectedKeepRevision:Number(target.account_revision)+1,expectedMergeRevision:Number(source.account_revision)+1};
        const merged=await db.mergeClientRecords(other.id, client.id, a,mergeInput);
        assert.equal(merged.operationResult.client.debt,20);
        assert.equal(merged.operationResult.accountResult.items[0].amount,10);
        assert.equal(await row(client.id), undefined);
        assert.equal(Number((await row(other.id)).debt), 20);
        assert.deepEqual(await run(transfer), receipt);
        assert.deepEqual((await db.mergeClientRecords(other.id,client.id,a,mergeInput)).operationResult,merged.operationResult);
    });
    await check('account scopes, permissions, explicit amount and metadata changes preserve balances', async () => {
        const foreignPlan = plan([action(foreign.id)]);
        await assert.rejects(run(foreignPlan), { code: 'CLIENT_NOT_FOUND' });
        await assert.rejects(run(plan([action(other.id)]), { ...context(), permissions: [] }), { code: 'FORBIDDEN' });
        await assert.rejects(db.createClientRecord({ name: 'Bad initial debt', debt: 1 }, a), { code: 'ACCOUNT_OPERATION_REQUIRED' });
        await assert.rejects(db.updateClientRecord(other.id, { debt: 0 }, a), { code: 'ACCOUNT_OPERATION_REQUIRED' });
        const updated = await db.updateClientRecord(other.id, { notas: 'Metadato sin saldo' }, a);
        assert.equal(updated.debt, 20);
        await db.createProductRecord({ name: 'Account catalog name', price: 900 }, a, { operationId: id() });
        const opts = { operationId: id(), channel: 'panel' };
        const applied = await db.applyActionsToDatabase([{ type: 'add_debt', clientId: other.id, clientName: 'ignored explicit id', productName: 'Account catalog name', qty: 5, amount: 7 }], 'Cargo de importe explícito', a, opts);
        assert.equal(applied.operationResult.items[0].amount, 7);
        assert.equal(applied.operationResult.items[0].balance, 27);
        assert.deepEqual((await db.applyActionsToDatabase([{ type: 'add_debt', clientId: other.id, clientName: 'ignored explicit id', productName: 'Account catalog name', qty: 5, amount: 7 }], 'Cargo de importe explícito', a, opts)).operationResult, applied.operationResult);
        await assert.rejects(db.applyActionsToDatabase([{ type: 'payment_received', clientName: 'Nobody', amount: 1 }], 'Unknown', a, { operationId: id() }), { code: 'CLIENT_SELECTION_REQUIRED' });
        await db.createClientRecord({ name: 'Duplicate debt name' }, a);
        await db.createClientRecord({ name: 'Duplicate debt name' }, a);
        await assert.rejects(db.applyActionsToDatabase([{ type: 'add_debt', clientName: 'Duplicate debt name', amount: 1 }], 'Ambiguous', a, { operationId: id() }), { code: 'CLIENT_SELECTION_REQUIRED' });
    });
    await check('account movement SQL failure rolls back balances, revisions and receipts before retry', async () => {
        const before = await row(other.id), p = plan([action(other.id, 'account.charge', 2)]);
        await sql.query(`CREATE FUNCTION reject_account_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.client_id='${other.id}' THEN RAISE EXCEPTION 'account movement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_account_movement BEFORE INSERT ON account_movements FOR EACH ROW EXECUTE FUNCTION reject_account_movement();`);
        try {
            await assert.rejects(run(p), /account movement failure/);
        }
        finally {
            await sql.query('DROP TRIGGER reject_account_movement ON account_movements; DROP FUNCTION reject_account_movement()');
        }
        assert.deepEqual(await row(other.id), before);
        assert.equal((await sql.query('SELECT 1 FROM account_operations WHERE owner_phone=$1 AND operation_id=$2', [a, p.operationId])).rowCount, 0);
        assert.equal((await run(p)).items[0].balance, Number(before.debt) + 2);
    });
    await check('account outbox and whole multi-client batch rollback together', async () => {
        const before = await row(other.id), opts = { operationId: id(), messageId: id(), recipient: a, channel: 'whatsapp' };
        await sql.query(`CREATE FUNCTION reject_account_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${opts.messageId}' THEN RAISE EXCEPTION 'account outbox failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_account_outbox BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION reject_account_outbox();`);
        const actions = [{ type: 'add_debt', clientName: 'Cuenta exacta B', amount: 2 }];
        try {
            await assert.rejects(db.applyActionsToDatabase(actions, 'Atomic account outbox', a, opts), /account outbox failure/);
        }
        finally {
            await sql.query('DROP TRIGGER reject_account_outbox ON meta_reply_outbox; DROP FUNCTION reject_account_outbox()');
        }
        assert.deepEqual(await row(other.id), before);
        const applied = await db.applyActionsToDatabase(actions, 'Atomic account outbox', a, opts);
        assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [opts.messageId])).rows[0].reply_text, applied.replyText);
        const actual = await row(other.id), p = plan([action(other.id, 'account.charge', 2), action(foreign.id, 'account.payment', 1, { itemId: 'two' })]);
        await assert.rejects(run(p), { code: 'CLIENT_NOT_FOUND' });
        assert.deepEqual(await row(other.id), actual);
    });
    await check('client merge failure rolls back transfer/orders/delete and concurrent retry stores one immutable receipt',async()=>{
        const keep=await db.createClientRecord({name:'Merge rollback keeper'},a),source=await db.createClientRecord({name:'Merge rollback source'},a);
        await run(plan([action(keep.id,'account.charge',7),action(source.id,'account.charge',5,{itemId:'two'})]));
        const pedido=await db.createPedidoRecord({operationId:id(),clienteId:source.id,producto:'Merge pending order'},a);
        const before=[await row(keep.id),await row(source.id)],input={operationId:id(),expectedKeepRevision:1,expectedMergeRevision:1};
        await sql.query(`CREATE FUNCTION reject_client_merge_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${source.id}' THEN RAISE EXCEPTION 'merge delete failure'; END IF; RETURN OLD; END $$;
          CREATE TRIGGER reject_client_merge_delete BEFORE DELETE ON clients FOR EACH ROW EXECUTE FUNCTION reject_client_merge_delete();`);
        try{await assert.rejects(db.mergeClientRecords(keep.id,source.id,a,input),/merge delete failure/);}finally{await sql.query('DROP TRIGGER reject_client_merge_delete ON clients; DROP FUNCTION reject_client_merge_delete()');}
        assert.deepEqual([await row(keep.id),await row(source.id)],before);
        assert.equal((await db.getStateSnapshotStrict(a)).pedidos.find((p)=>p.id===pedido.id).clienteId,source.id);
        assert.equal((await sql.query('SELECT 1 FROM account_operations WHERE owner_phone=$1 AND operation_id=$2',[a,`client-merge:${input.operationId}`])).rowCount,0);
        const [first,replay]=await Promise.all([db.mergeClientRecords(keep.id,source.id,a,input),db.mergeClientRecords(keep.id,source.id,a,input)]);
        assert.deepEqual(first.operationResult,replay.operationResult);assert.equal(first.operationResult.client.debt,12);
        const moved=(await db.getStateSnapshotStrict(a)).pedidos.find((p)=>p.id===pedido.id);assert.equal(moved.clienteId,keep.id);assert.equal(moved.revision,1);
        await run(plan([action(keep.id,'account.charge',2)]));
        assert.equal((await db.mergeClientRecords(keep.id,source.id,a,input)).operationResult.client.debt,12);
        assert.equal(Number((await row(keep.id)).debt),14);
    });
}
