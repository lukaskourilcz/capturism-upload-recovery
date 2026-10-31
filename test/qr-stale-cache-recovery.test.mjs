import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),HASH=createHash('sha256').update(TOKEN).digest('hex');
const PROOF=`qr-expiry/v1/${HASH}.json`,WAIT=`qr-video-wait/v1/${HASH}.json`,NOW=2000000;
const old={boothId:'synthetic-booth',photoKey:PHOTO,layoutVideoKey:'sessions/old-legacy-cache/video.mp4',videosPending:true,createdAt:1000000,expiresAt:87400000};
async function setup({recover=true,revocation='removed'}={}){
 const store=storage();store.objects.set(META,JSON.stringify(old));store.objects.set(PHOTO,Buffer.alloc(32,7));store.objects.set(old.layoutVideoKey,Buffer.alloc(16,9));approveLegacy(store,TOKEN,old);
 let clock=NOW;const options={now:()=>clock},warm=makeQrRelay(store,options);assert.equal((await warm.download(TOKEN)).status,200);
 const cached=warm.cache.get(TOKEN);if(recover)store.objects.delete(META);
 if(revocation==='removed')store.objects.delete(APPROVAL);else{const a=JSON.parse(store.objects.get(APPROVAL));delete a.assets.layoutVideoKey;store.objects.set(APPROVAL,JSON.stringify(a));}
 if(recover)assert.equal((await makeQrRelay(store,options).confirm({...BODY,videosPending:true})).status,200);
 return {store,warm,cached,options,setClock:value=>{clock=value;}};
}
async function proxy(relay,kind='photo'){
 const server=http.createServer((req,res)=>{assert.equal(req.headers['x-booth-auth'],undefined);void relay.handleProxyAsset(req,res,TOKEN,kind);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/${kind}`);return{status:r.status,bytes:Buffer.from(await r.arrayBuffer())};}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
for(const revocation of ['removed','narrowed'])test(`warm and fresh relays serve recovered photo while ${revocation} approval keeps old video blocked`,async()=>{
 const f=await setup({revocation}),snapshot=new Map(f.store.objects),writes=f.store.writes;let oldGets=0,metadataGets=0;
 f.store.beforeGet=async({Key})=>{if(Key===old.layoutVideoKey)oldGets++;if(Key===META)metadataGets++;};
 for(const relay of [f.warm,makeQrRelay(f.store,f.options)]){
  assert.equal((await relay.download(TOKEN)).status,200);const p=await proxy(relay);assert.equal(p.status,200);assert.deepEqual(p.bytes,Buffer.alloc(32,7));assert.equal((await proxy(relay,'layout')).status,404);
 }
 assert.ok(metadataGets>0);assert.equal(oldGets,0);assert.equal(f.store.writes,writes);assert.deepEqual(f.store.objects,snapshot);assert.equal(f.warm.cache.get(TOKEN).layoutVideoKey,undefined);
});

for(const fault of ['metadata-outage','metadata-json','proof-outage','clock-outage','clock-conflict','wait-change','approval-outage','identity-change','expiry-change'])test(`${fault} during refresh offers retry without serving forbidden cached media`,async()=>{
 const f=await setup(),validMeta=f.store.objects.get(META),validWait=f.store.objects.get(WAIT);let forbidden=0;
 if(fault==='metadata-json')f.store.objects.set(META,'{');
 if(fault==='identity-change')f.store.objects.set(META,JSON.stringify({...JSON.parse(validMeta),boothId:'different-booth'}));
 if(fault==='expiry-change')f.store.objects.set(META,JSON.stringify({...JSON.parse(validMeta),createdAt:old.createdAt+1,expiresAt:old.expiresAt+1}));
 if(fault==='clock-conflict')f.store.objects.set(WAIT,JSON.stringify({...JSON.parse(validWait),startedAt:old.createdAt+1}));
 if(fault==='wait-change'){f.store.objects.set(META,JSON.stringify({...JSON.parse(validMeta),videoWaitStartedAt:old.createdAt+1}));f.store.objects.delete(WAIT);}
 const failedKey={'metadata-outage':META,'proof-outage':PROOF,'clock-outage':WAIT,'approval-outage':APPROVAL}[fault];
 f.store.beforeGet=async({Key})=>{if(Key===old.layoutVideoKey)forbidden++;if(Key===failedKey)throw new Error('Injected read failure');};
 const snapshot=new Map(f.store.objects),r=await f.warm.download(TOKEN);assert.equal(r.status,503);assert.equal(r.body.retryable,true);assert.deepEqual(f.store.objects,snapshot);assert.equal(forbidden,0);
 f.store.beforeGet=null;f.store.objects.set(META,validMeta);f.store.objects.set(WAIT,validWait);
 assert.equal((await f.warm.download(TOKEN)).status,200);assert.equal((await proxy(f.warm,'layout')).status,404);
});

for(const state of ['unchanged-revoked','missing','expired','private-reference'])test(`refresh keeps ${state} durable state denied without a retry loop or forbidden GET`,async()=>{
 const f=await setup({recover:false});
 if(state==='missing')f.store.objects.delete(META);
 if(state==='expired')f.setClock(old.expiresAt);
 if(state==='private-reference')f.store.objects.set(META,JSON.stringify({...old,layoutVideoKey:'subscriptions/private.json'}));
 const snapshot=new Map(f.store.objects);let metaGets=0,forbidden=0;
 f.store.beforeGet=async({Key})=>{if(Key===META)metaGets++;if(Key===old.layoutVideoKey||Key==='subscriptions/private.json')forbidden++;};
 assert.equal((await f.warm.download(TOKEN)).status,404);assert.ok(metaGets<=1);assert.equal((await proxy(f.warm)).status,404);assert.equal(forbidden,0);assert.deepEqual(f.store.objects,snapshot);
});

for(const sink of ['download','photo-proxy','video-proxy'])test(`revocation between load and ${sink} uses only the freshly validated keys`,async()=>{
 const f=await setup(),photoOnly=f.store.objects.get(META);f.store.objects.set(META,JSON.stringify(old));approveLegacy(f.store,TOKEN,old);f.warm.cache.set(TOKEN,f.cached);
 let approvalGets=0,forbidden=0;
 f.store.beforeGet=async({Key})=>{if(Key===APPROVAL&&++approvalGets===2){f.store.objects.delete(APPROVAL);f.store.objects.set(META,photoOnly);}if(Key===old.layoutVideoKey)forbidden++;};
 const r=sink==='download'?await f.warm.download(TOKEN):await proxy(f.warm,sink==='video-proxy'?'layout':'photo');
 assert.equal(r.status,sink==='video-proxy'?404:200);assert.equal(forbidden,0);if(sink==='download')assert.equal(r.body.layoutVideoUrl,null);
});

for(const sink of ['download','proxy'])test(`${sink} final refresh read failure stays retryable and recovers on the same QR`,async()=>{
 const f=await setup(),photoOnly=f.store.objects.get(META);f.store.objects.set(META,JSON.stringify(old));approveLegacy(f.store,TOKEN,old);f.warm.cache.set(TOKEN,f.cached);
 let approvalGets=0;
 f.store.beforeGet=async({Key})=>{if(Key===APPROVAL&&++approvalGets===2){f.store.objects.delete(APPROVAL);f.store.objects.set(META,photoOnly);}if(Key===META)throw new Error('Refresh outage');};
 const r=sink==='download'?await f.warm.download(TOKEN):await proxy(f.warm);assert.equal(r.status,503);if(sink==='download')assert.equal(r.body.retryable,true);
 f.store.beforeGet=null;assert.equal((await f.warm.download(TOKEN)).status,200);assert.deepEqual((await proxy(f.warm)).bytes,Buffer.alloc(32,7));
});

test('overlapping denied warm reads recover one valid mapping without storage writes',async()=>{
 const f=await setup(),snapshot=new Map(f.store.objects),writes=f.store.writes;
 const results=await Promise.all(Array.from({length:20},()=>f.warm.download(TOKEN)));
 assert.ok(results.every(r=>r.status===200&&r.body.layoutVideoUrl===null));assert.equal(f.store.writes,writes);assert.deepEqual(f.store.objects,snapshot);
});

test('a delayed refresh crossing expiry cannot publish or stream a recovered photo',async()=>{
 const f=await setup();f.store.beforeGet=async({Key})=>{if(Key===META)f.setClock(old.expiresAt);};const snapshot=new Map(f.store.objects);
 assert.equal((await f.warm.download(TOKEN)).status,404);assert.equal((await proxy(f.warm)).status,404);assert.deepEqual(f.store.objects,snapshot);
});

for(const outage of [false,true])test(`warm process ${outage?'refresh read failure':'recovery'} followed by SIGKILL preserves the photo and revocation`,async()=>{
 const f=await setup(),dir=await mkdtemp(join(tmpdir(),'qr-cache-restart-')),file=join(dir,'provider.json');let child;
 const encode=objects=>[...objects].map(([key,bytes])=>[key,Buffer.from(bytes).toString('base64')]);
 const initial=new Map(f.store.objects);initial.set(META,JSON.stringify(old));initial.set(APPROVAL,JSON.stringify(scope.buildLegacyApproval(TOKEN,old)));await writeFile(file,JSON.stringify(encode(initial)));
 const start=async state=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,'normal',String(NOW),state],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});const[{port}]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`Worker exited ${code}: ${errors}`);})]);return `http://127.0.0.1:${port}`;};
 const stop=async()=>{const died=once(child,'exit');child.kill('SIGKILL');await died;};
 try{
  let base=await start(outage?'refresh-read-error':'normal');assert.equal((await fetch(base+'/download/'+TOKEN)).status,200);
  const replaced=once(child,'message');child.send({type:'replace-provider',objects:encode(f.store.objects)});const[ack]=await replaced;assert.equal(ack.phase,'provider-replaced');const before=await readFile(file,'utf8');
  const warmResponse=await fetch(base+'/download/'+TOKEN);assert.equal(warmResponse.status,outage?503:200);const warmBody=await warmResponse.json();if(outage)assert.equal(warmBody.retryable,true);else assert.equal(warmBody.layoutVideoUrl,null);
  assert.equal(await readFile(file,'utf8'),before);await stop();base=await start('normal');
  const r=await fetch(base+'/download/'+TOKEN);assert.equal(r.status,200);const body=await r.json();assert.equal(body.layoutVideoUrl,null);assert.deepEqual(Buffer.from(await(await fetch(body.photoUrl)).arrayBuffer()),Buffer.alloc(32,7));assert.equal(await readFile(file,'utf8'),before);
 }finally{if(child?.exitCode===null&&child?.signalCode===null){const died=once(child,'exit');child.kill('SIGTERM');await died;}await rm(dir,{recursive:true,force:true});}
});
