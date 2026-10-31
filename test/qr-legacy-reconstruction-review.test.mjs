import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),NOW=2000000;
const record={boothId:'synthetic-booth',photoKey:PHOTO,layoutVideoKey:'sessions/legacy-layout-review/video.mp4',storyVideoKey:'sessions/legacy-story-review/story.webm',videosPending:true,createdAt:1000000,expiresAt:87400000};
async function setup(){
 const store=storage();store.objects.set(META,JSON.stringify(record));approveLegacy(store,TOKEN,record);
 store.objects.set(PHOTO,Buffer.alloc(32,7));store.objects.set(record.layoutVideoKey,Buffer.alloc(16,9));store.objects.set(record.storyVideoKey,Buffer.alloc(24,8));
 assert.equal((await makeQrRelay(store,{now:()=>NOW}).download(TOKEN)).status,200);store.objects.delete(META);return store;
}
for(const route of ['WebSocket','dev seed'])test(`${route} photo-only recovery retains the same approved legacy variants and clocks`,async()=>{
 const store=await setup(),snapshot=new Map(store.objects),writes=store.writes,relay=makeQrRelay(store,{now:()=>NOW});
 const call=()=>route==='WebSocket'?relay.handleWsPhotosReady({type:'booth:photos_ready',payload:BODY},'synthetic-booth'):new Promise((resolve,reject)=>relay.handleDevSeed({body:{...BODY,key:'synthetic',boothId:'synthetic-booth'},fail:reject},{resolve}));
 const result=await call();if(route==='dev seed')assert.equal(result.status,200);
 const saved=JSON.parse(store.objects.get(META));for(const field of ['photoKey','layoutVideoKey','storyVideoKey','createdAt','expiresAt'])assert.equal(saved[field],record[field]);assert.equal(saved.videoWaitStartedAt,record.createdAt);
 assert.equal((await relay.download(TOKEN)).status,200);await call();assert.equal(store.writes-writes,1);for(const[key,bytes]of snapshot)assert.equal(store.objects.get(key),bytes);
});

test('approved completed video recovery does not depend on a videosPending request flag',async()=>{
 for(const videosPending of [undefined,false]){
  const store=await setup(),relay=makeQrRelay(store,{now:()=>NOW});assert.equal((await relay.confirm({...BODY,videosPending})).status,200);
  const response=await relay.download(TOKEN);assert.equal(response.status,200);assert.equal(response.body.videoPending,false);assert.equal(response.body.videoFailed,false);assert.ok(response.body.layoutVideoUrl);assert.ok(response.body.storyVideoUrl);
 }
});

test('another booth cannot hydrate a legacy approval during missing-metadata recovery',async()=>{
 const store=await setup(),snapshot=new Map(store.objects),relay=makeQrRelay(store,{now:()=>NOW,boothId:'other-booth'});
 assert.equal((await relay.confirm(BODY)).status,409);assert.deepEqual(store.objects,snapshot);assert.equal(relay.notifications.length,0);
});

test('retained approval cannot recover an expired QR or mutate original proof and wait records',async()=>{
 const store=await setup(),snapshot=new Map(store.objects),relay=makeQrRelay(store,{now:()=>record.expiresAt});
 assert.equal((await relay.confirm(BODY)).status,410);assert.equal((await relay.download(TOKEN)).status,404);assert.deepEqual(store.objects,snapshot);
});

for(const mode of ['approval-read-error','post-save-approval-error'])test(`${mode} survives process replacement without dropping media or renewing clocks`,async()=>{
 const store=await setup(),dir=await mkdtemp(join(tmpdir(),'qr-legacy-review-')),file=join(dir,'provider.json');let child;
 await writeFile(file,JSON.stringify([...store.objects].map(([key,bytes])=>[key,Buffer.from(bytes).toString('base64')])));const initial=new Map(JSON.parse(await readFile(file,'utf8')));
 const snapshot=async()=>new Map(JSON.parse(await readFile(file,'utf8')));
 const start=async state=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,'normal',String(NOW),state],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});const[{port}]=await once(child,'message');return `http://127.0.0.1:${port}`;};
 const stop=async()=>{const died=once(child,'exit');child.kill('SIGKILL');await died;};
 const post=base=>fetch(base+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...BODY,videosPending:true})});
 try{
  let base=await start(mode);assert.equal((await post(base)).status,503);const failed=await snapshot();assert.equal(failed.has(META),mode==='post-save-approval-error');await stop();
  base=await start('normal');assert.equal((await post(base)).status,200);const download=await fetch(base+'/download/'+TOKEN);assert.equal(download.status,200);const body=await download.json();assert.equal(body.videoFailed,false);
  for(const[field,size,value]of [['photoUrl',32,7],['layoutVideoUrl',16,9],['storyVideoUrl',24,8]])assert.deepEqual(Buffer.from(await(await fetch(body[field])).arrayBuffer()),Buffer.alloc(size,value));
  const recovered=await snapshot();for(const[key,bytes]of initial)assert.equal(recovered.get(key),bytes);if(mode==='post-save-approval-error')assert.deepEqual(recovered,failed);
  assert.equal((await post(base)).status,200);assert.deepEqual(await snapshot(),recovered);assert.equal(recovered.get(APPROVAL),initial.get(APPROVAL));
 }finally{if(child?.exitCode===null){const died=once(child,'exit');child.kill('SIGTERM');await died;}await rm(dir,{recursive:true,force:true});}
});
