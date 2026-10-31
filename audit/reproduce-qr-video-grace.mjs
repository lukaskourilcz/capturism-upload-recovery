// Successful exit now verifies the restored video grace on actual handlers.
// Compare actual captured and candidate handlers with synthetic local storage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, BODY } from '../test/helpers/qr-relay-fixture.mjs';
const baseline = await readFile(new URL('../../diagnosis-2026-10-30/capturism-main/capturism-relay/server.js', import.meta.url), 'utf8');
const start = 1000000, minute = 60000, results = [];
for (const version of ['baseline', 'candidate']) {
  let clock = start;
  const store = storage(), options = { now: () => clock, ...(version === 'baseline' ? { code: baseline } : {}) };
  const relay = makeQrRelay(store, options);
  if (version === 'candidate') await relay.issue();
  clock += 9 * minute; // slow photo transfer/confirmation, within the kiosk's 10m budget
  assert.equal((await relay.confirm({ ...BODY, videosPending: true })).status, 200);
  clock = start + 11 * minute; // only 2m after first successful photo confirmation
  const response = await relay.download(TOKEN); assert.equal(response.status, 200);
  assert.equal(response.body.videoPending, true);
  assert.equal(response.body.videoFailed, false);
  const cold = await makeQrRelay(store, options).download(TOKEN);
  assert.equal(cold.body.videoPending, response.body.videoPending);
  results.push({ version, photoConfirmedAfterMinutes: 9, downloadAfterConfirmationMinutes: 2,
    videoPending: response.body.videoPending, videoFailed: response.body.videoFailed,
    coldVideoPending: cold.body.videoPending, qrUnexpired: Date.parse(response.body.expiresAt) > clock });
}
console.log(JSON.stringify({ finding: 'R7', interpretation: 'Fixed locally: both versions keep waiting two minutes after a slow first photo confirmation; candidate retention remains based on original issuance.', results }, null, 2));
