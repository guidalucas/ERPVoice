import assert from 'node:assert/strict';

export async function runUniversalMetaChecks({ db, sql, check }) {
  const owner = '59899000971', other = '59899000972', actor = '59899000973';
  let sequence = 0;
  const id = () => `universal-meta-check-${++sequence}`;
  const context = { businessId: owner, actorId: owner, channel: 'meta', permissions: ['inventory:receive', 'inventory:sell', 'accounts:charge', 'accounts:payment'] };
  const input = (sourceText, scope = {}) => ({ ownerPhone: owner, senderPhone: owner, messageId: id(), sourceText, ...scope });
  const forbidden = async () => assert.fail('replayed, malformed or stale commands must not call the provider');
  const process = (request, complete = forbidden) => db.processMetaUniversalMessage(request, { complete });
  const code = (preview) => preview.digest.slice(0, 8);
  const command = (verb, preview, suffix = '', scope = {}) => input(`${verb} OPERACION ${code(preview)}${suffix}`, scope);
  const text = 'Ingresaron tres unidades y cargá siete a la cuenta.';
  const seed = async () => ({
    product: await db.createProductRecord({ name: `Meta SKU ${id()}`, stockAvailable: 2, unit: 'unit', price: 99 }, owner, { operationId: id() }),
    client: await db.createClientRecord({ name: `Meta cliente ${id()}`, operationId: id() }, owner),
  });
  const actions = ({ product, client }) => [
    { itemId: 'stock', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 3, unit: 'unit' } },
    { itemId: 'money', type: 'account.charge', target: { kind: 'existing', clientId: client.id }, amount: { value: 7, unit: 'legacy-money' }, reason: 'Cargo explícito revisado' },
  ];
  const proposal = (items, quote = text) => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions: items, evidence: items.map(({ itemId }) => ({ itemId, quote })) } });
  const provider = (response) => {
    const fake = { calls: 0, complete: async () => { fake.calls++; return response; } };
    return fake;
  };
  const prepare = (fixture, request = input(`REVISAR OPERACION ${text}`)) => process(request, provider(proposal(actions(fixture))).complete);
  const state = async (withCommands = false) => {
    const result = {};
    for (const table of ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'inventory_operations', 'account_operations', 'party_operations', 'order_operations', 'inventory_movements', 'account_movements', 'transactions', ...(withCommands ? ['universal_drafts', 'universal_draft_commands', 'universal_meta_commands'] : [])]) {
      result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
    }
    if (withCommands) result.outbox = (await sql.query("SELECT * FROM meta_reply_outbox WHERE event_id LIKE 'universal-meta-check-%' ORDER BY event_id")).rows;
    return result;
  };
  const persisted = async (request, result) => {
    assert.deepEqual((await sql.query('SELECT result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2', [request.ownerPhone, request.messageId])).rows[0]?.result_json, result);
    const rows = (await sql.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1', [request.messageId])).rows;
    assert.deepEqual(rows, [{ recipient: request.senderPhone, reply_text: result.replyText }]);
  };
  const rejection = async (request, errorCode) => {
    const before = await state(), result = await process(request);
    assert.equal(result.handled, true); assert.equal(result.intent, 'mixed'); assert.equal(result.errorCode, errorCode);
    assert.match(result.replyText,/porque/);assert.match(result.replyText,/Probá: /);
    assert.deepEqual(result.actions, []); assert.equal(result.requiresConfirmation, false);
    assert.deepEqual(await state(), before); await persisted(request, result);
    assert.deepEqual(await process(request), result);
    return result;
  };

  await check('universal meta: new-client order resolves a bare size reply, reviews both actions and confirms them once',async()=>{
    const ordinary=(request,complete=forbidden)=>db.processMetaUniversalMessage(request,{ordinary:true,complete});
    const original='Me pidieron la camiseta blanca de boca, tercera equipación. Me lo pidió Emiliano.';
    const questions=['¿A qué cliente corresponde Emiliano y qué talle tiene la camiseta blanca de boca?','¿Qué talle es la camiseta, L o XL?'];
    const clarify=question=>provider({ok:true,json:{contractVersion:1,kind:'clarification',question}}).complete;
    const before=await state();
    const first=await ordinary(input(original),clarify(questions[0]));
    const second=await ordinary(input('nuevo cliente. la camseta talle L o XL'),clarify(questions[1]));
    assert.equal(second.draftId,first.draftId);assert.equal(second.version,2);
    const items=[{itemId:'new-client',type:'client.create',name:'Emiliano'},
      {itemId:'new-order',type:'order.create',clientRef:{itemId:'new-client'},order:{producto:'Camiseta blanca de Boca, tercera equipación',talle:'L',qty:1}}];
    const reply=input('L');
    const ready=await ordinary(reply,async options=>{
      const supplied=JSON.parse(options.messages[1].content);
      assert.deepEqual(supplied.latestClarification,{question:questions[1],answer:'L'});
      assert.equal(supplied.sourceText,`${original}\nnuevo cliente. la camseta talle L o XL\nL`);
      return {ok:true,json:{contractVersion:1,kind:'proposal',actions:items,evidence:[{itemId:'new-client',quote:'nuevo cliente'},{itemId:'new-order',quote:original}]}};
    });
    assert.equal(ready.status,'awaiting_confirmation');assert.equal(ready.version,3);assert.equal(ready.draftId,first.draftId);
    assert.match(ready.replyText,/Alta de cliente.*Emiliano/);assert.match(ready.replyText,/Cliente nuevo: Emiliano/);
    assert.match(ready.replyText,/Variante: L/);assert.deepEqual(await state(),before);
    await persisted(reply,ready);assert.deepEqual(await ordinary(reply),ready);
    const confirmation=input('confirmar'),applied=await ordinary(confirmation);
    assert.equal(applied.status,'applied');assert.match(applied.replyText,/Cliente creado: Emiliano/);assert.match(applied.replyText,/Pedido creado/);
    const after=await state(),customer=after.clients.find(row=>!before.clients.some(old=>old.id===row.id));
    const order=after.pedidos.find(row=>!before.pedidos.some(old=>old.id===row.id));
    assert.equal(after.clients.length,before.clients.length+1);assert.equal(after.pedidos.length,before.pedidos.length+1);
    assert.equal(order.cliente_id,customer.id);assert.equal(order.talle,'L');assert.equal(order.estado,'pendiente');
    assert.equal(after.inventory_movements.length,before.inventory_movements.length);
    await persisted(confirmation,applied);assert.deepEqual(await ordinary(confirmation),applied);assert.deepEqual(await state(),after);
    assert.equal((await ordinary(input('confirmar'))).errorCode,'DRAFT_NOT_FOUND');assert.deepEqual(await state(),after);
  });

  await check('universal meta: explicit review persists shared draft and outbox without domain effects', async () => {
    const fixture = await seed(), request = input(`REVISAR OPERACION ${text}`), fake = provider(proposal(actions(fixture))), before = await state();
    const preview = await process(request, fake.complete);
    assert.equal(fake.calls, 1); assert.equal(preview.handled, true); assert.equal(preview.intent, 'mixed');
    assert.equal(preview.status, 'awaiting_confirmation'); assert.equal(preview.requiresConfirmation, true); assert.equal(preview.version, 1);
    assert.deepEqual(preview.actions, []); assert.match(preview.replyText, /Respondé «confirmar» para aplicar/);
    assert.deepEqual(await state(), before); await persisted(request, preview);
    const shared = await db.getUniversalDraft(preview.draftId, context);
    assert.equal(shared.digest, preview.digest); assert.equal(shared.plan.operationId, `draft-operation:${preview.draftId}`);
    const after = await state(true); assert.deepEqual(await process(request), preview); assert.deepEqual(await state(true), after);
  });

  await check('universal meta: current code is scoped by tenant and actor', async () => {
    const preview = await prepare(await seed());
    await rejection(command('CONFIRMAR', preview, '', { ownerPhone: other, senderPhone: other }), 'DRAFT_NOT_FOUND');
    await rejection(command('CONFIRMAR', preview, '', { senderPhone: actor }), 'DRAFT_NOT_FOUND');
    assert.equal((await process(command('CONFIRMAR', preview))).status, 'applied');
  });

  await check('universal meta: patch advances shared version, invalidates old code and rejects stale catalog revisions', async () => {
    const fixture = await seed(), preview = await prepare(fixture), before = await state();
    const request = command('RESPONDER', preview, ' Ahora son cuatro.'), fake = provider({ ok: true, json: { contractVersion: 1, kind: 'patch', patches: [{ itemId: 'stock', changes: { quantity: { value: 4 } } }], evidence: [{ itemId: 'stock', quote: 'cuatro' }] } });
    const corrected = await process(request, fake.complete);
    assert.equal(corrected.version, 2); assert.notEqual(corrected.digest, preview.digest); assert.equal(fake.calls, 1);
    assert.deepEqual(await state(), before); await persisted(request, corrected);
    const shared = await db.getUniversalDraft(preview.draftId, context);
    assert.equal(shared.plan.actions[0].quantity.value, 4); assert.equal(shared.plan.actions[1].amount.value, 7);
    await rejection(command('CONFIRMAR', preview), 'DRAFT_NOT_FOUND');
    await rejection(command('RESPONDER', preview, ' cinco'), 'DRAFT_NOT_FOUND');
    await db.executeInventoryOperation({ contractVersion: 1, businessId: owner, operationId: id(), actions: [{ itemId: 'restock', type: 'stock.receive', target: { kind: 'existing', skuId: fixture.product.id }, quantity: { value: 1, unit: 'unit' } }] }, context);
    await rejection(command('CONFIRMAR', corrected), 'REVISION_MISMATCH');
    assert.deepEqual(await process(request), corrected);
  });

  await check('universal meta: clarification reply prepares a version without executing effects', async () => {
    const fixture = await seed(), request = input('REVISAR OPERACION Recibí mercadería.'), before = await state();
    const preview = await process(request, provider({ ok: true, json: { contractVersion: 1, kind: 'clarification', question: '¿Cuántas unidades ingresaron?' } }).complete);
    assert.equal(preview.status, 'awaiting_clarification'); assert.equal(preview.requiresConfirmation, true);
    const reply = command('RESPONDER', preview, ` ${text}`), fake = provider(proposal(actions(fixture)));
    const ready = await process(reply, fake.complete); assert.equal(fake.calls, 1); assert.equal(ready.status, 'awaiting_confirmation'); assert.equal(ready.version, 2);
    assert.deepEqual(await state(), before); await persisted(reply, ready);
    assert.deepEqual(await process(request), preview); assert.deepEqual(await process(reply), ready);
  });

  await check('universal meta: invalid size reply preserves its diagnostic and draft for a corrected retry', async () => {
    const fixture=await seed(),original='Ingresaron tres unidades de la camiseta.';
    const preview=await process(input(`REVISAR OPERACION ${original}`),provider({ok:true,json:{contractVersion:1,kind:'clarification',question:'¿De qué talle son las camisetas?'}}).complete);
    const draft=await db.getUniversalDraft(preview.draftId,context),before=await state();
    const item={...actions(fixture)[0],itemId:'shirt'};
    const invalid=command('RESPONDER',preview,' Talle L');
    const rejected=await process(invalid,provider(proposal([item],'Ingresaron tres unidades de la camiseta talle L.')).complete);
    assert.equal(rejected.errorCode,'INTERPRETATION_INVALID');assert.equal(rejected.interpretationReason,'INVALID_EVIDENCE');
    assert.match(rejected.replyText,/Ejemplo de formato/);assert.match(rejected.replyText,/borrador anterior sigue pendiente/);
    assert.deepEqual(rejected.actions,[]);assert.equal(rejected.requiresConfirmation,false);
    assert.deepEqual(await db.getUniversalDraft(preview.draftId,context),draft);assert.deepEqual(await state(),before);
    await persisted(invalid,rejected);assert.deepEqual(await process(invalid),rejected);
    const retry=command('RESPONDER',preview,' Talle L');
    const ready=await process(retry,async options=>{
      const supplied=JSON.parse(options.messages[1].content);
      assert.equal(supplied.sourceText,`${original}\nTalle L`);
      assert.deepEqual(supplied.clarifications,[{question:'¿De qué talle son las camisetas?',answer:'Talle L'}]);
      assert.deepEqual(supplied.latestClarification,supplied.clarifications.at(-1));
      return proposal([item],original);
    });
    assert.equal(ready.status,'awaiting_confirmation');assert.equal(ready.version,2);
    assert.equal(ready.draftId,preview.draftId);assert.equal(ready.interpretationReason,undefined);
    assert.deepEqual(await state(),before);await persisted(retry,ready);
  });

  await check('universal meta: direct size replies, corrections and confirmation share the latest conversation without codes',async()=>{
    const fixture=await seed(),original='Ingresaron tres unidades de la camiseta.',before=await state();
    const ordinary=(request,complete=forbidden)=>db.processMetaUniversalMessage(request,{ordinary:true,complete});
    const pending=await process(input(`REVISAR OPERACION ${original}`),provider({ok:true,json:{contractVersion:1,kind:'clarification',question:'¿De qué talle son las camisetas?'}}).complete);
    assert.match(pending.replyText,/Respondé directamente en este chat/);assert.doesNotMatch(pending.replyText,/OPERACION|<corrección>/);
    const item={...actions(fixture)[0],itemId:'shirt'};
    const reply=input('Talle L');
    const ready=await ordinary(reply,async options=>{
      const supplied=JSON.parse(options.messages[1].content);
      assert.equal(supplied.sourceText,`${original}\nTalle L`);
      assert.deepEqual(supplied.clarifications,[{question:'¿De qué talle son las camisetas?',answer:'Talle L'}]);
      return proposal([item],original);
    });
    assert.equal(ready.draftId,pending.draftId);assert.equal(ready.version,2);assert.equal(ready.status,'awaiting_confirmation');
    assert.deepEqual(await ordinary(reply),ready);
    const corrected=await ordinary(input('Son cuatro.'),provider({ok:true,json:{contractVersion:1,kind:'patch',patches:[{itemId:'shirt',changes:{quantity:{value:4}}}],evidence:[{itemId:'shirt',quote:'Son cuatro.'}]}}).complete);
    assert.equal(corrected.draftId,pending.draftId);assert.equal(corrected.version,3);assert.deepEqual(await state(),before);
    const confirm=input('Confirmar'),applied=await ordinary(confirm);
    assert.equal(applied.status,'applied');assert.equal(applied.draftId,pending.draftId);
    assert.equal(Number((await state()).products.find(row=>row.id===fixture.product.id).stock_available),6);
    const after=await state();assert.deepEqual(await ordinary(confirm),applied);assert.deepEqual(await state(),after);
    // Older pending drafts from earlier checks must never become active again.
    const repeated=await ordinary(input('confirmar'));
    assert.equal(repeated.errorCode,'DRAFT_NOT_FOUND');assert.deepEqual(await state(),after);
    await persisted(confirm,applied);
  });

  await check('universal meta: short controls stay scoped, reject missing data, expiry and cancel without a provider',async()=>{
    const ordinary=(request,complete=forbidden)=>db.processMetaUniversalMessage(request,{ordinary:true,complete});
    const preview=await process(input('REVISAR OPERACION Cargá las camisetas.'),provider({ok:true,json:{contractVersion:1,kind:'clarification',question:'¿Qué talle?'}}).complete);
    const before=await state();
    assert.equal((await ordinary(input('confirmar',{senderPhone:actor}))).errorCode,'DRAFT_NOT_FOUND');
    assert.equal((await ordinary(input('cancelar',{ownerPhone:other,senderPhone:other}))).errorCode,'DRAFT_NOT_FOUND');
    assert.equal((await ordinary(input('confirmar'))).errorCode,'DRAFT_NOT_READY');
    const cancel=input('cancelar'),cancelled=await ordinary(cancel);
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.draftId,preview.draftId);assert.deepEqual(await state(),before);
    assert.deepEqual(await ordinary(cancel),cancelled);
    const fixture=await seed(),pending=await prepare(fixture);
    await sql.query("UPDATE universal_drafts SET expires_at=NOW()-INTERVAL '1 second' WHERE owner_phone=$1 AND draft_id=$2",[owner,pending.draftId]);
    assert.equal((await ordinary(input('confirmar'))).errorCode,'DRAFT_NOT_FOUND');
    assert.equal((await db.getUniversalDraft(pending.draftId,context)).status,'awaiting_confirmation');
  });

  await check('universal meta: explicit new reviews start a fresh conversation while another draft is pending',async()=>{
    const first=await process(input('REVISAR OPERACION Cargá las camisetas.'),provider({ok:true,json:{contractVersion:1,kind:'clarification',question:'¿Qué talle?'}}).complete);
    const fixture=await seed(),request=input(`REVISAR OPERACION ${text}`);
    const second=await db.processMetaUniversalMessage(request,{ordinary:true,complete:async options=>{
      const supplied=JSON.parse(options.messages[1].content);
      assert.equal(supplied.sourceText,text);assert.deepEqual(supplied.clarifications,[]);
      return proposal(actions(fixture));
    }});
    assert.notEqual(second.draftId,first.draftId);assert.equal(second.version,1);
    assert.equal((await db.getUniversalDraft(first.draftId,context)).status,'awaiting_clarification');
  });

  await check('universal meta: concurrent identical and distinct confirmation messages apply all effects once', async () => {
    const fixture = await seed(), preview = await prepare(fixture), before = await state(), first = command('CONFIRMAR', preview), second = command('CONFIRMAR', preview);
    const results = await Promise.all([process(first), process(first), process(second)]);
    for (const result of results) { assert.equal(result.status, 'applied'); assert.equal(result.requiresConfirmation, false); assert.ok(result.actions.length > 0); assert.equal(result.operationResult.domain, 'mixed'); assert.deepEqual(result, results[0]); }
    const after = await state();
    assert.equal(Number(after.products.find(({ id }) => id === fixture.product.id).stock_available), 5);
    assert.equal(Number(after.clients.find(({ id }) => id === fixture.client.id).debt), 7);
    for (const table of ['universal_operations', 'inventory_movements', 'account_movements']) assert.equal(after[table].length, before[table].length + 1);
    assert.equal(after.transactions.length, before.transactions.length + 2);
    await persisted(first, results[0]); await persisted(second, results[0]);
  });

  await check('universal meta: frozen prepare and receipt replay survive removed catalog without provider calls', async () => {
    const fixture = await seed(), request = input(`REVISAR OPERACION ${text}`), preview = await prepare(fixture, request), confirmRequest = command('CONFIRMAR', preview), applied = await process(confirmRequest);
    await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=$2', [owner, fixture.product.id]);
    await sql.query('DELETE FROM clients WHERE owner_phone=$1 AND id=$2', [owner, fixture.client.id]);
    const before = await state(true);
    assert.deepEqual(await process(request), preview); assert.deepEqual(await process(confirmRequest), applied); assert.deepEqual(await state(true), before);
  });

  await check('universal meta: command SQL failure rolls back new draft and exact retry succeeds', async () => {
    const fixture = await seed(), request = input(`REVISAR OPERACION ${text}`), before = await state(true);
    await sql.query(`CREATE FUNCTION universal_meta_check_command_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.message_id='${request.messageId}' THEN RAISE EXCEPTION 'meta command persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_meta_check_command_failure BEFORE INSERT ON universal_meta_commands FOR EACH ROW EXECUTE FUNCTION universal_meta_check_command_failure()`);
    try { await assert.rejects(prepare(fixture, request), /meta command persistence failure/); }
    finally { await sql.query('DROP TRIGGER universal_meta_check_command_failure ON universal_meta_commands; DROP FUNCTION universal_meta_check_command_failure()'); }
    assert.deepEqual(await state(true), before);
    const preview = await prepare(fixture, request); assert.equal(preview.status, 'awaiting_confirmation'); await persisted(request, preview);
  });

  await check('universal meta: outbox SQL failure rolls back applied draft, domain effects and command', async () => {
    const fixture = await seed(), preview = await prepare(fixture), request = command('CONFIRMAR', preview), before = await state(true);
    await sql.query(`CREATE FUNCTION universal_meta_check_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${request.messageId}' THEN RAISE EXCEPTION 'meta outbox persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_meta_check_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION universal_meta_check_outbox_failure()`);
    try { await assert.rejects(process(request), /meta outbox persistence failure/); }
    finally { await sql.query('DROP TRIGGER universal_meta_check_outbox_failure ON meta_reply_outbox; DROP FUNCTION universal_meta_check_outbox_failure()'); }
    assert.deepEqual(await state(true), before);
    const applied = await process(request); assert.equal(applied.status, 'applied'); await persisted(request, applied);
    const after = await state(true); assert.deepEqual(await process(request), applied); assert.deepEqual(await state(true), after);
  });

  await check('universal meta: insufficient stock rejection is immutable after restock and preserves mixed atomicity', async () => {
    const fixture = await seed(), items = actions(fixture); items[0] = { ...items[0], type: 'stock.sell', quantity: { value: 2, unit: 'unit' } };
    const saleText = 'Vendí dos unidades y cargá siete a la cuenta.', preview = await process(input(`REVISAR OPERACION ${saleText}`), provider(proposal(items, saleText)).complete);
    assert.equal(preview.status, 'awaiting_confirmation');
    // Simulate insufficient available stock without changing the reviewed revision,
    // so this exercises the stock guard rather than the independent revision guard.
    await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [owner, fixture.product.id]);
    const request = command('CONFIRMAR', preview), rejected = await rejection(request, 'INSUFFICIENT_STOCK');
    assert.equal((await db.getUniversalDraft(preview.draftId, context)).status, 'awaiting_confirmation');
    await sql.query('UPDATE products SET stock_available=2 WHERE owner_phone=$1 AND id=$2', [owner, fixture.product.id]);
    const after = await state(true); assert.deepEqual(await process(request), rejected); assert.deepEqual(await state(true), after);
    assert.equal((await process(command('CONFIRMAR', preview))).status, 'applied');
  });

  await check('universal meta: expiry, cancellation and malformed namespace stay effect free with persisted rejections', async () => {
    const preview = await prepare(await seed());
    await sql.query("UPDATE universal_drafts SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND draft_id=$2", [owner, preview.draftId]);
    await rejection(command('CONFIRMAR', preview), 'DRAFT_EXPIRED');
    const cancelRequest = command('CANCELAR', preview), cancelled = await process(cancelRequest);
    assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.actions, []); assert.equal(cancelled.requiresConfirmation, false); await persisted(cancelRequest, cancelled);
    await rejection(command('CONFIRMAR', preview), 'DRAFT_NOT_PENDING');
    const before = await state(true); assert.equal(await process(input('Ingresaron tres unidades.')), null); assert.deepEqual(await state(true), before);
    for (const malformed of ['REVISAR OPERACION', 'RESPONDER OPERACION abcd nope', 'CONFIRMAR OPERACION deadbeef extra', 'CANCELAR OPERACION']) await rejection(input(malformed), 'INVALID_DRAFT_REQUEST');
    assert.deepEqual(await process(cancelRequest), cancelled);
  });

  await check('universal meta: public withdrawal proposal is rejected without effects even with sufficient reviewed stock', async () => {
    const fixture = await seed();
    const receiveText = 'Ingresaron tres unidades.', receive = await process(input(`REVISAR OPERACION ${receiveText}`), provider(proposal([actions(fixture)[0]], receiveText)).complete);
    assert.equal(receive.status, 'awaiting_confirmation');
    assert.equal((await process(command('CONFIRMAR', receive))).status, 'applied');
    const before = await state(true), withdrawalText = 'Retirá cuatro unidades por mercadería dañada.';
    const withdrawal = { itemId: 'withdrawal', type: 'stock.withdraw', target: { kind: 'existing', skuId: fixture.product.id }, quantity: { value: 4, unit: 'unit' }, reason: 'Mercadería dañada' };
    const request = input(`REVISAR OPERACION ${withdrawalText}`), fake = provider(proposal([withdrawal], withdrawalText));
    const result = await process(request, fake.complete), after = await state(true);
    assert.equal(fake.calls, 1); assert.equal(result.errorCode, 'INTERPRETATION_INVALID'); assert.equal(result.requiresConfirmation, false); assert.deepEqual(result.actions, []);
    assert.match(result.replyText,/retiro directo de unidades no está habilitado/);assert.match(result.replyText,/cantidad final/);
    assert.equal(Number(after.products.find(({ id }) => id === fixture.product.id).stock_available), 5);
    for (const [table, rows] of Object.entries(before)) {
      if (!['universal_meta_commands', 'outbox'].includes(table)) assert.deepEqual(after[table], rows, `${table} must remain unchanged for a forbidden public withdrawal`);
    }
    assert.equal(after.universal_meta_commands.length, before.universal_meta_commands.length + 1); assert.equal(after.outbox.length, before.outbox.length + 1);
    await persisted(request, result); assert.deepEqual(await process(request), result); assert.deepEqual(await state(true), after);
  });

  await check('universal meta: rejected removal clarification guides a final-balance retry and applies only after confirmation', async () => {
    const product=await db.createProductRecord({name:'Camiseta Real Madrid 2025 versión jugador',size:'M',stockAvailable:3,unit:'unit'},owner,{operationId:id()});
    const original='Borra 2 unidades',answer='De la camiseta del real Madrid talle m';
    const ordinary=(request,complete=forbidden)=>db.processMetaUniversalMessage(request,{ordinary:true,complete});
    const preview=await process(input(`REVISAR OPERACION ${original}`),provider({ok:true,json:{contractVersion:1,kind:'clarification',question:'¿De qué producto querés borrar 2 unidades?'}}).complete);
    const readContext={...context,permissions:[...context.permissions,'inventory:adjust']};
    const draft=await db.getUniversalDraft(preview.draftId,readContext),before=await state();
    const withdrawal={itemId:'withdrawal',type:'stock.withdraw',target:{kind:'existing',skuId:product.id},quantity:{value:2,unit:'unit'},reason:'Retiro solicitado'};
    const failedRequest=input(answer),failed=await ordinary(failedRequest,provider(proposal([withdrawal],original)).complete);
    assert.equal(failed.errorCode,'INTERPRETATION_INVALID');assert.equal(failed.interpretationReason,'FORBIDDEN');
    assert.match(failed.replyText,/Ejemplo de ajuste/);assert.match(failed.replyText,/cantidad final/);assert.match(failed.replyText,/«cancelar»/);
    assert.deepEqual(failed.actions,[]);assert.deepEqual(await state(),before);
    assert.deepEqual(await db.getUniversalDraft(preview.draftId,readContext),draft);
    await persisted(failedRequest,failed);assert.deepEqual(await ordinary(failedRequest),failed);
    const retryText='Ajustá el stock disponible de la camiseta Real Madrid 2025 versión jugador talle M a 1 unidad. Motivo: corrección de inventario.';
    const adjustment={itemId:'adjustment',type:'stock.adjust',target:{kind:'existing',skuId:product.id},balances:{available:1},reason:'Corrección de inventario'};
    const ready=await ordinary(input(retryText),provider(proposal([adjustment],retryText)).complete);
    assert.equal(ready.status,'awaiting_confirmation');assert.equal(ready.draftId,preview.draftId);assert.equal(ready.version,2);
    assert.deepEqual(await state(),before);
    const confirmation=input('confirmar'),applied=await ordinary(confirmation);
    assert.equal(applied.status,'applied');
    const after=await state();assert.equal(Number(after.products.find(row=>row.id===product.id).stock_available),1);
    assert.equal(after.inventory_movements.length,before.inventory_movements.length+1);
    assert.deepEqual(await ordinary(confirmation),applied);assert.deepEqual(await state(),after);
  });

  await check('universal meta: oversized real review persists terminal rejection while rolling back draft and draft command', async () => {
    const items = [];
    for (let index = 0; index < 16; index++) {
      const product = await db.createProductRecord({ name: `Meta revisión extensa ${id()} ${'detalle de identificación '.repeat(4)}`, stockAvailable: 2, unit: 'unit', price: 99 }, owner, { operationId: id() });
      items.push({ itemId: `receipt-${index}`, type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 1, unit: 'unit' } });
    }
    const source = 'Ingresó una unidad de cada uno de los dieciséis productos revisados.', request = input(`REVISAR OPERACION ${source}`), before = await state(true), fake = provider(proposal(items, source));
    const result = await process(request, fake.complete), after = await state(true);
    assert.equal(fake.calls, 1); assert.equal(result.errorCode, 'DRAFT_PREVIEW_TOO_LARGE'); assert.equal(result.handled, true); assert.equal(result.requiresConfirmation, false); assert.deepEqual(result.actions, []);
    for (const [table, rows] of Object.entries(before)) {
      if (!['universal_meta_commands', 'outbox'].includes(table)) assert.deepEqual(after[table], rows, `${table} must roll back when the full review cannot be delivered`);
    }
    assert.equal(after.universal_meta_commands.length, before.universal_meta_commands.length + 1); assert.equal(after.outbox.length, before.outbox.length + 1);
    await persisted(request, result); assert.deepEqual(await process(request), result); assert.deepEqual(await state(true), after);
  });

  await check('universal meta: message ID collisions reject changed text and actor without replacing immutable command or outbox', async () => {
    const fixture = await seed(), request = input(`REVISAR OPERACION ${text}`), preview = await prepare(fixture, request), before = await state(true);
    await assert.rejects(process({ ...request, sourceText: 'REVISAR OPERACION Ingresaron otras cantidades.' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(process({ ...request, senderPhone: actor }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await state(true), before); await persisted(request, preview); assert.deepEqual(await process(request), preview);
  });
}
