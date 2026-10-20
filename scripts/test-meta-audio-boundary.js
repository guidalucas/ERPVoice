import assert from 'node:assert/strict';
import test from 'node:test';
import {processMetaWebhook} from '../server/metaWebhookProcessor.js';
import {MAX_AUDIO_BYTES} from '../server/audioTranscription.js';

const body={object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id:'audio-boundary',from:'59899123456',type:'audio',audio:{id:'123456'}}]}}]}]};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function fixture(run) {
  const previousFetch=globalThis.fetch,keys=['META_ACCESS_TOKEN','GROQ_API_KEY','VOICE_TRANSCRIPTION_API_KEY','VOICE_TRANSCRIPTION_ENDPOINT','VOICE_TRANSCRIPTION_MODEL'];
  const previous=keys.map(key=>process.env[key]);
  process.env.META_ACCESS_TOKEN='private-meta-key';process.env.VOICE_TRANSCRIPTION_API_KEY='private-transcription-key';
  delete process.env.VOICE_TRANSCRIPTION_ENDPOINT;delete process.env.VOICE_TRANSCRIPTION_MODEL;
  try {await run();} finally {
    globalThis.fetch=previousFetch;keys.forEach((key,index)=>previous[index]===undefined ? delete process.env[key] : process.env[key]=previous[index]);
  }
}

test('Meta audio shares private transcription, persists text before universal review and cached retries download nothing',async()=>fixture(async()=>{
  const calls=[],events=[];let transcript;
  globalThis.fetch=async(url,init)=>{
    calls.push(String(url));
    if(String(url).includes('graph.facebook.com')) return json({url:'https://media.example/audio',mime_type:'audio/ogg'});
    if(String(url)==='https://media.example/audio') return new Response(Buffer.from('bytes'),{headers:{'Content-Type':'audio/ogg'}});
    assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(init.headers.Authorization,'Bearer private-transcription-key');
    assert.equal(init.body.get('file').name,'audio.ogg');
    return json({text:'Ingresaron tres unidades del producto'});
  };
  const hooks={loadTranscript:async()=>transcript,saveTranscript:async(id,text)=>{transcript=text;events.push('saved');},
    processStockText:async({sourceText})=>{assert.equal(sourceText,transcript);events.push('review');return {replyText:'Revisión pendiente',actions:[],requiresConfirmation:true};}};
  const first=await processMetaWebhook(body,hooks);
  assert.equal(first[0].sourceText,transcript);assert.deepEqual(events,['saved','review']);assert.equal(calls.length,3);
  globalThis.fetch=()=>assert.fail('cached transcription must not contact Meta or provider');
  assert.equal((await processMetaWebhook(body,hooks))[0].sourceText,transcript);
}));

test('Meta enforces download cap without Content-Length and never interprets oversized audio',async()=>fixture(async()=>{
  let providerCalls=0;
  globalThis.fetch=async(url)=>{
    if(String(url).includes('graph.facebook.com')) return json({url:'https://media.example/audio'});
    if(String(url)==='https://media.example/audio') return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES+1));controller.close();}}));
    providerCalls++;assert.fail('oversized audio must not reach provider');
  };
  await assert.rejects(processMetaWebhook(body,{processStockText:()=>assert.fail('audio cannot be interpreted')}),{code:'audio_too_large'});
  assert.equal(providerCalls,0);
}));

test('Meta transcription failure exposes no provider body and saves no executable text',async()=>fixture(async()=>{
  globalThis.fetch=async(url)=>{
    if(String(url).includes('graph.facebook.com')) return json({url:'https://media.example/audio'});
    if(String(url)==='https://media.example/audio') return new Response('audio',{headers:{'Content-Type':'audio/ogg'}});
    return new Response('private-transcription-key secret upstream body',{status:503});
  };
  await assert.rejects(processMetaWebhook(body,{saveTranscript:()=>assert.fail('failed audio must not be saved'),processStockText:()=>assert.fail('must not interpret')}),error=>{
    assert.equal(error.code,'transcription_provider_error');assert.doesNotMatch(error.message,/private|secret|upstream/);return true;
  });
}));
