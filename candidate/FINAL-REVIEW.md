# Final combined verification — discovery blocker fixed locally; release gated

2026-10-31. Tested implementation `001032ea0f1c98ff61a7e157c04ee5e9b3e32b62`, based on Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Production patch SHA-256 `9675fb069a72ba1640e266becb4b917ef537e39acd2fbe1ba7c2ac60b313dcad`; 24 changed files. This fixes R8 from review `91459f0`, retaining the prior pool/QR fixes. No deployment, push, credentials, cloud/device/payment/print action or client message.

## R8 — video discovery recovery — closed locally

Only confirmed HEAD 404/missing establishes absence. Read errors, denials, unknown variants, failed saves and timeouts return HTTP 503 with `retryable:true`. Mixed found/unknown scans do not publish partial success or a false negative; retry verifies and persists the result. Known durable media is reread before probing and before declaring absence, so another relay's commit can be recovered instead of trusting a stale cache.

Overlapping discovery requests for one token share one operation. A 15-second deadline settles that operation, attempts to abort HEAD requests and releases the in-flight slot. Late HEAD results cannot publish after timeout. An already-accepted metadata write may still complete; retry reconciles its durable result rather than overwriting/repeating it. The existing phone read deadline remains 20 seconds. Neither deadline is a guarantee that provider-side work has stopped.

The 20-second negative cache is now a WeakMap keyed by the validated session object. It is recorded only after successful reads and reconciliation, cannot be populated by historical metadata fields, and cannot cross from pre-grace waiting into a final failure without a fresh scan. Failed/in-flight work is never cached as absence. Confirmed absence after grace still terminates normally. Original video-wait and QR expiry clocks remain unchanged; expiry during discovery remains terminal.

## Local recovery evidence

- **164 twin tests**, **27 targeted kiosk tests**, **16 phone tests** pass. Fifteen new discovery cases plus three process-restart cases cover 403/429/500/503, mixed outcomes, failed/lost save acknowledgement, overlapping success/failure, stalled/abort-ignoring reads, late save completion, grace crossing, stale metadata, legacy probe flags and retention expiry.
- Real handler child processes return retryable failure for a read/save fault, are killed, and recover the existing video after restart. A third is killed after discovery metadata is durable but before acknowledgement; restart reads that commit without another save. Original video/photo bytes, proof, wait record and all original timestamps are preserved.
- The former R8 provider/phone probes now assert safe recovery: 503 → immediate retry → original video; overlapping readers both receive the discovered media. Historical unsafe evidence remains in `test-results/qr-clock-review-open-probe.json` and `qr-clock-review-phone-tests.txt`.
- Chrome against the local actual handler: HEAD outage at/after video grace → Try again; restore provider → same QR shows photo and video download links. The trace shows 503 → 200 and exactly one necessary discovery metadata write (three setup writes become four), with no media upload. Synthetic SVG/video bytes only; no real media, contact form or sharing action. Screenshots: `test-results/qr-discovery-retry.png`, `qr-discovery-recovered.png`; trace: `qr-discovery-browser-server.txt`. Both temporary services stopped.

## Verification and release boundary

Kiosk TypeScript/full lint/build, phone TypeScript/build/component/helper lint, twin build, candidate JavaScript syntax and isolated exact patch application pass. All 24 candidate files match. Existing build/deprecation warnings remain; no dependencies or lockfiles changed. Summary: `audit/qr-discovery-validation.json`; detailed outputs: `test-results/qr-discovery-*`.

R1–R8 and the kiosk upload deadline are locally closed within their tested scope. No further blocker was demonstrated in those paths. This does not verify full relay integrations, real SDK/R2 behavior/paired retention/backups, physical Windows/hardware/power-loss/studio idle conditions, Render/Pages settings or dependency reachability. Coalescing is per relay process; other relays reconcile through durable conditional metadata, not a shared in-flight map.

The [rollout/rollback plan](ROLLOUT-ROLLBACK.md) marks A11 locally passed, retains isolated staging/kiosk/cloud checks, preserves both QR authority prefixes/metadata timestamps, and requires a rollback artifact retaining discovery error handling/coalescing. Do not clear media or clocks to force a retry. Nothing is deployed or sent.
