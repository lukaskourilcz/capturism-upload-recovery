# Idle failure investigation: local candidate

Prepared locally against Capturism `1f2df64`. No kiosk, relay, Cloudflare or client communication was changed.

## Twin experiments

Select **Local fix candidate**, leave **Include synthetic pool portrait** checked and choose:

| Preset | Injected fault | Expected result |
| --- | --- | --- |
| Healthy connection | None | QR photo and synthetic pool portrait saved |
| After idle: first signing requests fail | One HTTP 503 for each flow's signing request | One-attempt pool fails; QR uploader retries and recovers |
| After idle: first storage PUTs fail | One HTTP 503 for each flow's direct storage upload | One-attempt pool fails; QR uploader retries and recovers |
| After idle: first pool confirmation fails | Pool join HTTP 503 after portrait bytes are stored | Pool record missing, orphaned synthetic portrait remains; QR works |

Faults are consumed on first use. The next pool attempt in the same run succeeds. Starting a new test re-arms them. These are controlled first-use fault models, not a two-hour Windows/Chrome idle test and not a diagnosis of the studio hardware. No pool matching, identity or real quiz validation is performed by the local service.

`vendor/linconnu.ts` is the unchanged pool client from the downloaded commit, with its source hash in the provenance manifest. The candidate adds structured diagnostics but keeps the one-attempt behavior so failure evidence stays visible. No automatic pool retry or change to customer consent is introduced.

Browser test: a real canvas JPEG pool portrait (about 34 KiB) and a 1 MiB QR photo were uploaded in parallel at 125 KiB/s. First PUTs returned 503. Pool failed; QR became ready in approximately 10.3 seconds. The on-disk log showed `pool.put` status 503 and a subsequent successful `photo.put` and `photo.confirm`.

## Persistent kiosk diagnostics

The candidate includes `diagnostics.cjs` next to `payment-bridge.js`, and the browser helper `src/lib/diagnostics.ts`.

- Bridge: append one JSON line per completed proxied relay request, with safe stage, HTTP status, duration and optional request trace. Upstream errors and aborted responses are also recorded.
- Browser: photo sign/PUT/confirm, video enqueue and pool sign/PUT/join attempts, statuses and durations. Direct storage requests retain their original headers; no new CORS header is sent to Cloudflare.
- Rendering: start/end markers around segmentation, cloud rasterization and video composition in `Printing.tsx`. A start without an end identifies a stage that may have stalled, but the logger cannot execute while Chrome itself is frozen.
- Idle: page boot, visibility transitions and one-minute timer drift. A large drift on resume supports a suspended/throttled page hypothesis; it does not prove a particular Windows setting caused it.
- Correlation: random per-request traces are shared by browser diagnostic events and the bridge's relay HTTP record. No booth key is put in the browser. Browser event time (`clientAtMs`) and logger receipt UTC time are retained separately.

Files on the eventual kiosk would be **`diagnostic-logs/kiosk.jsonl`** beside the bridge, plus `.1` through `.4`. Rotation is at 2 MiB per file, approximately 10 MiB total. Files survive bridge and PC restarts. This is bounded disk logging, not guaranteed crash-proof storage against disk failure or sudden power loss before OS buffers reach disk.

Only an allowlist of numeric metadata, fixed stage/outcome/error labels and random traces is accepted. Photos, names, quiz codes, tokens, raw console text, request/response bodies, authorization, URLs and signed query strings are excluded. Nothing is exported to a cloud logging service. The POST collector is loopback-only at the bridge and limits batch size and body size. There is no HTTP endpoint to read logs.

Browser diagnostics use a bounded 50-event in-memory buffer and a two-second collector timeout. They do not wait before proceeding with uploads. Collector failures do not retry in a loop; future events trigger another attempt. A bridge outage or browser crash can therefore lose buffered events. Disk errors issue one local warning and do not stop customer operations.

## Local verification

Run `npm test`. Tests exercise the real pool client's request sequence (Node image rasterization is stubbed; Chrome checks real rasterization), all three first-use faults, recovery on the next attempt, QR recovery, original source hashes, rotation, redaction, reopening logs, a real bridge-worker process restart, invalid batch rejection and a genuine candidate `forwardToRelay` function against a local mock upstream. The bridge proxy test records an actual HTTP 503 with its trace without persisting body or credential values.

The complete bridge is syntax-checked but not launched on this Mac: it contains physical camera, printer and Windows integration. Its HTTP forwarding function is isolated directly from the candidate source for testing. The candidate kiosk source is overlaid on a disposable source copy for TypeScript and lint checks. `npm test` retains the existing slow-upload, deadline, confirmation-retry and video-queue regressions.

## Operator handoff, when a separate rollout is authorized

1. Establish the actual kiosk revision and verify that the reviewed patch applies to it; this candidate is based on the downloaded source, not a verified running kiosk version.
2. Review the combined `local-fix.patch`. It contains the earlier QR reliability changes and the new diagnostics. Source copies in `candidate/` are for review; they have not been installed on the kiosk.
3. Before any eventual rollout, run kiosk lint and `tsc -b`. Arrange installation and bridge restart outside opening hours, with no active session or pending card authorization. Pulling code alone does not restart the bridge.
4. On the next failure, preserve the log folder **before** restarting; also note local time, Windows/Chrome versions, connection type, power settings and relevant Windows network events. Logs do not inspect Windows power plans or Chrome Memory Saver automatically.
5. Correlate the last rendering marker, pool and photo stages, HTTP status, page visibility/drift and Render logs. Fix the failing boundary after it is identified. In particular, these modeled faults show pool failure can occur independently of missing QR, so do not assume the two always have one cause.

No deployment or client messaging is authorized or performed by these instructions.
