# Complete patch audit — R1/R2 resolved locally; release still gated

Reviewed against Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Tested implementation: local twin commit `8f738df0ff676d670820f6bc1d5ba7947921a1fb` (following audit hardening `0dd1d4f`). Combined patch SHA-256: `05491c49a8ab2286f46eade8cc716047d6bd2c52a72957f159d3bbb90b45442d`.

**Both demonstrated high-severity blockers are closed in the local candidate. This is not production release approval.** The fix introduces pool publication protocol 2 and requires a coordinated, quiescent cutover. Existing mutable upload links must be retired before enabling it. No production credentials, customer workflows, device operations, deployment, push or client messages were used.

## R1 — High: withdrawn entry recreated by replay — resolved locally

The previous reproduction created an entry, deleted it, then replayed an uncertain confirmation. The relay ignored `pool-deletions/<id>.json` and recreated personal data from the still-valid redeemed quiz record.

`pool-publication.cjs` now permanently occupies the canonical entry slot with a minimal withdrawn tombstone before acknowledging deletion. Reservation, publication, metadata updates, startup, listing and portrait reads enforce durable withdrawal. The canonical object uses conditional writes, so a stale publication cannot replace a newer tombstone even from another relay. Existing deletion markers also fence restored old records. Withdrawal removes personal metadata and image bytes; only id/status/time/image extension remain in the canonical object. Cleanup failure returns 503 and is recoverable; an initial tombstone failure is never acknowledged as successful deletion.

Evidence from actual candidate handlers: withdrawal before body completion; deletion racing metadata publication and a delayed portrait PUT across relays; partial marker/image deletion failure; unavailable deletion lookup; stale-cache metadata writes; stale backup restoration; relay restart and orphan cleanup. Queue restoration after withdrawal receives a protocol-bound 410, stores a withdrawn receipt and scrubs local photo/code/session. A generic 410 retains the portrait for review. See `test/pool-relay.test.mjs`, `test/pool-queue.test.mjs` and `test-results/publication-v2-full-tests.txt`.

## R2 — High: retries can overwrite published portrait bytes — resolved locally

Previously, signing again returned a reusable PUT URL for the same published key. Record idempotency could not prevent the earlier pixel overwrite.

The bridge now sends bytes through authenticated `/api/booth/pool/upload`; the relay binds the stable identity to the SHA-256 image digest, creates the final image only with `If-None-Match: *`, and publishes metadata with an ETag condition. Existing images are verified and reused; committed replays only acknowledge the original record. Old sign/join routes return 426 and issue no upload capability. Legacy committed entries without a digest are checked against stored bytes and retain original metadata. Consent and distribution history are preserved.

Tests cover simultaneous same-identity requests, competing relays with different pixels, changed digest/seed, falsely declared content, metadata-save failure, lost provider acknowledgement, restart with retired/distributed records and old uploaded checkpoint migration. Repeated publication commits one portrait without overwrite. Conditional PutObject semantics are documented by Cloudflare: [R2 S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/). They are modeled locally, not verified against live R2.

`node audit/reproduce-withdrawal.mjs` now asserts the safe outcomes. Its saved output `test-results/publication-blocker-regressions.json` reports no published-key write URL, replay/restart HTTP 410, portrait absent and tombstone preserved. The previous unsafe evidence remains historical in `test-results/audit-open-reproductions.txt`.

## Earlier audit fixes retained

| Finding | Fix and local evidence |
| --- | --- |
| Loopback last hop could hide remote ingress | Shared guard checks address, local Host/Origin and rejects forwarded/Cloudflare metadata before mutation. Actual HTTP tests cover cross-origin, tunnel headers and forged Host. A proxy stripping all provenance still requires topology verification. |
| Malformed pool JSON escaped async handlers | New upload metadata is bounded and validated; malformed/null/version mismatch returns 400. Removed sign/join write handlers reject legacy requests with 426. |
| Recovery metadata could redirect or bypass expiry | Checkpoint identity, key, seed, counters/times, digests and terminal receipts are checked. Corrupt records are retained and never delivered. This is not protection against a malicious local account. |
| Changed seed replay acknowledged as equivalent | Durable reservation binds seed and digest; conflicting replays return 409. |

## Final local validation

- **71 tests passed**, zero failures/skips, approximately 37 seconds. Includes original QR/video regressions, five after-idle pool faults, disk/checkpoint recovery, actual bridge SIGKILL, browser disappearance and lost acknowledgements, withdrawal and immutable publication. No tests were suppressed to close these findings.
- Refreshed Chrome prototype: local acceptance → protected pool publication at 16.4 seconds → done receipt at 16.5 seconds; QR at 1.6 seconds. Bridge restarted at 25.4 seconds; read-only state still showed one entry, one publication event and the same done receipt. Synthetic data, healthy local link; not a studio benchmark. Evidence: `test-results/browser-publication-v2.json` and `test-results/publication-v2-browser.png`.
- Final kiosk overlay passed `tsc -b`, full lint with zero warnings and production Vite build. Twin build and all candidate JavaScript syntax checks passed. Build retains existing large-chunk/mixed-import warnings (main JavaScript about 1.40 MB before gzip) and a Node loader deprecation warning.
- Regenerated `local-fix.patch` passes `git apply --check` against the captured baseline. No production dependencies or lockfiles changed. The complete relay HTTP server and real provider were not executed; actual pool handlers use injected local S3/quiz replacements with commit-time ETag conditions. Queue tests also use a disk-backed local substitute.
- Earlier synthetic backlog measurement remains applicable to local scans: 20 pending 2 MiB portraits (about 53 MiB JSON), three synchronous status scans at **54/51/50 ms** on this Mac. This is not a Windows benchmark. New relay-hop performance and startup reconciliation volume are unmeasured at studio scale.
- Captured baseline dependency audits remain untriaged: kiosk **14 advisories (1 critical, 11 high, 1 moderate, 1 low)**; relay **6 (3 high, 3 moderate)**. These are registry/lockfile findings, not an exploitability assessment. Saved reports: `test-results/audit-kiosk-dependencies.json`, `test-results/audit-relay-dependencies.json`.

## Remaining issues and release gates

**Open, medium: QR patience is not a hard end-to-end deadline.** The ten-minute outer upload budget does not cap the independent inner sign/PUT/confirm retries. One theoretical attempt can take about 315 + 363 + 315 seconds before returning, exceeding the thank-you wait. This is code-derived, not a measured studio incident. Propagating one absolute deadline and exposing terminal recovery remains separate work. The ended-session token guard still applies.

**Coordinated protocol cutover is mandatory.** Stop legacy writers and settle outstanding published-key presigns before enabling collection. This patch cannot revoke already-issued URLs or protect against old relay code deliberately restored over the new state. Retire the old provider write capability using an authorized, rehearsed maintenance procedure. Do not restore an older pool snapshot over newer tombstones/distributions. Rolling back must retain protocol-2-compatible fences and receipt handling.

Image deletion and metadata publication are not an atomic multi-object transaction. A crash after a late image commit can leave a private orphan; it cannot be published or served while the canonical tombstone remains. Startup/withdrawal retry reconciles it. Existing downloaded or already-streaming images cannot be recalled. Verify and monitor cleanup in staging; do not interpret a 503 withdrawal as completion.

The bridge queue remains single-writer, with durability beginning after local acknowledgement. Do not launch another worker against its folder, clear receipts, re-identify jobs or restore stale backups. Page closure before JPEG handoff, catastrophic disk failure and physical Windows power loss remain outside demonstrated durability. Corrupt/blocked/older-than-24h jobs retain bytes for review; no consent is renewed automatically.

Actual kiosk SHA, Node/Chrome/Windows/filesystem, tunnel rewrites, R2 conditional permissions/lifecycle/key rotation, Render request limits/topology and real after-idle behavior remain unverified. Baseline critical/high advisories need disposition. The new relay hop is bounded to two concurrent 20 MiB bodies, but real slow-network hosting behavior still needs staging. These gates keep production release on hold without reopening the now-passing local R1/R2 regressions.

See [protocol and failure boundaries](PUBLICATION-FENCING.md), [coverage ledger](AUDIT-COVERAGE.md) and [rollout/rollback plan](ROLLOUT-ROLLBACK.md).
