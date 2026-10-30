# Final combined patch review — HOLD

Reviewed combined snapshot `1dfbabe`, production implementation `fcac656`, and final review/evidence commit `d1ceefc`, against Capturism baseline `1f2df6401997455b456eab9b32d258b997dc4b9d`. The production patch is unchanged by this review. SHA-256: `2da6962e938fba253ffeec5cf565e10fcb2b573119281fe824e797762de26d34`.

**One open release blocker: R3, QR metadata durability.** The pool-v2 withdrawal/immutable-publication and client deadline/recovery fixes pass their local checks. No newly introduced product regression was demonstrated in the reviewed changes, but that does not make the complete QR path releasable. R3 is unchanged baseline behavior within that path.

## R3 — High: confirmation acknowledges a failed metadata write

The photo is stored successfully, then saving `sessions/<token>/meta.json` fails. In `capturism-relay/server.js`, `storeSession` catches the error at lines 1756–1757 and returns normally. `handlePhotosReady` sends HTTP 200/`ok: true`. The uploader shows its QR and clears recovery. After a relay restart, `loadSession` has no durable metadata and the actual download handler returns 404, while the photo still exists.

`audit/reproduce-qr-persistence.mjs` executes the actual confirmation/storage/load/download functions from **both baseline and candidate**, with isolated storage/auth/broadcast replacements. Both reproduce:

| Save result | Booth acknowledgement | Before restart | After restart | Stored photo |
| --- | --- | --- | --- | --- |
| Metadata write fails | 200, ok=true | Session in memory | Download 404 | Still present |

Evidence: `test-results/final-review-qr-persistence.json`. The script's successful exit proves the unsafe behavior; it is intentionally separate from the passing safety suite. There were no network/provider calls or messages.

Before release, require durable QR metadata before acknowledging confirmation, return a retryable failure otherwise, and test save failure/ambiguous acknowledgement/replay/restart against the actual relay path. Preserve original photo/token, completed PUT, video fields and retention/privacy behavior. The current client deadline does not detect a falsely successful relay response. The [audit](AUDIT.md) records R3 as open; this review does not implement an unrequested relay persistence change.

## Regression review and evidence

- **95 twin tests pass**, zero failures/skips, about 35.7 seconds. Prior QR, video, pool, ingress, withdrawal, immutable bytes, replay and restart cases remain green. Added checks exercise another due queue item despite a failed/corrupt item, receipt-write failure after remote ACK followed by recovery with one identity, and the actual HTTP router/booth-auth boundary before v2 handler entry.
- **27 targeted kiosk tests pass** across five uploader/probe/privacy/video/UI files. Actual thank-you component tests cover timeout despite touches, explicit recovery, same-session token display, five-minute privacy reset and translated help. These are not a full device/payment test suite.
- A clock-sensitive test assumed synchronous setup took zero milliseconds. It now brackets root creation with before/after timestamps, still asserts the exact two-minute default, and always cancels the pending operation in cleanup. Initial output is retained in `test-results/final-review-initial-tests.txt`; the final full suite passes without suppressed assertions.
- Kiosk TypeScript, full lint with zero warnings, production build and twin build pass. Existing large-chunk/mixed-import and Node deprecation warnings remain. Node 26 kiosk tests use `NODE_OPTIONS=--no-experimental-webstorage` for jsdom-owned localStorage.
- The exact combined patch was applied to copied baseline files in a fresh temporary directory outside Git. All **21 changed files** match candidate bytes. Evidence: `test-results/final-review-artifact.json`. No dependencies or production source changed in this review.
- Source/callers reviewed across browser upload/preparation/reset, pool enqueue/worker/receipt persistence, relay publication/withdrawal/matching/read paths, ingress/diagnostics, route authentication and deployment/launcher/backup behavior. Provider replacements model commit-time conditions; this is not a live R2 verification. Full relay startup/integrations and actual devices remain unexecuted.

Current evidence: `test-results/final-review-full-tests.txt`, `final-review-targeted.txt`, `final-review-kiosk-tests.txt`, `final-review-typecheck.txt`, `final-review-lint.txt`, `final-review-build.txt`. Earlier Chrome evidence remains historical; no new browser interaction or cloud request was needed for this review.

## Rollout and rollback changes

The [revised plan](ROLLOUT-ROLLBACK.md) now has explicit code/staging, kiosk and cloud gates, required evidence and a rollback decision matrix. Key additions:

- Fix R3 before release; separately verify real QR persistence/restart, provider ETags/conditional writes, slow-body hosting limits, key retirement and backup completeness.
- Treat kiosk startup/updater scripts as part of the release boundary. They can switch a detached or side branch back to `main`, stash tracked edits and pull newer code. Freeze automatic source mutation and prove the running artifact survives the intended restart; an arbitrary checkout followed by the stock launcher is not a rollback pin.
- Preserve v2 fences, current distributions, queue bytes and done/withdrawn receipts. A full legacy relay downgrade stays prohibited after v2 state, even with an empty queue. A rotated legacy write capability must stay retired.
- Restrict future production readiness checks to verified read-only signals. Download/admin-pool GETs can reconcile/persist data; rating/report paths have effects. Do not use them as smoke tests. Use isolated staging for fault injection and suppress real notification/report delivery there.

Actual kiosk access, Windows recovery/ACLs/launcher topology, real idle conditions, tunnel/header behavior, R2 permissions/lifecycle/revocation, Render topology/request limits and baseline dependency advisory disposition remain unverified. These are evidence gates, not completed checks. No deployment, push, device operation, credential mutation, payment/print action or client message was performed.
