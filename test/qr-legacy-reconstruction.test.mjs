import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO } from './helpers/qr-relay-fixture.mjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),HASH=createHash('sha256').update(TOKEN).digest('hex');
const PROOF=`qr-expiry/v1/${HASH}.json`,WAIT=`qr-video-wait/v1/${HASH}.json`,START=1000000;
const original={boothId:'synthetic-booth',photoKey:PHOTO,videoKey:'sessions/old-raw-video/video.webm',layoutVideoKey:'sessions/old-layout-video/video.mp4',storyVideoKey:'sessions/old-story-video/story.mp4',videosPending:true,createdAt:START,expiresAt:START+86400000};
async function setup({photoKey=PHOTO,now=()=>START+1200000}={}){
 const record={...original,photoKey},store=storage(),options={now};store.objects.set(META,JSON.stringify(record));approveLegacy(store,TOKEN,record);
 for(const [i,f]of scope.FIELDS.entries())store.objects.set(record[f],Buffer.alloc(32,i+1));
 const seededRelay=makeQrRelay(store,options);assert.equal((await seededRelay.download(TOKEN)).status,200);store.objects.delete(META);
 return {store,record,options,seededRelay,body:{token:TOKEN,photoKey, videosPending:true}};
}
const retained=store=>new Map([...store.objects].filter(([key])=>key!==META));
const read=store=>JSON.parse(store.objects.get(META));

for(const noncanonical of [false,true])test(`photo-only reconstruction restores all approved videos with ${noncanonical?'legacy':'canonical'} photo and original clocks`,async()=>{
 for(const elapsed of [120000,1200000]){
  const f=await setup({photoKey:noncanonical?'sessions/old-photo-token/photo.jpeg':PHOTO,now:()=>START+elapsed}),snapshot=retained(f.store),relay=f.seededRelay;
  assert.equal((await relay.confirm(f.body)).status,200);const saved=read(f.store);
  for(const field of [...scope.FIELDS,'createdAt','expiresAt'])assert.equal(saved[field],f.record[field]);assert.equal(saved.videoWaitStartedAt,START);
  const writes=f.store.writes,committed=f.store.objects.get(META);
  for(const r of [relay,makeQrRelay(f.store,f.options)]){
   assert.equal((await r.confirm(f.body)).status,200);const result=await r.download(TOKEN);assert.equal(result.status,200);assert.equal(result.body.videoFailed,false);
   for(const field of ['videoUrl','layoutVideoUrl','storyVideoUrl'])assert.ok(result.body[field]);
  }
  assert.equal(f.store.writes,writes);assert.equal(f.store.objects.get(META),committed);assert.deepEqual(retained(f.store),snapshot);
 }
});

test('a replay cannot replace an approved legacy video with another reference during reconstruction',async()=>{
 const f=await setup(),snapshot=new Map(f.store.objects),relay=makeQrRelay(f.store,f.options);
 assert.equal((await relay.confirm({...f.body,layoutVideoKey:`sessions/${TOKEN}/layout.mp4`})).status,409);
 assert.deepEqual(f.store.objects,snapshot);assert.equal(relay.notifications.length,0);
});

for(const noncanonical of [false,true])test(`revoked approval never restores or exposes legacy videos (${noncanonical?'legacy':'canonical'} photo)`,async()=>{
 const f=await setup({photoKey:noncanonical?'sessions/old-photo-token/photo.jpeg':PHOTO});f.store.objects.delete(APPROVAL);const snapshot=retained(f.store),relay=makeQrRelay(f.store,f.options);
 assert.equal((await relay.confirm({...f.body,layoutVideoKey:f.record.layoutVideoKey})).status,403);assert.equal(f.store.objects.has(META),false);
 const result=await relay.confirm(f.body);assert.equal(result.status,noncanonical?403:200);
 if(noncanonical){assert.equal(f.store.objects.has(META),false);assert.equal((await relay.download(TOKEN)).status,404);}
 else{const saved=read(f.store);for(const field of scope.FIELDS.slice(1))assert.equal(saved[field],undefined);const publicResult=await relay.download(TOKEN);assert.equal(publicResult.status,200);assert.equal(publicResult.body.layoutVideoUrl,null);}
 assert.deepEqual(retained(f.store),snapshot);assert.equal(f.store.objects.has(APPROVAL),false);
});

for(const fault of ['outage','invalid-json','null-json','wrong-identity','wrong-dates','wrong-token','private-key'])test(`approval ${fault} blocks photo-only reconstruction before saving`,async()=>{
 const f=await setup();
 if(fault==='outage')f.store.beforeGet=async({Key})=>{if(Key===APPROVAL)throw new Error('Approval read unavailable');};
 else if(fault==='invalid-json')f.store.objects.set(APPROVAL,'{');
 else if(fault==='null-json')f.store.objects.set(APPROVAL,'null');
 else{const a=JSON.parse(f.store.objects.get(APPROVAL));if(fault==='wrong-identity')a.identityHash='0'.repeat(64);if(fault==='wrong-dates')a.expiresAt++;if(fault==='wrong-token')a.tokenHash='0'.repeat(64);if(fault==='private-key')a.assets.layoutVideoKey='subscriptions/private.json';f.store.objects.set(APPROVAL,JSON.stringify(a));}
 const snapshot=new Map(f.store.objects),writes=f.store.writes,relay=makeQrRelay(f.store,f.options);
 assert.equal((await relay.confirm(f.body)).status,['outage','invalid-json'].includes(fault)?503:403);assert.deepEqual(f.store.objects,snapshot);assert.equal(f.store.writes,writes);assert.equal(relay.notifications.length,0);
});

test('save failure and lost acknowledgement recover approved videos without duplicate writes',async()=>{
 for(const fault of ['save','ack','authorization']){
  const lost=fault!=='save',f=await setup(),snapshot=retained(f.store),relay=makeQrRelay(f.store,f.options);let once=false;
  if(fault==='ack')f.store.afterPut=async({Key})=>{if(Key===META&&!once){once=true;throw new Error('Lost metadata acknowledgement');}};
  else if(fault==='authorization')f.store.afterPut=async({Key})=>{if(Key===META)f.store.beforeGet=async({Key})=>{if(Key===APPROVAL)throw new Error('Post-save approval outage');};};
  else f.store.failWrites=1;
  assert.equal((await relay.confirm(f.body)).status,503);assert.equal(relay.cache.size,0);assert.equal(relay.notifications.length,0);
  const writes=f.store.writes;f.store.afterPut=null;f.store.beforeGet=null;const cold=makeQrRelay(f.store,f.options);assert.equal((await cold.confirm(f.body)).status,200);
  assert.equal(f.store.writes-writes,lost?0:1);for(const field of scope.FIELDS)assert.equal(read(f.store)[field],f.record[field]);assert.deepEqual(retained(f.store),snapshot);
 }
});

test('revocation during a durable save withholds success and keeps cold reads denied',async()=>{
 const f=await setup(),relay=makeQrRelay(f.store,f.options);f.store.afterPut=async({Key})=>{if(Key===META)f.store.objects.delete(APPROVAL);};
 assert.equal((await relay.confirm(f.body)).status,403);assert.equal(relay.cache.size,0);assert.equal(relay.notifications.length,0);
 assert.equal((await makeQrRelay(f.store,f.options).download(TOKEN)).status,404);assert.equal(f.store.objects.has(APPROVAL),false);
});

test('concurrent photo-only reconstruction and full replay commit one complete approved mapping',async()=>{
 const f=await setup(),snapshot=retained(f.store),writes=f.store.writes;
 const results=await Promise.all([makeQrRelay(f.store,f.options).confirm(f.body),makeQrRelay(f.store,f.options).confirm({...f.body,...f.record})]);
 assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal(f.store.writes-writes,1);for(const field of scope.FIELDS)assert.equal(read(f.store)[field],f.record[field]);assert.deepEqual(retained(f.store),snapshot);
});

test('approval recovery cannot extend expiry even if the lookup crosses the boundary',async()=>{
 let clock=START+1200000;const f=await setup({now:()=>clock});f.store.beforeGet=async({Key})=>{if(Key===APPROVAL)clock=f.record.expiresAt;};const snapshot=new Map(f.store.objects);
 assert.equal((await makeQrRelay(f.store,f.options).confirm(f.body)).status,410);assert.equal(f.store.objects.has(META),false);assert.deepEqual(f.store.objects,snapshot);
});

test('photo-only legacy recovery survives failed save, SIGKILL, restart and later approval revocation',async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),'qr-legacy-recovery-')),file=join(dir,'provider.json');let child;
 await writeFile(file,JSON.stringify([...f.store.objects].map(([k,v])=>[k,Buffer.from(v).toString('base64')])));const initial=new Map(JSON.parse(await readFile(file,'utf8')));
 const snapshot=async()=>new Map(JSON.parse(await readFile(file,'utf8')));
 const start=async mode=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,mode,String(START+1200000)],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});const[{port}]=await once(child,'message');return `http://127.0.0.1:${port}`;};
 const stop=async()=>{const died=once(child,'exit');child.kill('SIGKILL');await died;};
 const post=base=>fetch(base+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.body)});
 try{
  let base=await start('fail');assert.equal((await post(base)).status,503);assert.deepEqual(await snapshot(),initial);await stop();
  base=await start('normal');assert.equal((await post(base)).status,200);const saved=await snapshot();await stop();
  base=await start('normal');assert.equal((await post(base)).status,200);const r=await fetch(base+'/download/'+TOKEN);assert.equal(r.status,200);const body=await r.json();assert.equal(body.videoFailed,false);
  for(const [i,field]of ['photoUrl','videoUrl','layoutVideoUrl','storyVideoUrl'].entries())assert.deepEqual(Buffer.from(await(await fetch(body[field])).arrayBuffer()),Buffer.alloc(32,i+1));
  assert.deepEqual(await snapshot(),saved);for(const [key,bytes]of initial)assert.equal(saved.get(key),bytes);await stop();
  saved.delete(APPROVAL);await writeFile(file,JSON.stringify([...saved]));base=await start('normal');assert.equal((await post(base)).status,403);assert.equal((await fetch(base+'/download/'+TOKEN)).status,404);
  assert.equal((await snapshot()).has(APPROVAL),false);
 }finally{if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
});

test('SIGKILL after the legacy mapping is saved but before acknowledgement reuses the complete commit',async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),'qr-legacy-lost-ack-')),file=join(dir,'provider.json');let child;
 await writeFile(file,JSON.stringify([...f.store.objects].map(([k,v])=>[k,Buffer.from(v).toString('base64')])));
 const start=async pause=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,'normal',String(START+1200000),pause?'pause-discovery-ack':'normal'],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});const[{port}]=await once(child,'message');return `http://127.0.0.1:${port}`;};
 const stop=async()=>{const died=once(child,'exit');child.kill('SIGKILL');await died;};
 const post=base=>fetch(base+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.body)});
 try{
  let base=await start(true);const durable=once(child,'message'),request=post(base).then(()=>({unexpectedAck:true}),()=>({disconnected:true}));
  const [marker]=await durable;assert.equal(marker.phase,'discovery-metadata-durable');const before=await readFile(file,'utf8');
  const metadata=JSON.parse(Buffer.from(new Map(JSON.parse(before)).get(META),'base64'));for(const field of scope.FIELDS)assert.equal(metadata[field],f.record[field]);
  await stop();assert.deepEqual(await request,{disconnected:true});base=await start(false);assert.equal((await post(base)).status,200);
  const response=await fetch(base+'/download/'+TOKEN);assert.equal(response.status,200);const body=await response.json();assert.equal(body.videoFailed,false);
  assert.deepEqual(Buffer.from(await(await fetch(body.layoutVideoUrl)).arrayBuffer()),Buffer.alloc(32,3));assert.equal(await readFile(file,'utf8'),before);
 }finally{if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
});
