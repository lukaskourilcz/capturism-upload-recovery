// A successful exit verifies the R4/R5 local fixes; historical unsafe output is retained separately.
// Actual relay functions + local provider replacement; no provider/network calls.
import assert from 'node:assert/strict';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from '../test/helpers/qr-relay-fixture.mjs';

const key = `sessions/${TOKEN}/meta.json`;
const result = { interpretation: 'R4/R5 fixed locally; synthetic local data only. Historical unsafe output: qr-rereview-open-findings.json.' };
{
  const store = storage(); let clock = 1000000;
  store.objects.set(PHOTO, Buffer.alloc(32, 7));
  const options = { now: () => clock }, first = makeQrRelay(store, options);
  await first.issue(); assert.equal((await first.confirm(BODY)).status, 200);
  const original = JSON.parse(store.objects.get(key)); clock = original.expiresAt + 1;
  assert.equal((await first.confirm(BODY)).status, 410);
  store.objects.delete(key); // lifecycle/restore cleanup removes metadata
  const restarted = makeQrRelay(store, options), replay = await restarted.confirm(BODY);
  const download = await restarted.download(TOKEN);
  assert.equal(replay.status, 410); assert.equal(download.status, 404); assert.equal(store.objects.has(key), false);
  result.R4 = { storedExpiredReplay: 410, replayAfterMetadataRemovalAndRestart: replay.status,
    downloadStatus: download.status, expiryExtendedByMs: 0,
    photoStillStored: store.objects.has(PHOTO) };
}
{
  const store = storage(), warm = makeQrRelay(store); await warm.issue(); await warm.confirm(BODY);
  const original = store.objects.get(key);
  store.beforeGet = async () => { throw new Error('Injected transient provider read failure'); };
  assert.equal((await warm.download(TOKEN)).status, 200);
  const restarted = makeQrRelay(store), duringFailure = await restarted.download(TOKEN);
  assert.equal(duringFailure.status, 503); assert.equal(duringFailure.body.retryable, true); assert.equal(store.objects.get(key), original);
  store.beforeGet = null;
  const recovered = await restarted.download(TOKEN); assert.equal(recovered.status, 200);
  result.R5 = { warmDownloadDuringReadFailure: 200, coldDownloadDuringReadFailure: duringFailure.status,
    coldDownloadAfterProviderRecovers: recovered.status, metadataChanged: store.objects.get(key) !== original };
}
console.log(JSON.stringify(result, null, 2));
