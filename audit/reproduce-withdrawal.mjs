// Audit reproduction, intentionally demonstrates an unresolved release blocker.
// Only in-memory provider replacements and synthetic data are used.
import assert from 'node:assert/strict';
import { makeRelay, storage, call, payload, identity } from '../test/helpers/relay-fixture.mjs';
const store = storage(), relay = makeRelay(store), body = await payload(relay);
assert.equal((await call(relay, 'handlePoolJoin', body)).status, 200);
const resigned = await call(relay, 'handleSignUpload', identity);
console.log(JSON.stringify({ existingEntryGetsAnotherPutUrl: !!resigned.body.uploadUrl, samePortraitKey: resigned.body.key === body.portraitKey }));
assert.equal((await call(relay, 'handleAdminDelete', { entryId: body.entryId })).status, 200);
await new Promise(r => setTimeout(r, 20));
assert.equal(store.objects.has(`pool/${body.entryId}.json`), false);
assert.equal(store.objects.has(`pool-deletions/${body.entryId}.json`), true);
const replay = await call(relay, 'handlePoolJoin', body);
console.log(JSON.stringify({ replayStatus: replay.status, recordRecreated: store.objects.has(`pool/${body.entryId}.json`), deletionMarkerStillPresent: store.objects.has(`pool-deletions/${body.entryId}.json`) }, null, 2));
assert.equal(replay.status, 200);
assert.equal(store.objects.has(`pool/${body.entryId}.json`), true);
