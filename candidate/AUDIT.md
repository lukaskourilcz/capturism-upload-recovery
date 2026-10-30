# Complete patch audit — HOLD for release

Reviewed the combined patch against Capturism `1f2df64`, starting from local twin revision `e649a43`. Local hardening is in `0dd1d4f`. Patch SHA-256: `251d2015cc7f75fa55c0358dc2bfa4f8bf354b97087518df777a18af9d542317`.

**The candidate is not ready for production.** Passing recovery tests do not cover withdrawal and immutable portrait content. Two demonstrated release blockers remain. This audit does not deploy, push, use live credentials, exercise customer/payment workflows or send messages.

## Remaining release blockers

### R1 — High: replay recreates a withdrawn entry

Trigger: pool join commits, a response/receipt is lost, the operator deletes the entry, and the queued confirmation retries. `handlePoolJoin` checks a redeemed quiz record and the current entries map, but never checks `pool-deletions/<id>.json`. The original quiz record remains valid. The retry can recreate the entry after withdrawal.

Demonstrated with the **actual candidate handlers**, synthetic quiz data and an in-memory S3 replacement: create → admin delete → confirm deletion marker exists → replay identical join. Replay returned HTTP 200 and recreated `pool/<id>.json` while its deletion marker remained present. Reproduction: `node audit/reproduce-withdrawal.mjs`; evidence: `test-results/audit-open-reproductions.txt`.

Relevant source: `capturism-relay/pool.js`, `handlePoolJoin`, `handleAdminDelete`, `deleteEntry`, `logDeletion`; `pool-retry.cjs` treats an absent map entry as a new join. Durable replay makes this an important new release boundary even though deletion markers were already ignored by the baseline.

Required resolution: durable revocation/deletion fencing consulted during signing, joining and startup; serialize withdrawal with in-flight joins; fail closed on marker lookup/save errors. Test lost acknowledgements followed by withdrawal, concurrent join/delete, relay restart and partial deletion. Do not automatically renew consent or reconstruct withdrawn records from a queue. A small check of the in-memory map alone is insufficient.

### R2 — High: idempotent record identity does not make portrait bytes immutable

Trigger: a committed identity requests another signed upload and submits different bytes. Signing derives the same final `pool-portraits/<id>.jpg` key and still returns a PUT URL even when an entry exists. The record coordinator compares ids/key/seed, but not image content. It can reject or ignore a later join only **after** the portrait object has already been overwritten.

Demonstrated handler fact: after join succeeds, another sign request returns a PUT URL for the same final portrait key. Local mock does not contact R2, so this is code-path evidence rather than a live object overwrite. R2 documents reusable presigned URLs and last-completing-writer behavior: [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/).

Required resolution: bind content to delivery identity and prevent mutable writes to published portrait keys. Review a staged/immutable object scheme with atomic publication or an equivalent provider-supported conditional protocol. Re-signing or checking the existing map before issuing a URL does not revoke URLs already issued. Test altered bytes, simultaneous clients, expired presigns, withdrawal during PUT and stale queue restoration. This audit deliberately does not implement a partial storage/revocation redesign and label it safe.

## Fixed locally during the audit

| Finding | Trigger / impact | Fix and evidence |
| --- | --- | --- |
| Local ingress trusted only the last network hop | Vite forwards `/api` to the bridge and can itself be reached through a tunnel; remote requests appear loopback at the bridge | Shared local-request guard checks address, local Host/Origin and rejects forwarded/Cloudflare metadata. Actual HTTP tests reject cross-origin, tunnel headers and forged Host before mutation. The deployed tunnel configuration still must be checked; a reverse proxy that strips all provenance and rewrites Host/Origin cannot be distinguished by this guard. |
| Malformed JSON could escape an async relay handler | JSON `null` caused an unhandled TypeError on `data.retryVersion`, potentially terminating the relay | Object validation returns HTTP 400 for null/arrays in changed sign/join handlers. Before-fix regression failed with TypeError; after-fix test passes. |
| Recovery metadata validation covered photo bytes but not checkpoint fields | A valid JSON file could have malformed retry times, wrong entry/key or wrong seed type and still be treated as deliverable | Checks reject corrupted timing/counter fields, uploaded identity/key and receipts. Tests show corrupted records are retained as corrupt and never delivered. This is not an authenticated integrity mechanism against a malicious local account. |
| A replay with a different seed flag was acknowledged as equivalent | Existing entry retained its old flag, but caller received success for incompatible metadata | Coordinator identity comparison now includes seed; conflicting replay returns HTTP 409. |

## Validation and operational evidence

- `npm test`: **53 tests passed**. Existing tests cover real process SIGKILL during PUT, local acknowledgement loss, reconstruction from disk, duplicate handoff/confirmation, save failure, startup hydration failure, expired URLs, retry exhaustion and original queue regressions. New audit tests cover the fixed boundaries above and the relay-first / legacy-downgrade compatibility boundaries.
- Unresolved reproductions are intentionally separate audit scripts. Their success means **the unsafe behavior was reproduced**, not that release is approved. They are not hidden by a skipped test or weakened assertion.
- Candidate kiosk overlay: `tsc -b`, full lint with zero warnings, and production Vite build passed. Build reported a large JavaScript chunk warning (about 1.40 MB before gzip). Hardware/device paths were not executed.
- Changed bridge/queue/relay/diagnostic files pass Node syntax checks; actual relay handler and bridge-forwarding tests use local provider replacements. Patch applies cleanly to the captured baseline. No production dependencies or lockfiles were changed.
- Synthetic queue measurement: 20 pending 2 MiB portraits (about 53 MiB JSON) took **54/51/50 ms** for three synchronous status scans on this Mac. `status()` and worker scans read/hash queued image data. This is a measured backlog cost, not a Windows benchmark or latency guarantee. Check the real kiosk under a bounded representative backlog before release.
- Registry audit of captured production dependencies reported kiosk **14 advisories (1 critical, 11 high, 1 moderate, 1 low)** and relay **6 (3 high, 3 moderate)**. These are baseline lockfile advisories, not new packages introduced here and not an exploitability assessment. Reports: `test-results/audit-kiosk-dependencies.json`, `test-results/audit-relay-dependencies.json`. Reachability and supported upgrade choices need separate triage before accepting production risk.

## Other limits / gates

**Open, medium: the ten-minute QR upload patience is not a hard end-to-end deadline.** `uploadPhotoWithRetry` checks its deadline around outer failures, but inner signing/PUT/confirmation retries each retain independent timeouts. A first attempt can theoretically use about 315 seconds signing, 363 seconds uploading and 315 seconds confirming before returning, exceeding the thank-you page's ten-minute inactive wait. This is derived from the configured retry/timeout paths, not a measured 16-minute kiosk incident. Propagate one absolute deadline through the inner requests and expose a terminal failure/recovery state before treating the revised timer as a complete missing-QR fix. This issue does not weaken the late-token privacy guard, which still rejects ended-session tokens.

The queue is a single-writer design. The normal bridge port enforces one serving bridge, but there is no inter-process directory lock for independently launched maintenance workers. Do not run a second worker against the same folder. Distributed relay writers are not covered.

The durable guarantee starts after the bridge acknowledgement. A page closed before JPEG encoding/handoff completes can still lose the portrait. Temporary disk files are not acknowledged jobs; corrupted/blocked records are retained for review. The 24-hour automatic-delivery age limit does not delete the retained bytes. Receipt deletion or restoring stale queue backups can invalidate local duplicate history; never do that as a code rollback.

The kiosk's running revision, Node/Chrome/Windows versions, filesystem behavior, tunnel headers, current relay plan/configuration and actual after-idle behavior remain unverified. Confirm them before a rollout. The revised QR timer helps a slow upload finish but does not establish the cause of Claire's first-session-after-idle incident.

See [coverage ledger](AUDIT-COVERAGE.md) and [rollout/rollback plan](ROLLOUT-ROLLBACK.md). Release remains on hold until R1/R2 are resolved and the environment gates are met.
