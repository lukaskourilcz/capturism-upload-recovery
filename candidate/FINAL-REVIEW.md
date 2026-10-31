# Final combined re-review — HOLD: QR media authorization

2026-10-31. Tested implementation `001032ea0f1c98ff61a7e157c04ee5e9b3e32b62`, based on Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Production patch SHA-256 `9675fb069a72ba1640e266becb4b917ef537e39acd2fbe1ba7c2ac60b313dcad`; 24 changed files. This fixes R8 from review `91459f0`, retaining the prior pool/QR fixes. No deployment, push, credentials, cloud/device/payment/print action or client message.

Re-reviewed snapshot `d42e15f` on 2026-10-31; implementation and 24-file patch/hash above remain unchanged. Added evidence `76a51f3`. R8 retries/overlap/restart remain valid, but **R9 high is a new release blocker**. This review changes tests and documentation only.

## R9 — High: booth-supplied media keys can expose unrelated bucket objects — OPEN

`session-metadata.cjs:125` validates video/layout/story keys as strings, but does not bind a new key to the issued token, authenticated booth or permitted media namespace. The expiry proof binds the photo identity; it does not authorize arbitrary additional media. Public download signing and `server.js:963–976` proxy subsequently trust those stored references and use the relay's storage credentials to read them.

Local actual-handler reproduction: an authenticated booth obtains its own normal photo token, confirms that photo with an unrelated object key in a video field, receives 200, then the public proxy returns the unrelated object's original bytes. All three media fields work with synthetic `subscriptions/`, `quiz-codes/` and `pool/` records. Warm and restarted relays both return 200; download signing also targets the unrelated key. The captured baseline and candidate both exhibit this inherited boundary gap. It is not a regression in discovery coalescing or clock persistence.

Prerequisites: valid booth authorization to issue/confirm the mapping, a known or guessable target key, and relay credentials able to read that object. This does not demonstrate unauthenticated mapping creation, bucket listing or live exploitation. The fixture supplies the already-authenticated booth identity; actual confirmation and public proxy code execute against isolated storage/loopback HTTP. No real credentials, cloud objects or customer data were accessed.

Before release, constrain newly accepted media references to server-authorized assets for that token/booth and media kind. Apply the shared rule to HTTP/WS/dev-seed/discovery writers and independently guard public signing/proxy reads against unsafe historical mappings. Preserve only explicitly verified legitimate legacy assets; merely existing in old metadata is not ownership evidence. Reject unrelated namespaces and foreign/expired-session references without rewriting clocks or trusted media. MIME/extension checks alone are insufficient.

Evidence: `node audit/reproduce-qr-media-scope.mjs` → `test-results/qr-final-rereview-open-media-scope.json`: six unsafe cases (baseline/candidate × three fields), original synthetic bytes exposed by public proxy before/after restart. A successful exit reproduces R9, not a fix. Production source is unchanged by this review.

## R8 — video discovery recovery — closed locally

Only confirmed HEAD 404/missing establishes absence. Read errors, denials, unknown variants, failed saves and timeouts return HTTP 503 with `retryable:true`. Mixed found/unknown scans do not publish partial success or a false negative; retry verifies and persists the result. Known durable media is reread before probing and before declaring absence, so another relay's commit can be recovered instead of trusting a stale cache.

Overlapping discovery requests for one token share one operation. A 15-second deadline settles that operation, attempts to abort HEAD requests and releases the in-flight slot. Late HEAD results cannot publish after timeout. An already-accepted metadata write may still complete; retry reconciles its durable result rather than overwriting/repeating it. The existing phone read deadline remains 20 seconds. Neither deadline is a guarantee that provider-side work has stopped.

The 20-second negative cache is now a WeakMap keyed by the validated session object. It is recorded only after successful reads and reconciliation, cannot be populated by historical metadata fields, and cannot cross from pre-grace waiting into a final failure without a fresh scan. Failed/in-flight work is never cached as absence. Confirmed absence after grace still terminates normally. Original video-wait and QR expiry clocks remain unchanged; expiry during discovery remains terminal.

## Local recovery evidence

- **169 twin tests**, **27 targeted kiosk tests**, **16 phone tests** pass. Fifteen new discovery cases plus three process-restart cases cover 403/429/500/503, mixed outcomes, failed/lost save acknowledgement, overlapping success/failure, stalled/abort-ignoring reads, late save completion, grace crossing, stale metadata, legacy probe flags and retention expiry.
- Real handler child processes return retryable failure for a read/save fault, are killed, and recover the existing video after restart. A third is killed after discovery metadata is durable but before acknowledgement; restart reads that commit without another save. Original video/photo bytes, proof, wait record and all original timestamps are preserved.
- The former R8 provider/phone probes now assert safe recovery: 503 → immediate retry → original video; overlapping readers both receive the discovered media. Historical unsafe evidence remains in `test-results/qr-clock-review-open-probe.json` and `qr-clock-review-phone-tests.txt`.
- Chrome against the local actual handler: HEAD outage at/after video grace → Try again; restore provider → same QR shows photo and video download links. The trace shows 503 → 200 and exactly one necessary discovery metadata write (three setup writes become four), with no media upload. Synthetic SVG/video bytes only; no real media, contact form or sharing action. Screenshots: `test-results/qr-discovery-retry.png`, `qr-discovery-recovered.png`; trace: `qr-discovery-browser-server.txt`. Both temporary services stopped.

## Verification and release boundary

Kiosk TypeScript/full lint/build, phone TypeScript/build/component/helper lint, twin build, candidate JavaScript syntax and isolated exact patch application pass. All 24 candidate files match. Existing build/deprecation warnings remain; no dependencies or lockfiles changed. Current summary: `audit/qr-discovery-final-rereview.json`; current outputs: `test-results/qr-discovery-rereview-*` plus the R9 reproduction. Prior fix evidence remains under `qr-discovery-*`.

R1–R8 and the kiosk upload deadline are locally closed within their tested scope. R9 remains a separate high authorization blocker; the green discovery/restart checks do not establish media ownership. This does not verify full relay integrations, real SDK/R2 behavior/paired retention/backups, physical Windows/hardware/power-loss/studio idle conditions, Render/Pages settings or dependency reachability. Coalescing is per relay process; other relays reconcile through durable conditional metadata, not a shared in-flight map.

The [rollout/rollback plan](ROLLOUT-ROLLBACK.md) marks A11 locally passed, retains isolated staging/kiosk/cloud checks, preserves both QR authority prefixes/metadata timestamps, and requires a rollback artifact retaining discovery error handling/coalescing. Do not clear media or clocks to force a retry. Release remains on hold for R9 and those environment gates. Nothing is deployed or sent.

## Additional overlap, restart and load checks

Five new positive tests pass: a different relay commits metadata during an all-missing scan; a conflicting media-key commit stays intact and retry recovers its trusted key; 50 warm and 50 cold readers each perform one discovery/save; and a process killed after verified absence discovers subsequently uploaded video on a new request. That last case intentionally tests a fresh request after restart, not indefinite phone polling beyond the configured video grace.

Local operation counts for 50 readers: warm **6 GET / 5 HEAD / 1 PUT**; cold **156 GET / 5 HEAD / 1 PUT**. Discovery/save coalescing works, while initial cold metadata hydration is not coalesced. This is a measured local provider count, not a live latency/cost/admission benchmark or a new correctness blocker. Verify cold-start SDK/hosting load and timeout behavior in staging before release. Kiosk/phone/twin typecheck/lint/build, exact artifact and all existing failures/recovery checks pass. No new browser operation or preview service was needed in this review.
