import assert from 'node:assert/strict';
import { inspectUniversalSchema, migrateUniversalSchema } from '../server/universalSchemaMigration.js';

export async function runUniversalSchemaMigrationChecks({ db, sql, check }) {
  let sequence = 0;
  const id = (prefix) => `universal-schema-${prefix}-${++sequence}`;
  const owner = `universal-schema-owner-${Date.now()}`;

  await check('universal schema migration upgrades an old schema without changing business rows and is idempotent', async () => {
    const product = await db.createProductRecord({
      name: `Migration preservation ${id('product')}`,
      stockAvailable: 7,
      price: 31,
      unit: 'unit',
    }, owner, { operationId: id('product-op') });
    const productBefore = (await sql.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
    assert.ok(productBefore, 'seed product should exist before schema repair');
    const savedDraftId=id('existing-draft');
    await sql.query("INSERT INTO universal_drafts(owner_phone,draft_id,actor_id,version,status,preview_json,expires_at) VALUES($1,$2,$1,1,'awaiting_confirmation','{\"kept\":true}'::jsonb,NOW()+INTERVAL '1 hour')",[owner,savedDraftId]);
    const savedDraft=(await sql.query('SELECT * FROM universal_drafts WHERE draft_id=$1',[savedDraftId])).rows[0];
    await sql.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$; GRANT ALL ON TABLE public.universal_drafts TO anon,authenticated");

    // Recreate the specific stale shape this migration must repair. These checks
    // run first, before other harness checks can create command fixtures.
    await sql.query('DROP TABLE public.universal_meta_commands');
    await sql.query(`ALTER TABLE public.universal_drafts DROP CONSTRAINT IF EXISTS universal_drafts_status_check;
      ALTER TABLE public.universal_drafts ADD CONSTRAINT universal_drafts_status_check
      CHECK(status IN ('awaiting_confirmation','awaiting_clarification','applied','cancelled'))`);

    const stale = await inspectUniversalSchema(sql);
    assert.equal(stale.ready, false, 'legacy schema should be reported as not ready');
    assert.ok(stale.missingTables.includes('universal_meta_commands'));
    assert.equal(stale.answeredSupported, false);
    assert.equal(stale.apiRolesRevoked,false);

    const first = await migrateUniversalSchema(sql);
    assert.equal(first.dataUnchanged, true);
    assert.equal(first.after.ready, true);
    assert.equal(first.after.rlsEnabled, true);
    assert.equal(first.after.apiRolesRevoked, true);
    assert.deepEqual(first.before, stale);
    assert.deepEqual((await sql.query('SELECT * FROM universal_drafts WHERE draft_id=$1',[savedDraftId])).rows[0],savedDraft);

    const draftId = id('draft');
    const draftCommandId = id('draft-command');
    const metaMessageId = id('meta-message');
    await sql.query('BEGIN');
    try {
      await sql.query(`INSERT INTO universal_drafts(owner_phone,draft_id,actor_id,version,status,preview_json,expires_at)
        VALUES($1,$2,$3,1,'answered','{}'::jsonb,NOW()+INTERVAL '1 hour')`, [owner, draftId, owner]);
      await sql.query(`INSERT INTO universal_draft_commands(owner_phone,actor_id,request_id,request_hash,draft_id,response_json)
        VALUES($1,$2,$3,'migration-probe',$4,'{}'::jsonb)`, [owner, owner, draftCommandId, draftId]);
      await sql.query(`INSERT INTO universal_meta_commands(owner_phone,message_id,actor_id,request_hash,result_json)
        VALUES($1,$2,$3,'migration-probe','{}'::jsonb)`, [owner, metaMessageId, owner]);
    } finally {
      await sql.query('ROLLBACK');
    }

    const afterProbe = (await sql.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
    assert.deepEqual(afterProbe, productBefore, 'migration and rolled-back probe must preserve the business row');

    const second = await migrateUniversalSchema(sql);
    assert.equal(second.dataUnchanged, true);
    assert.equal(second.after.ready, true);
    assert.deepEqual(second.before, second.after, 'a repeated migration should make no further schema change');
    assert.deepEqual((await sql.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0], productBefore);
  });

  await check('universal schema migration rolls back all DDL when security hardening fails', async () => {
    await sql.query("DROP TABLE public.universal_meta_commands; ALTER TABLE public.universal_drafts DROP CONSTRAINT universal_drafts_status_check; ALTER TABLE public.universal_drafts ADD CONSTRAINT universal_drafts_status_check CHECK(status IN ('awaiting_confirmation','awaiting_clarification','applied','cancelled'))");
    const before = await inspectUniversalSchema(sql);
    assert.equal(before.ready, false);
    assert.ok(before.missingTables.includes('universal_meta_commands'));
    let injected = false;
    const failingClient = {
      query: async (statement, params) => {
        if (!injected && typeof statement === 'string' && /\bREVOKE\b/i.test(statement)) {
          injected = true;
          throw new Error('injected universal migration security failure');
        }
        return sql.query(statement, params);
      },
    };

    await assert.rejects(migrateUniversalSchema(failingClient), /injected universal migration security failure/);
    assert.equal(injected, true, 'migration should reach the security hardening statement');
    const after = await inspectUniversalSchema(sql);
    assert.deepEqual(after, before, 'failed migration should restore the complete prior schema state');
    assert.equal((await migrateUniversalSchema(sql)).after.ready,true);
  });
}
