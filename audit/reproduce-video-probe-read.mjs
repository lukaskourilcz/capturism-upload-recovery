// Exit zero means OPEN R8 was reproduced, not fixed. No live provider calls.
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
const during = await relay.download(TOKEN); assert.equal(during.status, 200);
assert.equal(during.body.videoPending, false); assert.equal(during.body.videoFailed, true); assert.equal(during.body.layoutVideoUrl, null);
const callsDuringFailure = heads;
const cold = await makeQrRelay(store, options).download(TOKEN); assert.equal(cold.status, 200); assert.equal(cold.body.videoFailed, true);
store.beforeHead = async () => { heads++; };
clock += 1000;
const immediate = await relay.download(TOKEN); assert.equal(immediate.body.layoutVideoUrl, null); assert.equal(heads, callsDuringFailure + 6);
clock += 20000;
const after = await relay.download(TOKEN); assert.equal(after.status, 200); assert.ok(after.body.layoutVideoUrl); assert.equal(after.body.videoFailed, false);
const recoveredMetadata = JSON.parse(store.objects.get(`sessions/${TOKEN}/meta.json`));
for (const field of ['createdAt', 'expiresAt', 'videoWaitStartedAt']) assert.equal(recoveredMetadata[field], originalMetadata[field]);
for (const [key, value] of originalAuthority) assert.equal(store.objects.get(key), value);
results.push({ finding: 'R8', interpretation: 'Transient HEAD errors silently look like absent video and stop normal phone polling; unsafe behavior reproduced, not fixed.',
  duringFailure: { status: during.status, videoPending: during.body.videoPending, videoFailed: during.body.videoFailed, layoutVideoUrl: during.body.layoutVideoUrl },
  coldRestartDuringFailure: { status: cold.status, videoFailed: cold.body.videoFailed },
  afterProviderRecoveryBeforeThrottleExpires: { videoFailed: immediate.body.videoFailed, newHeadRequests: 0 },
  afterThrottleAndExplicitRefetch: { status: after.status, videoFailed: after.body.videoFailed, videoRecovered: !!after.body.layoutVideoUrl },
  retainedClockAndExpiry: true });

// A failed discovery metadata save also sets the throttle before it succeeds.
{
  const store = storage(); let time = 1000000, fail = true;
  const relay = makeQrRelay(store, { now: () => time }); await relay.issue(); await relay.confirm({ ...BODY, videosPending: true });
  const key = `sessions/${TOKEN}/layout.mp4`; store.objects.set(key, Buffer.alloc(16, 9)); time += 600000;
  store.beforePut = async ({ Key }) => { if (Key.endsWith('/meta.json') && fail) throw new Error('Synthetic discovery save failure'); };
  const first = await relay.download(TOKEN); assert.equal(first.status, 500);
  fail = false; time += 1000;
  const retry = await relay.download(TOKEN); assert.equal(retry.status, 200); assert.equal(retry.body.videoFailed, true); assert.equal(retry.body.layoutVideoUrl, null);
  results.push({ finding: 'R8', scenario: 'discovery-save-failure-then-immediate-retry', firstStatus: first.status,
    retryStatus: retry.status, retryVideoFailed: retry.body.videoFailed, videoStillPresent: store.objects.has(key),
    interpretation: 'Failed discovery save poisons throttle; recovered provider still looks like absent video on immediate retry.' });
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
  const concurrent = await relay.download(TOKEN);
  assert.equal(concurrent.status, 200); assert.equal(concurrent.body.videoFailed, true); assert.equal(concurrent.body.layoutVideoUrl, null);
  release(); const recovered = await first; assert.ok(recovered.body.layoutVideoUrl); assert.equal(recovered.body.videoFailed, false);
  results.push({ finding: 'R8', scenario: 'concurrent-reader-during-successful-discovery', concurrentStatus: concurrent.status,
    concurrentVideoFailed: concurrent.body.videoFailed, firstReaderRecoversVideo: !!recovered.body.layoutVideoUrl,
    interpretation: 'A second reader is told the video failed while another reader is still successfully discovering it.' });
}

console.log(JSON.stringify({ finding: "R8", interpretation: "Unsafe video-discovery outcomes reproduced, not fixed; synthetic local provider only.", cases: results }, null, 2));
