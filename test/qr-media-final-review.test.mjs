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
import { makeQrRelay, approveLegacy, TOKEN } from './helpers/qr-relay-fixture.mjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),NOW=2000000;
const hash=createHash('sha256').update(TOKEN).digest('hex'),PROOF=`qr-expiry/v1/${hash}.json`,WAIT=`qr-video-wait/v1/${hash}.json`;
const original={boothId:'synthetic-booth',photoKey:'sessions/reviewed-legacy/photo.jpeg',videoKey:'sessions/reviewed-legacy/video.mp4',layoutVideoKey:'sessions/reviewed-legacy/layout.webm',storyVideoKey:'sessions/reviewed-legacy/story.mp4',createdAt:1000000,expiresAt:87400000};
const opts={now:()=>NOW};
async function setup(){
  const store=storage();store.objects.set(META,JSON.stringify(original));approveLegacy(store,TOKEN,original);
  for(const [i,field] of scope.FIELDS.entries())store.objects.set(original[field],Buffer.alloc(32,i+1));
  const relay=makeQrRelay(store,opts);assert.equal((await relay.download(TOKEN)).status,200);
  return {store,relay};
}
async function proxy(relay){
 const server=http.createServer((req,res)=>{void relay.handleProxyAsset(req,res,TOKEN,'photo');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}`);return {status:r.status,bytes:Buffer.from(await r.arrayBuffer())};}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const retained=store=>new Map([...store.objects].filter(([key])=>key!==META));
const confirm={token:TOKEN,...original};

test('approved legacy metadata reconstruction preserves original proof, wait, media and approval',async()=>{
 const {store}=await setup(),snapshot=retained(store);store.objects.delete(META);const relay=makeQrRelay(store,opts);
 assert.equal((await relay.download(TOKEN)).status,404);assert.equal((await relay.confirm(confirm)).status,200);
 const record=JSON.parse(store.objects.get(META));for(const field of [...scope.FIELDS,'createdAt','expiresAt'])assert.equal(record[field],original[field]);
 assert.equal(record.videoWaitStartedAt,original.createdAt);assert.deepEqual(retained(store),snapshot);
 const cold=makeQrRelay(store,opts);assert.equal((await cold.download(TOKEN)).status,200);assert.equal((await cold.confirm(confirm)).status,200);
 assert.deepEqual((await proxy(cold)).bytes,Buffer.alloc(32,1));assert.deepEqual(retained(store),snapshot);
});

test('missing or mismatched approvals cannot recreate cleaned-up legacy metadata or clocks',async()=>{
 for(const mode of ['missing','identity','dates']){
  const {store}=await setup();store.objects.delete(META);
  if(mode==='missing')store.objects.delete(APPROVAL);else{const a=JSON.parse(store.objects.get(APPROVAL));if(mode==='identity')a.identityHash='0'.repeat(64);else a.expiresAt++;store.objects.set(APPROVAL,JSON.stringify(a));}
  const snapshot=new Map(store.objects),writes=store.writes,relay=makeQrRelay(store,opts);
  assert.equal((await relay.confirm(confirm)).status,403);assert.equal((await relay.download(TOKEN)).status,404);
  assert.equal(store.writes,writes);assert.deepEqual(store.objects,snapshot);assert.equal(relay.notifications.length,0);
 }
});

test('an approval alone cannot issue a new clock, and missing approval cannot bootstrap legacy proof',async()=>{
 const {store}=await setup();store.objects.delete(META);store.objects.delete(PROOF);store.objects.delete(WAIT);
 let snapshot=new Map(store.objects);assert.equal((await makeQrRelay(store,opts).confirm(confirm)).status,410);assert.deepEqual(store.objects,snapshot);
 store.objects.set(META,JSON.stringify(original));store.objects.delete(APPROVAL);snapshot=new Map(store.objects);
 assert.equal((await makeQrRelay(store,opts).download(TOKEN)).status,404);assert.deepEqual(store.objects,snapshot);
});

test('simultaneous restored legacy replays merge approved variants once without renewing either clock',async()=>{
 const {store}=await setup();store.objects.delete(META);const snapshot=retained(store),writes=store.writes;
 const photo={token:TOKEN,photoKey:original.photoKey};
 const [a,b]=await Promise.all([makeQrRelay(store,opts).confirm({...photo,layoutVideoKey:original.layoutVideoKey}),makeQrRelay(store,opts).confirm({...photo,storyVideoKey:original.storyVideoKey})]);
 assert.deepEqual([a.status,b.status],[200,200]);const record=JSON.parse(store.objects.get(META));
 assert.equal(record.layoutVideoKey,original.layoutVideoKey);assert.equal(record.storyVideoKey,original.storyVideoKey);assert.equal(store.writes-writes,1);assert.equal(record.videoKey,original.videoKey);
 assert.equal(record.createdAt,original.createdAt);assert.equal(record.expiresAt,original.expiresAt);assert.equal(record.videoWaitStartedAt,original.createdAt);assert.deepEqual(retained(store),snapshot);
});

test('revocation between warm load and final public sink prevents signing and object reads',async()=>{
 for(const sink of ['download','proxy']){
  const {store,relay}=await setup();let approvals=0,mediaGets=0;const snapshot=store.objects.get(META);
  store.beforeGet=async({Key})=>{if(Key===APPROVAL&&++approvals===2)store.objects.delete(APPROVAL);if(scope.FIELDS.some(f=>original[f]===Key))mediaGets++;};
  const response=sink==='download'?await relay.download(TOKEN):await proxy(relay);assert.equal(response.status,404);assert.equal(mediaGets,0);assert.equal(store.objects.get(META),snapshot);
 }
});

test('foreign copied approval cannot authorize a second QR even with identical legacy photo identity',async()=>{
 const {store}=await setup(),other='another-review-token',key=`sessions/${other}/meta.json`;
 store.objects.set(key,JSON.stringify(original));store.objects.set(scope.approvalKey(other),store.objects.get(APPROVAL));const snapshot=new Map(store.objects);
 assert.equal((await makeQrRelay(store,opts).download(other)).status,404);assert.equal((await makeQrRelay(store,opts).confirm({...confirm,token:other})).status,403);assert.deepEqual(store.objects,snapshot);
});

test('failed legacy reconstruction survives SIGKILL and recovery; revoked approval stays denied after restart',async()=>{
 const {store}=await setup();store.objects.delete(META);const dir=await mkdtemp(join(tmpdir(),'qr-media-review-restart-')),file=join(dir,'provider.json');let child;
 const encode=objects=>JSON.stringify([...objects].map(([k,v])=>[k,Buffer.from(v).toString('base64')]));
 await writeFile(file,encode(store.objects));const initial=new Map(JSON.parse(await readFile(file,'utf8')));
 const snapshot=async()=>new Map(JSON.parse(await readFile(file,'utf8')));
 const start=async mode=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,mode,String(NOW)],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});const[{port}]=await once(child,'message');return `http://127.0.0.1:${port}`;};
 const stop=async()=>{const died=once(child,'exit');child.kill('SIGKILL');await died;};
 const post=base=>fetch(base+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(confirm)});
 try{
  let base=await start('fail');assert.equal((await post(base)).status,503);assert.deepEqual(await snapshot(),initial);await stop();
  base=await start('normal');assert.equal((await post(base)).status,200);const download=await fetch(base+'/download/'+TOKEN);assert.equal(download.status,200);const body=await download.json();
  for(const [i,field] of ['photoUrl','videoUrl','layoutVideoUrl','storyVideoUrl'].entries())assert.deepEqual(Buffer.from(await(await fetch(body[field])).arrayBuffer()),Buffer.alloc(32,i+1));
  const restored=await snapshot();for(const [key,bytes]of initial)assert.equal(restored.get(key),bytes);await stop();
  restored.delete(META);restored.delete(APPROVAL);await writeFile(file,JSON.stringify([...restored]));const revoked=await snapshot();base=await start('normal');
  assert.equal((await post(base)).status,403);assert.equal((await fetch(base+'/download/'+TOKEN)).status,404);assert.deepEqual(await snapshot(),revoked);
 }finally{if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
});
