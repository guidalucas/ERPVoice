import dotenv from 'dotenv';
import {Client} from 'pg';
import {inspectUniversalSchema,migrateUniversalSchema} from '../server/universalSchemaMigration.js';

dotenv.config({path:'.env.local',override:true,quiet:true});
dotenv.config({quiet:true});
const args=process.argv.slice(2);
const valid=args.every(arg=>['--apply','--check'].includes(arg)) && new Set(args).size===args.length
  && !(args.includes('--apply')&&args.includes('--check'));
if(!valid) {
  console.error('Usá --check (solo lectura, predeterminado) o --apply (migración aditiva).');
  process.exitCode=2;
} else {
  let client;
  try {
    const connectionString=process.env.SUPABASE_DATABASE_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.POSTGRES_CONNECTION_STRING;
    if(!connectionString) throw Object.assign(new Error(),{code:'DATABASE_CONFIG_REQUIRED'});
    const url=new URL(connectionString);
    const remote=!['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    const ssl=process.env.POSTGRES_SSL==='false' ? false
      : process.env.POSTGRES_SSL==='true'||remote ? {rejectUnauthorized:false} : false;
    client=new Client({connectionString,ssl,connectionTimeoutMillis:15000,query_timeout:60000,application_name:'stocky-universal-schema-migration'});
    await client.connect();
    let result;
    if(args.includes('--apply')) result={mode:'APPLY',...await migrateUniversalSchema(client)};
    else {
      await client.query('BEGIN READ ONLY');
      result={mode:'CHECK',...await inspectUniversalSchema(client)};
      await client.query('ROLLBACK');
      if(!result.ready) process.exitCode=2;
    }
    console.log(JSON.stringify(result,null,2));
  } catch(error) {
    // Connection and provider messages may contain DSNs; print stable codes only.
    console.error(JSON.stringify({ok:false,code:error.code??error.cause?.code??'MIGRATION_FAILED'}));
    process.exitCode=1;
  } finally {if(client) await client.end().catch(()=>{});}
}
