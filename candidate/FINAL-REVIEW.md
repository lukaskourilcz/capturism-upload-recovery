# Final combined verification — QR media authorization fixed locally

2026-10-31. Tested implementation `baf29cb6a32857b61e929f224491b9ef426589f9`, based on Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Production patch SHA-256 `cedda4c0d6102dbf29ce7b2ec4c9406eee6792066f79277d4c6bf0f30937a65b`; 26 changed files. This includes R9 authorization, retaining the prior pool/QR fixes. No deployment, push, credentials, cloud/device/payment/print action or client message.

Implementation `baf29cb` closes R9 locally while preserving the prior pool/QR fixes. Release remains on hold for real-environment gates.

## R9 — High: unrelated storage records exposed as QR media — resolved locally

The earlier writer accepted unrelated video/layout/story keys from an authenticated booth, then public signing/proxy read them using relay credentials. The baseline reproduction still exposes synthetic private records; the candidate now rejects those confirmations with 403 and denies pre-existing unsafe mappings with public 404, before any target-object GET. Warm caches and restarted relays enforce the same rule. No live incident or anonymous bucket enumeration was tested.

`qr-media-scope.cjs` is shared by issuance, HTTP/WS/dev-seed confirmation, discovery patches and loads. New references must use exact `sessions/<issued token>/photo.{jpg,png}`, `video.{mp4,webm}`, `layout.{mp4,webm}` or `story.{mp4,webm}` keys for the corresponding field. Immutable expiry proof still binds the authenticated booth/photo identity. Signing rejects unknown/inherited kinds and kind/content-type mismatches. Traversal, encoded paths, JSON disguises, private prefixes and unapproved foreign-session references are rejected before successful metadata/cache/notification changes.

Canonical legacy metadata remains usable with its original proof/wait-clock adoption. Noncanonical legacy media is denied by default. It requires a separate privately reviewed `qr-media-authorizations/v1/<SHA-256(token)>.json` manifest, bound to exact token hash, booth/photo identity hash, original creation/expiry and exact approved asset keys. Approval is restricted to session photo/video filename shapes; it cannot approve subscriptions, quiz codes, pool records or other namespaces. No booth/public route writes this prefix. Stored metadata and client approval flags are never authority. Other historical naming formats need separate private reconciliation; they are not silently grandfathered or rewritten.

Public loads and final signing/proxy sinks recheck authorization. Approval deletion/replacement is noticed even with a warm cache. Missing/invalid scope returns public 404; approval transport/JSON/size/ETag failures return retryable 503. Retry or restart reuses original clocks and bytes. Expiry is rechecked after delayed authorization and asset reads; an expired request cannot begin streaming. Previously issued presigned URLs, cached responses or downloaded bytes cannot be recalled by this check; review outstanding capabilities and caching in the future authorized cutover.

Seventeen focused tests cover all media fields and write callers, new/legacy/public paths, owner conflicts, forged/changed/missing approvals, outages at load and final sinks, malformed/oversized/unversioned responses, expiry, offline manifest generation and SIGKILL/restart with approval retained or removed. The offline tool writes a new 0600 file without cloud access or overwrite. Private ownership verification and protected installation remain operator gates; the tool validates structure, not studio ownership evidence.

Evidence: `audit/reproduce-qr-media-scope.mjs` → `test-results/qr-media-before-after.json` compares three vulnerable baseline cases with three blocked candidate cases, including public proxy before/after restart. `test/qr-media-scope.test.mjs` contains the positive/recovery regressions. Current summary: `audit/qr-media-validation.json`. Historical unsafe evidence remains in `test-results/qr-final-rereview-open-media-scope.json`.

## R8 — video discovery recovery — closed locally

Only confirmed HEAD 404/missing establishes absence. Read errors, denials, unknown variants, failed saves and timeouts return HTTP 503 with `retryable:true`. Mixed found/unknown scans do not publish partial success or a false negative; retry verifies and persists the result. Known durable media is reread before probing and before declaring absence, so another relay's commit can be recovered instead of trusting a stale cache.

Overlapping discovery requests for one token share one operation. A 15-second deadline settles that operation, attempts to abort HEAD requests and releases the in-flight slot. Late HEAD results cannot publish after timeout. An already-accepted metadata write may still complete; retry reconciles its durable result rather than overwriting/repeating it. The existing phone read deadline remains 20 seconds. Neither deadline is a guarantee that provider-side work has stopped.

The 20-second negative cache is now a WeakMap keyed by the validated session object. It is recorded only after successful reads and reconciliation, cannot be populated by historical metadata fields, and cannot cross from pre-grace waiting into a final failure without a fresh scan. Failed/in-flight work is never cached as absence. Confirmed absence after grace still terminates normally. Original video-wait and QR expiry clocks remain unchanged; expiry during discovery remains terminal.

## Local recovery evidence

- **186 twin tests**, **27 targeted kiosk tests**, **16 phone tests** pass. Fifteen new discovery cases plus three process-restart cases cover 403/429/500/503, mixed outcomes, failed/lost save acknowledgement, overlapping success/failure, stalled/abort-ignoring reads, late save completion, grace crossing, stale metadata, legacy probe flags and retention expiry.
- Real handler child processes return retryable failure for a read/save fault, are killed, and recover the existing video after restart. A third is killed after discovery metadata is durable but before acknowledgement; restart reads that commit without another save. Original video/photo bytes, proof, wait record and all original timestamps are preserved.
- The former R8 provider/phone probes now assert safe recovery: 503 → immediate retry → original video; overlapping readers both receive the discovered media. Historical unsafe evidence remains in `test-results/qr-clock-review-open-probe.json` and `qr-clock-review-phone-tests.txt`.
- Chrome against the local actual handler: HEAD outage at/after video grace → Try again; restore provider → same QR shows photo and video download links. The trace shows 503 → 200 and exactly one necessary discovery metadata write (three setup writes become four), with no media upload. Synthetic SVG/video bytes only; no real media, contact form or sharing action. Screenshots: `test-results/qr-discovery-retry.png`, `qr-discovery-recovered.png`; trace: `qr-discovery-browser-server.txt`. Both temporary services stopped.

## Verification and release boundary

Kiosk TypeScript/full lint/build, phone TypeScript/build/component/helper lint, twin build, candidate JavaScript syntax and isolated exact patch application pass. All 26 candidate files match. Existing build/deprecation warnings remain; no dependencies or lockfiles changed. Current summary: `audit/qr-media-validation.json`; current outputs: `test-results/qr-media-*`. Prior fix evidence remains under `qr-discovery-*`.

R1–R9 and the kiosk upload deadline are locally resolved within their tested scope. Private legacy ownership approval still requires operator evidence; existing metadata alone never proves ownership. This does not verify full relay integrations, real SDK/R2 behavior/paired retention/backups, physical Windows/hardware/power-loss/studio idle conditions, Render/Pages settings or dependency reachability. Coalescing is per relay process; other relays reconcile through durable conditional metadata, not a shared in-flight map.

The [rollout/rollback plan](ROLLOUT-ROLLBACK.md) marks A11/A12 locally passed, retains isolated staging/kiosk/cloud checks, preserves both QR clock prefixes, current legacy authorization/revocation state and metadata timestamps, and requires a rollback artifact retaining discovery error handling/coalescing. Do not clear media or clocks to force a retry. Release remains on hold for those environment and legacy cutover gates. Nothing is deployed or sent.

## Additional overlap, restart and load checks

Five new positive tests pass: a different relay commits metadata during an all-missing scan; a conflicting media-key commit stays intact and retry recovers its trusted key; 50 warm and 50 cold readers each perform one discovery/save; and a process killed after verified absence discovers subsequently uploaded video on a new request. That last case intentionally tests a fresh request after restart, not indefinite phone polling beyond the configured video grace.

Local operation counts for 50 readers: warm **6 GET / 5 HEAD / 1 PUT**; cold **156 GET / 5 HEAD / 1 PUT**. Discovery/save coalescing works, while initial cold metadata hydration is not coalesced. This is a measured local provider count, not a live latency/cost/admission benchmark or a new correctness blocker. Verify cold-start SDK/hosting load and timeout behavior in staging before release. Kiosk/phone/twin typecheck/lint/build, exact artifact and all existing failures/recovery checks pass. No new browser operation or preview service was needed in this review.

Approved legacy reads perform 3 approval GETs when cold and 2 when warm; revocation is rechecked before public signing/streaming. Canonical reads add no approval storage request. Verify real legacy volume, caching and storage permissions in staging.
