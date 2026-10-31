# Combined patch audit — HOLD: stalled phone reads and video wait regression

Reviewed against Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Tested combined implementation: local twin commit `485d20a47435462a0ddc566b88cfb6be2c78d3f2`, retaining the pool-v2 and QR deadline work. Production patch SHA-256: `3c54fdc8c290fdd8a8666dd205d5d9e73aaab8e7bb0b48c62ddab98d09f345fd` (23 changed files).

**Re-review 2026-10-31: R6 (medium stalled phone reads) and R7 (medium video wait regression) remain open.** R1–R5 and the shared kiosk upload deadline remain valid within their tested scope. Production implementation/patch are unchanged. 132 twin tests, 27 targeted kiosk tests and 7 positive phone tests pass; separate unsafe reproductions demonstrate the new findings. No deployment, push, provider/device/payment/print action, credential access or client message was performed.

## R1 — High: withdrawn entry recreated by replay — resolved locally

The previous reproduction created an entry, deleted it, then replayed an uncertain confirmation. The relay ignored `pool-deletions/<id>.json` and recreated personal data from the still-valid redeemed quiz record.

`pool-publication.cjs` now permanently occupies the canonical entry slot with a minimal withdrawn tombstone before acknowledging deletion. Reservation, publication, metadata updates, startup, listing and portrait reads enforce durable withdrawal. The canonical object uses conditional writes, so a stale publication cannot replace a newer tombstone even from another relay. Existing deletion markers also fence restored old records. Withdrawal removes personal metadata and image bytes; only id/status/time/image extension remain in the canonical object. Cleanup failure returns 503 and is recoverable; an initial tombstone failure is never acknowledged as successful deletion.

Evidence from actual candidate handlers: withdrawal before body completion; deletion racing metadata publication and a delayed portrait PUT across relays; partial marker/image deletion failure; unavailable deletion lookup; stale-cache metadata writes; stale backup restoration; relay restart and orphan cleanup. Queue restoration after withdrawal receives a protocol-bound 410, stores a withdrawn receipt and scrubs local photo/code/session. A generic 410 retains the portrait for review. See `test/pool-relay.test.mjs`, `test/pool-queue.test.mjs` and `test-results/publication-v2-full-tests.txt`.

## R2 — High: retries can overwrite published portrait bytes — resolved locally

Previously, signing again returned a reusable PUT URL for the same published key. Record idempotency could not prevent the earlier pixel overwrite.

The bridge now sends bytes through authenticated `/api/booth/pool/upload`; the relay binds the stable identity to the SHA-256 image digest, creates the final image only with `If-None-Match: *`, and publishes metadata with an ETag condition. Existing images are verified and reused; committed replays only acknowledge the original record. Old sign/join routes return 426 and issue no upload capability. Legacy committed entries without a digest are checked against stored bytes and retain original metadata. Consent and distribution history are preserved.

Tests cover simultaneous same-identity requests, competing relays with different pixels, changed digest/seed, falsely declared content, metadata-save failure, lost provider acknowledgement, restart with retired/distributed records and old uploaded checkpoint migration. Repeated publication commits one portrait without overwrite. Conditional PutObject semantics are documented by Cloudflare: [R2 S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/). They are modeled locally, not verified against live R2.

`node audit/reproduce-withdrawal.mjs` now asserts the safe outcomes. Its saved output `test-results/publication-blocker-regressions.json` reports no published-key write URL, replay/restart HTTP 410, portrait absent and tombstone preserved. The previous unsafe evidence remains historical in `test-results/audit-open-reproductions.txt`.

## QR deadline — Medium: nested timeouts exceed the wait — resolved locally

Previously, signing, PUT and confirmation each received independent retry budgets; a theoretical attempt could outlast the ten-minute thank-you window. `uploadDeadline.ts` now creates one absolute budget at `uploadSessionToCloud` entry. Every request, response-body read, inner/outer retry and sleep uses its remaining time. Abort and promise settlement prevent a stalled or non-cooperative response from returning a late token. The background maximum is ten minutes; the legacy one-pass caller has a two-minute total ceiling without automatic outer retries. Video bridge delivery remains independent of QR readiness.

Expiry publishes a failed state with a **Retry download** control instead of endless preparation or immediate session loss. The thank-you screen uses the actual upload deadline, unaffected by touches; failure or token arrival opens a fresh five-minute inactivity window. Explicit recovery starts a new bounded window using the same prepared JPEG/token and skips PUT if already successful. It invokes only upload/confirmation, never print/payment actions. If no prepared JPEG exists, the screen gives studio-help instructions. Reset cancels the request and drops recovery references; printing callers capture the epoch before preparation to reject old prepared photos after reset. QR recovery is memory-only for the current page/session, not a new durable photo queue.

Evidence: stalled sign/PUT/confirm and body reads; total-budget backoff; expired confirmation without another PUT; repeated retry taps; reset/late-result guards; real local slow HTTP upload and first-use sign/PUT/confirm/save/lost-ACK faults; React interaction/timer tests including French/English/Korean help. Chrome with 1 MiB at 125 KiB/s plus first PUT failure showed timeout at experiment 2.2s for a 2s network budget; explicit recovery completed in about 8.9s with the original token and one session. Trace: `test-results/qr-browser-recovery.json`; screenshots: `qr-timeout-browser.png`, `qr-recovery-browser.png` under `test-results/`.

This bounds client waiting and QR publication. Already-accepted provider work may finish after abort; local Chrome also showed delayed server-side cancellation. The retry reconciles with the same identity/bytes. Main-thread freezing cannot be interrupted by JavaScript; deadline/current-session checks still reject a stale result on resumption. Rendering/JPEG/video preparation happens before the network budget and has a separate thank-you-page watchdog with a help state; physical rendering/hardware behavior remains unverified. See [QR deadline contract](QR-DEADLINE.md).

## R3 — High: QR success before durable metadata — resolved locally

The baseline stored a session in memory, swallowed a failed `sessions/<token>/meta.json` write and returned 200/ok. A relay restart then made the download return 404 while its photo still existed. This remains demonstrated against the unchanged baseline in `audit/reproduce-qr-persistence.mjs`; the candidate now returns 503 with no successful cache entry or admin notification until persistence is confirmed.

`session-metadata.cjs` is the shared writer for HTTP confirmation, WebSocket photos-ready, dev seed and video-discovery patches. New metadata uses conditional create; updates use the durable object's ETag. Writers reread durable state after taking a per-token lock, and retry bounded condition conflicts. A successful PUT, or a fresh read proving an identical operation already committed, precedes cache promotion and success acknowledgement. Storage/read/schema failures do not become new sessions. Unknown provider outcomes return a retryable failure; retry reuses the same token and completed photo PUT.

Replay preserves the original photo/booth identity, existing video keys, unknown historical fields and createdAt/expiresAt. Concurrent relays merge separate video updates without replacing one another's metadata. An expired stored session returns 410 rather than renewing its life; the client treats that response as permanent. Expiry is rechecked after a slow save as well. Video discovery no longer mutates the successful cache before a durable write. HTTP/WS notifications happen after the durable boundary and use committed media fields; this is not an exactly-once notification protocol.

Actual relay handler tests cover failed save, lost provider acknowledgement, photo-only replay after video delivery, concurrent writers, failed discovery patch, missing/read-failing/corrupt storage, malformed requests, identity conflicts and retention expiry. A real client over local HTTP receives 503 then 200 and performs one sign/PUT, including deadline-then-manual recovery. A relay handler child process is killed with SIGKILL after acknowledging success; a fresh process reads a disk-backed provider replacement and serves the original photo through its recovered download metadata. The provider replacement is a test fixture, not R2; this is not a physical Windows power-loss test.

Before/after evidence: `test-results/qr-metadata-before-after.json`. Baseline: 200 on failed save, cache/notice present, restart before recovery 404. Candidate: 503, no successful cache/notice, then retry 200 and download 200 after restart. Regression script success now means these expected before/after assertions pass. Original unsafe review evidence remains historical in `test-results/final-review-qr-persistence.json`.

The twin now uses the same metadata writer for QR confirmation and an actual metadata-write fault in `qr_idle_save`; cache-only relay restart is modeled separately from bridge restart. Its API/storage/auth remain substitutes; actual server functions are exercised by the new fixtures. See [QR metadata contract](QR-METADATA.md).

## R4 — High: cleanup could renew an expired QR — resolved locally

The old helper interpreted missing `sessions/<token>/meta.json` as a new session, so cleanup followed by delayed confirmation could give an expired token another 24 hours. Historical actual-handler evidence is retained in `test-results/qr-rereview-open-findings.json`: replay/download 200 after metadata removal and restart, with expiry extended by 86,400,001 ms.

The relay now persists an immutable `qr-expiry/v1/<SHA-256(token)>.json` **before** granting the first photo upload URL. It contains only schema version, a hash of the authenticated booth/photo identity, and original creation/expiry times. No raw token, portrait, email or video key is stored there. Only a token freshly generated by the server can create a new clock. Caller-supplied tokens and every confirmation/discovery writer need existing proof or original durable legacy metadata; unknown old tokens return 410 rather than being reissued.

Legacy metadata is anchored conditionally with its exact existing identity/clocks. Conflicting/corrupt evidence fails closed. New metadata recovered after cleanup uses the proof's original times, never the retry time. Warm reads enforce the validated original expiry; cold reads validate durable metadata against proof. Conditional proof creation handles competing relays and lost acknowledgements without overwriting the deadline. Expired confirmation, video patch and re-signing cannot reopen the token. New sessions start their 24-hour lifetime at initial signing; legacy sessions retain their original clocks.

Actual-handler tests cover metadata retained/removed, exact expiry, warm/cold replay, re-signing photos/videos, recovery before expiry, unknown/partial restores, legacy adoption, identity conflicts, concurrent proof creation and ambiguous proof acknowledgement. A real child process is killed, its metadata alone is removed from the disk-backed provider replacement, and a fresh process rejects replay at the original boundary with 410/download 404 while retaining the proof/photo. The earlier acknowledged-download SIGKILL/restart test still retrieves the original bytes, and the missing-photo negative control remains intact.

Expiry proof must be excluded from session cleanup, retained permanently while this random-token protocol accepts replays, backed up with current state and preserved by compatible rollback. An old writer that ignores it must not coexist. Legacy work with neither proof nor original metadata is parked for reconciliation, not assigned a new token or deadline. These provider/migration controls remain unverified gates, not changes made to the cloud.

## R5 — Medium: read outage looked like expiry — resolved locally

`loadSession` now propagates storage failures. Download and asset proxy return retryable HTTP 503 for unreadable/unconfigured/corrupt state; confirmed missing/expired sessions retain 404. Invalid download tokens are terminal 404. The subscription caller also catches read failure before writing a subscription or invoking its notification pipeline. No real subscription/message side effect was exercised.

The phone download candidate adds an explicit **Try again** button for temporary HTTP/network/JSON failures. It repeats GET for the same token, clears the failed attempt, cancels the previous request/timer, and resumes the existing bounded video polling after recovery. Expired/invalid 404/410 links show the terminal message without a retry button. Leaving the page aborts the request and ignores late responses. There is no automatic error retry loop and no photo upload, print, payment or renewed retention on this action.

Local actual-handler evidence: warm cached session 200 during a read outage; cold relay 503 with `retryable: true`; after provider recovery the same relay returns 200 with identical metadata/proof and no extra storage writes. Seven React tests cover 500/503, network failure, terminal expiry, unmount/late response and recovery after a failed video poll. Chrome shows the error/button, then the original synthetic photo after clicking it: actual candidate handler/provider replacement, 503 → 200, unchanged two initial storage writes. Screenshots and server log are under `test-results/qr-expiry-phone-*` and `qr-expiry-browser-server.txt`.

`audit/reproduce-qr-expiry-recovery.mjs` now asserts safe R4/R5 outcomes, saved as `test-results/qr-expiry-after.json`. Historical unsafe output is retained separately. The production patch now includes `capturism-download`; its Cloudflare Pages build, environment, frontend/relay compatibility and compatible rollback must be reviewed before any authorized release.

## R6 — Medium: stalled phone headers/body never offer retry — OPEN

The phone's `load` at `DownloadPage.tsx:97` has no request/body deadline. Retry appears only after rejection, and the video polling limit applies only after success. Tests against the actual component keep fetch or JSON-body consumption pending for 12 minutes of virtual time; the page still says Loading, has no retry control and has not aborted. R5 remains fixed for returned errors, but this separate stalled-read path is incomplete.

Add a bounded whole-read deadline with explicit same-token retry and late-result/unmount guards. Prove stalled and abort-ignoring headers/body, success after retry, expiry and bounded video polling without changing retention. Current probe: `audit/phone-stall.review.test.tsx`, output `test-results/qr-retention-phone-tests.txt`. Probe success means the gap was reproduced, not fixed.

## R7 — Medium: video grace starts before the photo is ready — OPEN

`session-metadata.cjs:108–109` now copies issuance time into metadata `createdAt`, but `server.js:875,886` still uses that field for the ten-minute video wait. This changes the former first-photo-confirmation wait window. With photo confirmation nine minutes after signing, the candidate marks video failed only two minutes after photo confirmation; the baseline still reports pending. Both QRs are unexpired, and cold restart reproduces the result. The phone stops polling on pending=false and may miss a video delivered later.

Keep immutable expiry and establish a separate durable first-photo-confirmation video-wait clock. Do not reset it on replay, concurrent delivery, lost acknowledgement or restart; define conservative legacy/metadata-loss fallback and never extend QR retention. Reproduction: `audit/reproduce-qr-video-grace.mjs`, output `test-results/qr-retention-video-grace.json`. This is an undeployed candidate regression, not evidence about the studio's actual incident.

## Proof retention and legacy adoption review

The built-in backup module is unchanged and only snapshots pool prefixes. Actual-module local tests prove live `qr-expiry/v1/` is not pruned, but is also not copied into snapshots; nested old snapshot keys are pruned under `backups/pool/`. Therefore a pool backup marker is not proof of QR backup completeness. An independent verified current-proof backup/restore procedure, lifecycle exclusions and permissions are required before rollout; no external backup/lifecycle was inspected or changed.

New positive cases prove cold legacy recovery after failed proof persistence or lost acknowledgement, two-relay conditional adoption, original noncanonical photo identity with video signing/replay, and proof-read outages that cannot be mistaken for missing authority. Original metadata/video/history bytes and clocks remain intact. Existing durable legacy clocks are the migration source; baseline re-commits could already have overwritten the historical first issuance. Unknown legacy work is parked, never assigned fresh clocks. See A7/C3/C5 and the restore matrix in the rollout plan.

## Earlier audit fixes retained

| Finding | Fix and local evidence |
| --- | --- |
| Loopback last hop could hide remote ingress | Shared guard checks address, local Host/Origin and rejects forwarded/Cloudflare metadata before mutation. Actual HTTP tests cover cross-origin, tunnel headers and forged Host. A proxy stripping all provenance still requires topology verification. |
| Malformed pool JSON escaped async handlers | New upload metadata is bounded and validated; malformed/null/version mismatch returns 400. Removed sign/join write handlers reject legacy requests with 426. |
| Recovery metadata could redirect or bypass expiry | Checkpoint identity, key, seed, counters/times, digests and terminal receipts are checked. Corrupt records are retained and never delivered. This is not protection against a malicious local account. |
| Changed seed replay acknowledged as equivalent | Durable reservation binds seed and digest; conflicting replays return 409. |

## Final local validation

Re-reviewed snapshot `0394f44`, implementation `485d20a`, new evidence `49b05ad`, 2026-10-31. Production source unchanged; patch `3c54fdc8c290fdd8a8666dd205d5d9e73aaab8e7bb0b48c62ddab98d09f345fd`. Saved summary: `audit/qr-retention-review.json`.

- **132 twin tests**, **27 targeted kiosk tests**, **7 positive phone recovery tests** pass. Two separate phone probes reproduce R6; the baseline/candidate clock script reproduces R7. Passing those probes is evidence of unsafe behavior, not proof of recovery. Earlier expiry/replay/acknowledged-photo SIGKILL and missing-asset controls still pass.
- Kiosk TypeScript/full lint/build, phone TypeScript/build/component lint, twin build, all candidate JavaScript syntax and exact 23-file artifact checks pass. Existing chunk/import/Node warnings remain. No dependencies or lockfiles changed.
- Six additional legacy/retention tests cover failed proof saves, lost ACK, competing relays, historical photo identity, proof-read failure and actual built-in backup/pruning behavior. Real provider retention/backups/adoption remain unverified.
- `audit/prepare-phone-check.mjs` prepares the local phone checkout with existing kiosk dev tools. For the separate R6 probe, copy `audit/phone-stall.review.test.tsx` to `.runtime/download-check/src/components/DownloadPage.stall.review.test.tsx`, then run the local Vitest command in [QR metadata](QR-METADATA.md). No new browser interaction or preview service was needed in this review.
- Actual HTTP handlers/client, local disk/provider substitutions and child-process SIGKILL are exercised. Full relay integrations and live SDK/provider, physical Windows/idle, Pages/Render targets remain unverified. Previous browser evidence covers returned 503 and explicit success only, not stalled reads or the slow-photo video grace.
- Earlier queue scan measurement: 20 pending 2 MiB portraits (about 53 MiB JSON), synchronous scans 54/51/50 ms on this Mac; no Windows/production latency benchmark. Proof signing adds two reads and a conditional creation; cold valid download reads metadata/proof plus first-adoption PUT; warm validated cache avoids those reads. Real cost/migration volume is unmeasured.
- Baseline dependency audits remain untriaged: kiosk 14 (1 critical, 11 high, 1 moderate, 1 low); relay 6 (3 high, 3 moderate). These saved counts are not a fresh scan or exploitability assessment.

## Remaining issues and release gates

**R6/R7 require code/recovery resolution before release. R1–R5 and the kiosk deadline remain closed locally within their tested scope.** Actual provider persistence, expiry-proof retention/legacy adoption and phone hosting still need staging evidence. Verify actual SDK/IAM/conditional-write behavior, save failure and acknowledged-download recovery after a real relay restart using synthetic data. All QR metadata writers must use the new helper; do not mix an old relay writer with the new layer.

**Launcher/update automation must be controlled.** `start-kiosk.bat` and `update-kiosk-auto.bat` switch a non-main/detached checkout to `main`, may stash tracked edits and pull again. A rollback to a detached SHA followed by the stock launcher is therefore not a pin. The revised rollout plan requires verified `main`/artifact alignment or an approved maintenance launcher, plus frozen automatic updates/restarts. Never run these launchers on this Mac as a rehearsal; they are Windows device/process operations.

**Coordinated protocol cutover is mandatory.** Stop legacy writers and settle outstanding published-key presigns before enabling collection. This patch cannot revoke already-issued URLs or protect against old relay code deliberately restored over the new state. Retire the old provider write capability using an authorized, rehearsed maintenance procedure. Do not restore an older pool snapshot over newer tombstones/distributions. Rolling back must retain protocol-2-compatible fences and receipt handling.

Image deletion and metadata publication are not an atomic multi-object transaction. A crash after a late image commit can leave a private orphan; it cannot be published or served while the canonical tombstone remains. Startup/withdrawal retry reconciles it. Existing downloaded or already-streaming images cannot be recalled. Verify and monitor cleanup in staging; do not interpret a 503 withdrawal as completion.

The bridge queue remains single-writer, with durability beginning after local acknowledgement. Do not launch another worker against its folder, clear receipts, re-identify jobs or restore stale backups. Page closure before JPEG handoff, catastrophic disk failure and physical Windows power loss remain outside demonstrated durability. Corrupt/blocked/older-than-24h jobs retain bytes for review; no consent is renewed automatically.

Actual kiosk SHA, Node/Chrome/Windows/filesystem, tunnel rewrites, R2 conditional permissions/lifecycle/key rotation, Render request limits/topology and real after-idle behavior remain unverified. Baseline critical/high advisories need disposition. The new relay hop is bounded to two concurrent 20 MiB bodies, but real slow-network hosting behavior still needs staging. R6/R7 plus the environment, dependency and cutover gates keep production release on hold; the passing client-deadline and pool publication checks remain valid within their tested scope.

See the [final combined review](FINAL-REVIEW.md), [protocol and failure boundaries](PUBLICATION-FENCING.md), [coverage ledger](AUDIT-COVERAGE.md) and [rollout/rollback plan](ROLLOUT-ROLLBACK.md).
