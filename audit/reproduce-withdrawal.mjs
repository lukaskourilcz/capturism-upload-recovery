// Regression check for the two previously reproduced blockers. Local fixtures only.
import assert from 'node:assert/strict';
import { makeRelay, storage, call, identity, upload, uploadId } from '../test/helpers/relay-fixture.mjs';
const store = storage(), relay = makeRelay(store);
assert.equal((await upload(relay)).status, 200);
const sign = await call(relay, 'handleSignUpload', identity);
assert.equal(sign.status, 426); assert.equal(sign.body.uploadUrl, undefined);
assert.equal((await call(relay, 'handleAdminDelete', { entryId: uploadId() })).status, 200);
assert.equal((await upload(relay)).status, 410);
assert.equal((await upload(makeRelay(store))).status, 410);
assert.equal(store.objects.has(`pool-portraits/${uploadId()}.jpg`), false);
assert.equal(JSON.parse(store.objects.get(`pool/${uploadId()}.json`)).status, 'withdrawn');
console.log(JSON.stringify({ publishedWriteUrlsIssued: false, replayStatus: 410, restartReplayStatus: 410, portraitAbsent: true, canonicalTombstonePreserved: true }, null, 2));
