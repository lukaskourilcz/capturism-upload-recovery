// R10 recovery regression: all data/provider operations are synthetic and local.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, approveLegacy, TOKEN, PHOTO, BODY } from '../test/helpers/qr-relay-fixture.mjs';
import scope from '../candidate/capturism-relay/qr-media-scope.cjs';
const META=`sessions/${TOKEN}/meta.json`,APPROVAL=scope.approvalKey(TOKEN),NOW=2000000;
const hash=createHash('sha256').update(TOKEN).digest('hex'),PROOF=`qr-expiry/v1/${hash}.json`,WAIT=`qr-video-wait/v1/${hash}.json`;
const record={boothId:'synthetic-booth',photoKey:PHOTO,layoutVideoKey:'sessions/approved-old-video/video.mp4',videosPending:true,createdAt:1000000,expiresAt:87400000};
const store=storage();store.objects.set(META,JSON.stringify(record));store.objects.set(PHOTO,Buffer.alloc(32,7));store.objects.set(record.layoutVideoKey,Buffer.alloc(16,9));approveLegacy(store,TOKEN,record);
const options={now:()=>NOW};let relay=makeQrRelay(store,options);
const before=await relay.download(TOKEN);assert.equal(before.status,200);assert.ok(before.body.layoutVideoUrl?.includes(encodeURIComponent(record.layoutVideoKey)));
const authority=new Map([PROOF,WAIT,APPROVAL,PHOTO,record.layoutVideoKey].map(key=>[key,store.objects.get(key)]));
store.objects.delete(META);relay=makeQrRelay(store,options);
const replay=await relay.confirm({...BODY,videosPending:true});assert.equal(replay.status,200);
const after=await relay.download(TOKEN);assert.equal(after.status,200);assert.ok(after.body.layoutVideoUrl?.includes(encodeURIComponent(record.layoutVideoKey)));assert.equal(after.body.videoFailed,false);
relay=makeQrRelay(store,options);const restarted=await relay.download(TOKEN);assert.equal(restarted.status,200);assert.ok(restarted.body.layoutVideoUrl?.includes(encodeURIComponent(record.layoutVideoKey)));assert.equal(restarted.body.videoFailed,false);
for(const [key,bytes]of authority)assert.equal(store.objects.get(key),bytes);
const saved=JSON.parse(store.objects.get(META));assert.equal(saved.createdAt,record.createdAt);assert.equal(saved.expiresAt,record.expiresAt);assert.equal(saved.layoutVideoKey,record.layoutVideoKey);
const writes=store.writes;assert.equal((await relay.confirm({...BODY,videosPending:true})).status,200);assert.equal(store.writes,writes);
console.log(JSON.stringify({finding:'R10',status:'resolved locally',severity:'medium',interpretation:'Photo-only reconstruction recovers the exact approved legacy video, original clocks and bytes; replay and cold restart retain the mapping. Synthetic local provider only, no cloud action.',
 before:{downloadStatus:before.status,hasLegacyVideo:!!before.body.layoutVideoUrl},
 after:{confirmationStatus:replay.status,downloadStatus:after.status,hasLegacyVideo:!!after.body.layoutVideoUrl,videoFailed:after.body.videoFailed},
 restart:{downloadStatus:restarted.status,hasLegacyVideo:!!restarted.body.layoutVideoUrl,videoFailed:restarted.body.videoFailed},
 originalVideoBytesAndApprovalPreserved:true,originalClocksPreserved:true,metadataLostLegacyReference:false,replayAdditionalWrites:0,privateStorageExposure:false,cloudAccess:false},null,2));
