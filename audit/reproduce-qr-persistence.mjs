// Local before/after regression for the QR metadata acknowledgement boundary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, PHOTO, BODY } from '../test/helpers/qr-relay-fixture.mjs';
const baseline = await readFile(new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/server.js', import.meta.url), 'utf8');
const results = [];
for (const version of ['baseline','candidate']) {
  const store = storage(), options = version === 'baseline' ? { code: baseline } : {};
  const relay = makeQrRelay(store, options); store.objects.set(PHOTO, Buffer.alloc(32, 7)); store.failWrites = 1;
  const initial = await relay.confirm(BODY);
  const failedCacheEntries = relay.cache.size, failedNotifications = relay.notifications.length;
  const beforeRecovery = await makeQrRelay(store, options).download(TOKEN);
  assert.equal(initial.status, version === 'baseline' ? 200 : 503);
  assert.equal(beforeRecovery.status, 404);
  if (version === 'candidate') { assert.equal(failedCacheEntries, 0); assert.equal(failedNotifications, 0); }
  assert.equal((await relay.confirm(BODY)).status, 200);
  const restartedDownload = await makeQrRelay(store, options).download(TOKEN); assert.equal(restartedDownload.status, 200);
  results.push({ version, saveFailureResponse: initial.status, failedCacheEntries, failedNotifications,
    beforeRecoveryRestartStatus: beforeRecovery.status, recoveryResponse: 200, acknowledgedRestartDownloadStatus: restartedDownload.status, photoStillStored: store.objects.has(PHOTO) });
}
console.log(JSON.stringify({ interpretation: 'Baseline false success reproduced; candidate fails safely then persists before success. Local provider replacement only.', results }, null, 2));
