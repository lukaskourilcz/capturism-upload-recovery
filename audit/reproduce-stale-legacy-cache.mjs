// R11: synthetic provider and actual public handlers over loopback HTTP only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO, BODY } from '../test/helpers/qr-relay-fixture.mjs';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),NOW=2000000;
const hash=createHash('sha256').update(TOKEN).digest('hex'),PROOF=`qr-expiry/v1/${hash}.json`,WAIT=`qr-video-wait/v1/${hash}.json`;
const record={boothId:'synthetic-booth',photoKey:PHOTO,layoutVideoKey:'sessions/old-legacy-video/video.mp4',videosPending:true,createdAt:1000000,expiresAt:87400000};
async function proxy(relay){
 const server=http.createServer((req,res)=>{assert.equal(req.headers['x-booth-auth'],undefined);void relay.handleProxyAsset(req,res,TOKEN,'photo');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/photo`);return {status:r.status,bytes:Buffer.from(await r.arrayBuffer())};}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const cases=[];
for(const revocation of ['removed','narrowed']){
 const store=storage();store.objects.set(META,JSON.stringify(record));store.objects.set(PHOTO,Buffer.alloc(32,7));store.objects.set(record.layoutVideoKey,Buffer.alloc(16,9));approveLegacy(store,TOKEN,record);
 const opts={now:()=>NOW},stale=makeQrRelay(store,opts);assert.equal((await stale.download(TOKEN)).status,200);assert.equal((await proxy(stale)).status,200);
 const retained=new Map([PROOF,WAIT,PHOTO,record.layoutVideoKey].map(key=>[key,store.objects.get(key)]));store.objects.delete(META);
 if(revocation==='removed')store.objects.delete(APPROVAL);else{const approval=JSON.parse(store.objects.get(APPROVAL));delete approval.assets.layoutVideoKey;store.objects.set(APPROVAL,JSON.stringify(approval));}
 const recovered=makeQrRelay(store,opts),confirmation=await recovered.confirm({...BODY,videosPending:true});assert.equal(confirmation.status,200);
 const canonical=JSON.parse(store.objects.get(META));assert.equal(canonical.photoKey,PHOTO);assert.equal(canonical.layoutVideoKey,undefined);
 const snapshot=new Map(store.objects),writes=store.writes;let oldVideoGets=0;store.beforeGet=async({Key})=>{if(Key===record.layoutVideoKey)oldVideoGets++;};
 const recoveredRead=await recovered.download(TOKEN),recoveredProxy=await proxy(recovered);assert.equal(recoveredRead.status,200);assert.equal(recoveredRead.body.layoutVideoUrl,null);assert.deepEqual(recoveredProxy.bytes,Buffer.alloc(32,7));
 const warmRead=await stale.download(TOKEN),warmRetry=await stale.download(TOKEN),warmProxy=await proxy(stale);assert.equal(warmRead.status,404);assert.equal(warmRetry.status,404);assert.equal(warmProxy.status,404);
 const cold=makeQrRelay(store,opts);assert.equal((await cold.download(TOKEN)).status,200);assert.deepEqual((await proxy(cold)).bytes,Buffer.alloc(32,7));
 stale.cache.delete(TOKEN);assert.equal((await stale.download(TOKEN)).status,200);assert.deepEqual((await proxy(stale)).bytes,Buffer.alloc(32,7));
 assert.equal(oldVideoGets,0);assert.equal(store.writes,writes);assert.deepEqual(store.objects,snapshot);for(const[key,bytes]of retained)assert.equal(store.objects.get(key),bytes);
 cases.push({revocation,confirmationStatus:confirmation.status,recoveredRelayDownload:recoveredRead.status,recoveredRelayPhotoProxy:recoveredProxy.status,staleRelayDownload:warmRead.status,staleRelayRepeatedDownload:warmRetry.status,staleRelayPhotoProxy:warmProxy.status,freshRelayDownload:200,afterLocalCacheEvictionDownload:200,revokedVideoObjectReads:oldVideoGets,originalClocksAndMediaPreserved:true,publicReadWrites:0});
}
console.log(JSON.stringify({finding:'R11',status:'OPEN',severity:'medium',interpretation:'A stale denied legacy cache masks a valid recovered canonical photo mapping. Repeated public reads remain terminal 404 until cache eviction/restart, while another relay serves 200. Revoked video is never read; no unrelated object exposure or live incident claimed.',cases},null,2));
