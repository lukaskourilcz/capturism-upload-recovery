// Exit zero now verifies safe R8 recovery on actual handlers. No live provider calls.
import assert from 'node:assert/strict';
import { storage } from '../test/helpers/relay-fixture.mjs';
import { makeQrRelay, TOKEN, BODY } from '../test/helpers/qr-relay-fixture.mjs';
const results = [];
const store = storage(); let clock = 1000000, heads = 0;
const options = { now: () => clock }, relay = makeQrRelay(store, options);
await relay.issue(); assert.equal((await relay.confirm({ ...BODY, videosPending: true })).status, 200);
const originalMetadata = JSON.parse(store.objects.get(`sessions/${TOKEN}/meta.json`));
const originalAuthority = [...store.objects].filter(([key]) => key.startsWith('qr-expiry/') || key.startsWith('qr-video-wait/'));
const video = `sessions/${TOKEN}/layout.mp4`; store.objects.set(video, Buffer.alloc(16, 9));
clock += 600000;
store.beforeHead = async () => { heads++; throw Object.assign(new Error('Synthetic transient provider failure'), { $metadata: { httpStatusCode: 503 } }); };
const during = await relay.download(TOKEN); assert.equal(during.status, 503);
assert.equal(during.body.retryable, true); assert.equal(during.body.videoFailed, undefined);
const callsDuringFailure = heads;
const cold = await makeQrRelay(store, options).download(TOKEN); assert.equal(cold.status, 503); assert.equal(cold.body.retryable, true);
store.beforeHead = async () => { heads++; };
clock += 1000;
const immediate = await relay.download(TOKEN); assert.ok(immediate.body.layoutVideoUrl); assert.ok(heads > callsDuringFailure);
clock += 20000;
const after = await relay.download(TOKEN); assert.equal(after.status, 200); assert.ok(after.body.layoutVideoUrl); assert.equal(after.body.videoFailed, false);
const recoveredMetadata = JSON.parse(store.objects.get(`sessions/${TOKEN}/meta.json`));
for (const field of ['createdAt', 'expiresAt', 'videoWaitStartedAt']) assert.equal(recoveredMetadata[field], originalMetadata[field]);
for (const [key, value] of originalAuthority) assert.equal(store.objects.get(key), value);
results.push({ finding: 'R8', interpretation: 'HEAD errors remain retryable; immediate recovery finds the original video.',
  duringFailure: { status: during.status, videoPending: during.body.videoPending, videoFailed: during.body.videoFailed, layoutVideoUrl: during.body.layoutVideoUrl },
  coldRestartDuringFailure: { status: cold.status, videoFailed: cold.body.videoFailed },
  afterProviderRecoveryBeforeThrottleExpires: { videoFailed: immediate.body.videoFailed, videoRecovered: !!immediate.body.layoutVideoUrl },
  afterThrottleAndExplicitRefetch: { status: after.status, videoFailed: after.body.videoFailed, videoRecovered: !!after.body.layoutVideoUrl },
  retainedClockAndExpiry: true });

// A failed discovery metadata save also sets the throttle before it succeeds.
{
  const store = storage(); let time = 1000000, fail = true;
  const relay = makeQrRelay(store, { now: () => time }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  const key = `sessions/${TOKEN}/layout.mp4`; store.objects.set(key, Buffer.alloc(16, 9)); time += 600000;
  store.beforePut = async ({ Key }) => { if (Key.endsWith('/meta.json') && fail) throw new Error('Synthetic discovery save failure'); };
  const first = await relay.download(TOKEN); assert.equal(first.status, 503);
  fail = false; time += 1000;
  const retry = await relay.download(TOKEN); assert.equal(retry.status, 200); assert.equal(retry.body.videoFailed, false); assert.ok(retry.body.layoutVideoUrl);
  results.push({ finding: 'R8', scenario: 'discovery-save-failure-then-immediate-retry', firstStatus: first.status,
    retryStatus: retry.status, retryVideoFailed: retry.body.videoFailed, videoStillPresent: store.objects.has(key),
    interpretation: 'Failed save does not poison the throttle; immediate retry persists the video.' });
}

// The throttle also skips a still-running successful discovery for another reader.
{
  const store = storage(); let time = 1000000;
  const relay = makeQrRelay(store, { now: () => time }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  const key = `sessions/${TOKEN}/layout.mp4`; store.objects.set(key, Buffer.alloc(16, 9)); time += 600000;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  store.beforeHead = async () => { entered(); await blocked; };
  const first = relay.download(TOKEN); await started;
  let settled = false;
  const concurrentRequest = relay.download(TOKEN).then(r => { settled = true; return r; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  release(); const [recovered, concurrent] = await Promise.all([first, concurrentRequest]);
  assert.equal(concurrent.status, 200); assert.equal(concurrent.body.videoFailed, false); assert.ok(concurrent.body.layoutVideoUrl); assert.ok(recovered.body.layoutVideoUrl); assert.equal(recovered.body.videoFailed, false);
  results.push({ finding: 'R8', scenario: 'concurrent-reader-during-successful-discovery', concurrentStatus: concurrent.status,
    concurrentVideoFailed: concurrent.body.videoFailed, firstReaderRecoversVideo: !!recovered.body.layoutVideoUrl,
    interpretation: 'Both readers share successful discovery; neither receives false final absence.' });
}

console.log(JSON.stringify({ finding: "R8", interpretation: "R8 fixed locally: retryable failure, durable immediate recovery, coordinated overlapping readers; synthetic local provider only.", cases: results }, null, 2));
