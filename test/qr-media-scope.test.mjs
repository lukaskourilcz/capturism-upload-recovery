import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
import { storage } from './helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO, BODY } from './helpers/qr-relay-fixture.mjs';
const META = `sessions/${TOKEN}/meta.json`, APPROVAL = scope.approvalKey(TOKEN), NOW = 2000000;
const legacy = { boothId: 'synthetic-booth', photoKey: 'sessions/legacy-session/photo.jpeg',
  videoKey: 'sessions/legacy-session/video.mp4', layoutVideoKey: 'sessions/legacy-session/layout.webm', storyVideoKey: 'sessions/legacy-session/story.mp4',
  createdAt: 1000000, expiresAt: 87400000, historicalField: 'preserve' };
const opts = { now: () => NOW };
const seed = (record = legacy, approved = true) => {
  const store = storage(); store.objects.set(META, JSON.stringify(record));
  for (const field of scope.FIELDS) if (record[field]) store.objects.set(record[field], Buffer.alloc(32, 7));
  if (approved) approveLegacy(store, TOKEN, record);
  return store;
};
async function proxy(relay, kind = 'photo', token = TOKEN) {
  const server = http.createServer((req,res) => { assert.equal(req.headers['x-booth-auth'], undefined); void relay.handleProxyAsset(req,res,token,kind); });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  try { const r = await fetch(`http://127.0.0.1:${server.address().port}/public`); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
for (const field of ['videoKey','layoutVideoKey','storyVideoKey']) test(`booth ${field} cannot delegate private, foreign, encoded or disguised objects`, async () => {
  const store = storage(), relay = makeQrRelay(store, opts); await relay.issue(); await relay.confirm(BODY);
  const original = new Map(store.objects), notices = relay.notifications.length;
  for (const key of ['subscriptions/private.json','quiz-codes/123456.json','pool/private.json','qr-expiry/v1/private.json',APPROVAL,
    'sessions/another-token/video.mp4', `sessions/${TOKEN}/layout.mp4.json`, `sessions/${TOKEN}/../private.mp4`, `sessions/${TOKEN}/%2e%2e/video.mp4`, `sessions/${TOKEN}/video.mp4?x=1`, `sessions/${TOKEN}/photo.png`]) {
    assert.equal((await relay.confirm({ ...BODY, [field]: key, approved: true, mediaAuthorization: { assets: { [field]: key } } })).status, 403, key);
    assert.deepEqual(store.objects, original); assert.equal(relay.notifications.length, notices);
    await relay.handleWsPhotosReady({ type: 'booth:photos_ready', payload: { ...BODY, [field]: key } }, 'synthetic-booth');
    assert.deepEqual(store.objects, original); assert.equal(relay.notifications.length, notices);
    const dev = await new Promise((resolve,reject) => relay.handleDevSeed({ body: { ...BODY, key: 'synthetic', boothId: 'synthetic-booth', videoKey: key }, fail: reject }, { resolve }));
    assert.equal(dev.status, 403);
  }
});

test('fresh signing, normal media, public URLs/proxy and cold replay retain exact identity and bytes', async () => {
  const store = storage(); let relay = makeQrRelay(store, opts);
  for (const [kind,contentType] of [['photo','video/mp4'],['layout','image/png'],['story','image/jpeg']]) assert.equal((await relay.sign({kind,contentType})).status,400);
  for (const kind of ['constructor','__proto__','toString','../../private']) assert.equal((await relay.sign({kind,contentType:'video/mp4'})).status,400);
  const signed = await relay.sign({kind:'photo', contentType:'image/jpeg'}); assert.equal(signed.status,200);
  const {token,key:photoKey} = signed.body; store.objects.set(photoKey,Buffer.alloc(32,7));
  const body = {token,photoKey};
  for (const [field,kind] of [['videoKey','video'],['layoutVideoKey','layout'],['storyVideoKey','story']]) {
    const media = await relay.sign({token,photoKey,kind,contentType:'video/mp4'}); assert.equal(media.status,200);
    body[field]=media.body.key; store.objects.set(media.body.key,Buffer.alloc(16,9));
  }
  assert.equal((await relay.confirm(body)).status,200); const snapshot=new Map(store.objects), writes=store.writes;
  for (const kind of ['photo','video','layout','story']) { const r=await proxy(relay,kind,token);assert.equal(r.status,200);assert.deepEqual(r.bytes,Buffer.alloc(kind==='photo'?32:16,kind==='photo'?7:9)); }
  relay=makeQrRelay(store,opts); assert.equal((await relay.download(token)).status,200);
  for (const kind of ['photo','video','layout','story']) assert.equal((await proxy(relay,kind,token)).status,200);
  assert.equal((await relay.confirm(body)).status,200); assert.deepEqual(store.objects,snapshot); assert.equal(store.writes,writes);
  assert.equal([...store.objects.keys()].some(k=>k.startsWith('qr-media-authorizations/')),false);
  const other=makeQrRelay(store,{...opts,boothId:'other-booth'}); assert.equal((await other.confirm(body)).status,409);
  assert.equal((await other.sign({token,kind:'video',contentType:'video/mp4'})).status,409);
});

for (const field of scope.FIELDS) test(`unsafe stored ${field} is denied on public read and proxy before adoption, warm or cold`, async () => {
  const target='subscriptions/synthetic-private.json', store=storage(), relay=makeQrRelay(store,opts); await relay.issue(); await relay.confirm(BODY);
  const poisoned={...JSON.parse(store.objects.get(META)),[field]:target,approved:true}; store.objects.set(META,JSON.stringify(poisoned)); store.objects.set(target,'PRIVATE');
  relay.cache.set(TOKEN,poisoned); const snapshot=new Map(store.objects); let targetReads=0;
  store.beforeGet=async ({Key})=>{ if(Key===target)targetReads++; };
  for(const r of [relay,makeQrRelay(store,opts)]) {
    assert.equal((await r.download(TOKEN)).status,404);
    for(const kind of ['photo','video','layout','story'])assert.equal((await proxy(r,kind)).status,404);
    assert.equal((await r.confirm(BODY)).status,403);
  }
  assert.equal(targetReads,0); assert.deepEqual(store.objects,snapshot);
  // Legacy without any proof must also be rejected before bootstrap writes.
  for(const key of [...store.objects.keys()])if(key.startsWith('qr-expiry/')||key.startsWith('qr-video-wait/'))store.objects.delete(key);
  const writes=store.writes; assert.equal((await makeQrRelay(store,opts).download(TOKEN)).status,404); assert.equal(store.writes,writes);
});

test('canonical legacy adopts existing clocks; noncanonical legacy needs exact operator approval', async () => {
  const canonical={...legacy,photoKey:PHOTO,videoKey:`sessions/${TOKEN}/video.mp4`,layoutVideoKey:`sessions/${TOKEN}/layout.webm`,storyVideoKey:`sessions/${TOKEN}/story.mp4`};
  for(const [record,approved,status] of [[canonical,false,200],[legacy,false,404],[legacy,true,200]]) {
    const store=seed(record,approved), original=store.objects.get(META); let relay=makeQrRelay(store,opts);
    assert.equal((await relay.download(TOKEN)).status,status);
    if(status===200) {
      for(const kind of ['photo','video','layout','story']){ const r=await proxy(relay,kind); assert.equal(r.status,200); assert.deepEqual(r.bytes,Buffer.alloc(32,7)); }
      const snapshot=new Map(store.objects); relay=makeQrRelay(store,opts);
      assert.equal((await relay.confirm({token:TOKEN,...record})).status,200); assert.equal((await relay.download(TOKEN)).status,200);
      assert.deepEqual(store.objects,snapshot); assert.equal(store.objects.get(META),original);
    } else assert.equal(store.writes,0);
  }
});

test('legacy approval is exact, revocable while warm and cannot authorize private namespaces', async () => {
  for(const mutate of [a=>{a.tokenHash='wrong';},a=>{a.identityHash='wrong';},a=>{a.createdAt++;},a=>{a.expiresAt++;},a=>{a.assets.photoKey=PHOTO;},
    a=>{a.assets.layoutVideoKey='sessions/other-session/layout.webm';},a=>{a.assets.secret='subscriptions/private.json';},a=>{a.assets.videoKey='subscriptions/private.json';}]) {
    const store=seed(), approval=JSON.parse(store.objects.get(APPROVAL)); mutate(approval); store.objects.set(APPROVAL,JSON.stringify(approval));
    assert.equal((await makeQrRelay(store,opts).download(TOKEN)).status,404); assert.equal(store.writes,0);
  }
  const store=seed(), relay=makeQrRelay(store,opts); assert.equal((await relay.download(TOKEN)).status,200);
  const approved=store.objects.get(APPROVAL), original=store.objects.get(META); store.objects.delete(APPROVAL);
  assert.equal((await relay.download(TOKEN)).status,404); assert.equal((await proxy(relay)).status,404);
  store.objects.set(APPROVAL,approved); assert.equal((await relay.download(TOKEN)).status,200);
  assert.equal((await relay.confirm({token:TOKEN,photoKey:legacy.photoKey,storyVideoKey:'sessions/unapproved-session/story.mp4'})).status,409);
  assert.equal(store.objects.get(META),original); assert.equal(store.objects.get(APPROVAL),approved);
  assert.throws(()=>scope.buildLegacyApproval(TOKEN,{...legacy,photoKey:'subscriptions/private.json'}));
});

test('approval outages at load and final public sink remain retryable, and recovery never rewrites state', async () => {
  const store=seed(), relay=makeQrRelay(store,opts); await relay.download(TOKEN); const snapshot=new Map(store.objects), bytes=store.objects.get(APPROVAL);
  for(const failure of ['outage','invalid-json','oversized','no-etag']) {
    const send=store.send.bind(store); store.send=async cmd=>{if(cmd.input.Key===APPROVAL){
      if(failure==='outage')throw new Error('private detail');
      if(failure==='no-etag'){const r=await send(cmd);delete r.ETag;return r;}
    }return send(cmd);};
    if(failure==='invalid-json')store.objects.set(APPROVAL,'{'); if(failure==='oversized')store.objects.set(APPROVAL,' '.repeat(65537));
    const r=await relay.download(TOKEN); assert.equal(r.status,503); assert.equal(r.body.retryable,true); assert.equal((await proxy(relay)).status,503);
    store.send=send; store.objects.set(APPROVAL,bytes); assert.equal((await relay.download(TOKEN)).status,200); assert.deepEqual(store.objects,snapshot);
  }
  let calls=0; store.beforeGet=async({Key})=>{if(Key===APPROVAL&&++calls===2)throw new Error('outage after load');};
  const r=await relay.download(TOKEN); assert.equal(r.status,503);assert.equal(r.body.retryable,true);
  calls=0; assert.equal((await proxy(relay)).status,503);store.beforeGet=null;assert.deepEqual(store.objects,snapshot);
});

test('approval does not extend expiry or permit adding an unapproved legacy mapping', async () => {
  const record={...legacy};delete record.storyVideoKey;const store=seed(record),relay=makeQrRelay(store,opts);await relay.download(TOKEN);
  const snapshot=new Map(store.objects);
  assert.equal((await relay.confirm({token:TOKEN,photoKey:record.photoKey,storyVideoKey:legacy.storyVideoKey})).status,403);
  assert.deepEqual(store.objects,snapshot);
  const expired=makeQrRelay(store,{now:()=>legacy.expiresAt});assert.equal((await expired.download(TOKEN)).status,404);
  assert.equal((await expired.confirm({token:TOKEN,photoKey:legacy.photoKey})).status,410); assert.deepEqual(store.objects,snapshot);
});

test('offline reviewed-approval tool creates a private manifest, never overwrites or approves private records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qr-media-approval-')), tool=resolve('candidate/capturism-relay/prepare-qr-media-approval.cjs'), input=join(dir,'reviewed.json');
  try {
    await writeFile(input,JSON.stringify({token:TOKEN,session:legacy}));const run=()=>spawnSync(process.execPath,[tool,'--reviewed',input],{cwd:dir,encoding:'utf8'});
    const r=run();assert.equal(r.status,0);const result=JSON.parse(r.stdout);assert.equal(result.uploaded,false);assert.equal(result.objectKey,APPROVAL);
    assert.equal((await stat(result.output)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await readFile(result.output,'utf8')),scope.buildLegacyApproval(TOKEN,legacy));
    assert.equal(run().status,1);
    await writeFile(input,JSON.stringify({token:'another-token',session:{...legacy,videoKey:'quiz-codes/private.json'}}));assert.equal(run().status,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

for(const approved of [true,false])test(`process replacement preserves ${approved?'approved legacy media':'denial of unapproved legacy media'}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qr-media-restart-')),file=join(dir,'provider.json'),store=seed(legacy,approved);let child;
  await writeFile(file,JSON.stringify([...store.objects].map(([k,v])=>[k,Buffer.from(v).toString('base64')])));
  const start=async()=>{child=fork(new URL('./fixtures/qr-relay-worker.mjs',import.meta.url),[file,'normal',String(NOW)],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});const[{port}]=await once(child,'message');return `http://127.0.0.1:${port}`;};
  const stop=async()=>{const exited=once(child,'exit');child.kill('SIGKILL');await exited;};
  try {
    let base=await start();const first=await fetch(base+'/download/'+TOKEN);assert.equal(first.status,approved?200:404);
    const before=await readFile(file,'utf8');await stop();base=await start();const r=await fetch(base+'/download/'+TOKEN);assert.equal(r.status,approved?200:404);
    if(approved){const body=await r.json();for(const field of ['photoUrl','videoUrl','layoutVideoUrl','storyVideoUrl'])assert.deepEqual(Buffer.from(await(await fetch(body[field])).arrayBuffer()),Buffer.alloc(32,7));}
    assert.equal(await readFile(file,'utf8'),before);await stop();
    const records=new Map(JSON.parse(before));records.delete(APPROVAL);await writeFile(file,JSON.stringify([...records]));base=await start();assert.equal((await fetch(base+'/download/'+TOKEN)).status,404);
  }finally{if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
});

// Authorization is intentionally reread so warm caches cannot outlive revocation.
test('legacy approval operation counts include live revocation checks',async()=>{
  const store=seed(),relay=makeQrRelay(store,opts),send=store.send.bind(store);let reads=0;
  store.send=async cmd=>{if(cmd.input.Key===APPROVAL)reads++;return send(cmd);};
  assert.equal((await relay.download(TOKEN)).status,200);assert.equal(reads,3);
  reads=0;assert.equal((await relay.download(TOKEN)).status,200);assert.equal(reads,2);
  console.log(JSON.stringify({scenario:'approved-legacy-download',coldApprovalGets:3,warmApprovalGets:2,reason:'authorize before legacy adoption, after load and before signing; no live latency claim'}));
});

test('slow approval or asset read crossing original expiry never begins a public stream',async()=>{
  for(const boundary of ['approval','asset']) {
    const store=seed();let clock=NOW,calls=0,targetReads=0;const relay=makeQrRelay(store,{now:()=>clock});await relay.download(TOKEN);
    store.beforeGet=async({Key})=>{
      if(Key===APPROVAL && ++calls===2 && boundary==='approval')clock=legacy.expiresAt;
      if(Key===legacy.photoKey){targetReads++;if(boundary==='asset')clock=legacy.expiresAt;}
    };
    const snapshot=new Map(store.objects),r=await proxy(relay);assert.equal(r.status,404);
    assert.equal(targetReads,boundary==='approval'?0:1);assert.deepEqual(store.objects,snapshot);
  }
});
