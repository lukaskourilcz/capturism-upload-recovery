# Durable QR confirmation and expiry — local candidate

Combined implementation `4a74967`, based on Capturism `1f2df64`. R3–R11 are resolved locally within their tested scope, including QR media authorization, approved legacy reconstruction and denied-cache refresh. See [final verification](FINAL-REVIEW.md) and [rollout gates](ROLLOUT-ROLLBACK.md). No deployment, push, credential change, cloud/device operation or client message.

## Issuance and original expiry

Before returning the initial photo upload URL, the relay conditionally creates `qr-expiry/v1/<SHA-256(token)>.json`. This immutable record contains version 1, a SHA-256 of `[authenticated boothId, photoKey]`, `createdAt` and `expiresAt`. It contains no raw token or customer media/contact data. A new server-generated random token starts its 24-hour life at issuance, before uploading. Re-signing a caller-supplied token cannot create a new lifetime.

All metadata writers validate that proof. Authorized legacy records without proof may establish it only from their original durable identity/clocks, with conditional creation and contention reconciliation. Their session metadata/media/history are preserved. These are the current durable legacy clocks; the old relay could already have overwritten the historical first issuance during a later commit, which this migration cannot reconstruct. If both proof and metadata are missing, an old token returns 410, even if an old photo still exists. Corrupt/conflicting/read-failing evidence fails closed; no client timestamp establishes authority.

Session cleanup must exclude this prefix. The unchanged built-in pool backup snapshots neither expiry proof nor the new independent video clock; its pruner leaves live proof intact but expires dated pool snapshots. An independent verified current-proof backup/restore procedure is still required, and the pool backup timestamp is not coverage evidence. Retain proof and `qr-video-wait/v1/` together permanently while the random-token protocol accepts old replays; include it in current backups and compatible rollback. Delete/restore tests cannot make a session new again: metadata recovery before expiry uses original clocks; on/after expiry confirmation/patch/re-signing reject it. A late save also cannot acknowledge a usable expired QR. Unknown legacy jobs require reconciliation, never a new token/TTL to drain a queue.

## Durable success boundary

`session-metadata.cjs` owns HTTP confirmation, WebSocket photos-ready, dev seed and discovered-video patches to `sessions/<token>/meta.json`. After a per-token lock it rereads durable state. It creates with `If-None-Match: *`, updates with `If-Match` against the current ETag, and retries bounded condition conflicts. Cache/200/notifications follow an acknowledged PUT or a fresh durable read of an identical commit. A warm cache does not prove a confirmation saved.

| Outcome | Response / recovery |
| --- | --- |
| Issuance proof cannot save/read | 503; no upload capability granted |
| Confirmation cannot save/read or state is corrupt | 503; no new success cache or notification |
| Storage committed but acknowledgement was lost | Retry rereads the same proof/metadata; no renewed clock or duplicate overwrite |
| Identical photo-only confirmation after videos | Same photo, existing media, unknown historical fields and clocks retained |
| Concurrent relays add different videos | Conditional merge preserves both completed fields |
| Photo/booth/completed-media conflict | 409; durable state remains intact |
| Expired or unissued old confirmation | 410; no fresh retention |
| Video discovery cannot save | Previous committed metadata/cache retained |

HTTP/WS admin notifications can repeat after successful replay; this is not exactly-once notification delivery. No test uses real recipients. Dev seed cannot mint a lifetime for arbitrary unknown caller tokens; local tools must first use normal server issuance or provide existing legacy durable metadata.

## Download read recovery

Warm cache records have already been validated and still expire at the original deadline. Cold reads validate durable metadata and expiry proof. Confirmed missing/expired state returns 404. Temporary/unconfigured/corrupt storage returns retryable 503; the proxy and subscription caller handle the same failure before downstream effects.

The phone app shows **Try again** for temporary HTTP/network/JSON errors. It repeats the same GET, cancels the old request/timer, ignores late results and resumes existing bounded video polling after success. Actual 404/410 remains terminal without a retry control. No automatic error retry loop, upload, charge, print or retention renewal is added. One 20-second deadline now covers fetch and JSON consumption, settles even if abort is ignored, and rejects late results. Timeout offers explicit retry of the same token. Retry preserves the separate 11-minute page polling budget. 404/410 remains terminal.

Kiosk recovery still reuses its original Blob/token/completed PUT checkpoint after 503 or timeout; it remains memory-only for the active page/session. The durable pool queue is independent. Photo PUT and metadata are not a multi-object transaction, so orphan bytes may exist without a ready QR. This fix does not recreate missing photos or prove physical Windows durability.

## Evidence and reproduction

242 twin tests, 27 targeted kiosk tests and 16 phone React tests pass; kiosk TypeScript/full lint/build, phone TypeScript/build/component lint, twin build and exact 26-file artifact/syntax checks pass. Tests include failed saves/reads, lost acknowledgements, video-history replay, competing relays, exact expiry with/without metadata, partial restore, legacy adoption and SIGKILL/restart with actual handler photo retrieval. A separate missing-photo control remains 404.

`node audit/reproduce-qr-expiry-recovery.mjs` now asserts safe R4/R5 outcomes (`test-results/qr-expiry-after.json`); prior unsafe output is retained separately. `node audit/reproduce-qr-persistence.mjs` still compares baseline false acknowledgement to safe candidate recovery. `node audit/verify-qr-artifact.mjs` checks exact isolated patch application. `node audit/prepare-phone-check.mjs` prepares the isolated phone test checkout using already-installed kiosk dev tools.

Phone tests: from `.runtime/download-check`, run `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run`. The prepare script also copies both former audit probes as positive regressions, giving 16 tests. Its existing build runs `npm run build`; component lint uses the copied kiosk lint config. No production dependency or lockfile changes are needed. Chrome evidence: `test-results/qr-expiry-phone-retry.png`, `qr-expiry-phone-recovered.png`, `qr-expiry-browser-server.txt`. Provider fixture records 503 → 200 with unchanged storage writes. All data is synthetic; no phone contact/share form was submitted.

## Independent persistent video wait

New metadata adds `videoWaitStartedAt` to the first successfully saved confirmation, separate from QR issuance/expiry. The timestamp is captured for that committing attempt; a failed metadata save leaves no durable wait clock. A lost save acknowledgement is reconciled from the timestamp already saved. After the metadata commit and before success/cache/notification, the relay conditionally creates `qr-video-wait/v1/<SHA-256(token)>.json` with version, hashed identity, original createdAt/expiresAt and startedAt. Existing or competing writers cannot replace its time. Client input cannot set it.

Download pending/failed uses this independent time. A nine-minute photo path no longer consumes nine minutes of video waiting. Replay, discovered-video patch and restart preserve the original start. If metadata alone is removed, its independent clock survives and reconstructs the original timestamp. If only the clock is missing, new metadata restores its saved timestamp; legacy metadata without the field falls back to original durable creation time. Legacy metadata bytes/media/history remain unchanged on adoption. Conflicting/read-failing/corrupt timing evidence returns a retryable failure, not a replacement clock.

Success requires both metadata and wait record to be durable, in addition to issuance proof. A clock save failure after metadata commit returns 503 with no new success cache/notice; cold retry reads the metadata timestamp and persists exactly that clock. Expiry is rechecked after storage work. No clock can extend QR expiry.

Exclude both authority prefixes from sessions cleanup and preserve them in verified current backup/restore and compatible rollback. The built-in pool backup includes neither. If both metadata and its wait record are lost, the previous wait start cannot be reconstructed; affected restore work needs reconciliation rather than a promise of preserved waiting. Original expiry proof still caps retention.

Current evidence: `audit/qr-clock-validation.json`, `test-results/qr-clock-*`. The old R6/R7 probes now assert safe behavior. Historical unsafe evidence is retained separately under `qr-retention-*`. Ten clock tests cover slow photo and metadata recovery, replay/concurrency/expiry, failed/lost clock saves, legacy/partial restores and SIGKILL followed by video retrieval. Phone deadline tests cover stalled headers/body, abort-ignoring late results, rapid retries, unmount and terminal expiry. Nothing is deployed.

## Retryable and coordinated video discovery — R8 closed locally

HEAD failures are no longer treated as missing unless they are confirmed 404/missing responses. Unreadable variants, partial unknown scans, failed saves and timeouts return retryable 503. Requests needing discovery for the same token share one bounded operation. A 15-second deadline settles it and attempts HEAD cancellation; late HEAD results cannot publish. An accepted save completing late remains reconcilable from durable metadata, without duplication or a new clock.

Discovery rereads durable metadata before probing and before a final negative, recovering cross-relay/worker commits. A completed-negative WeakMap entry belongs to the validated session object, is never persisted or trusted from historical metadata, lasts at most 20 seconds and is invalidated across the video grace boundary. Failed/in-flight work cannot establish final absence. Known committed media remains intact; confirmed missing after grace still ends waiting. Expiry is checked after asynchronous discovery/signing.

Fifteen dedicated cases cover storage status errors, partial outcomes, failed/lost saves, overlapping readers, stalled/late reads and saves, grace crossing, stale/historical metadata and expiry. Three new child-process cases restart after read/save errors or kill after a discovery save but before acknowledgement; the original video, proof, wait record and timestamps survive. Existing clock/metadata crash-boundary checks remain green.

`audit/reproduce-video-probe-read.mjs` and `audit/phone-video-discovery.review.test.tsx` now assert safe recovery; old unsafe evidence stays under `qr-clock-review-*`. The phone already handles 503 with same-token Try again and a separate 20-second whole-read deadline. Browser verification shows outage → retry → photo/video links, with one necessary discovery metadata write and no media upload. Local synthetic data only; preview services stopped.

Current summary: `audit/qr-discovery-validation.json`; details `test-results/qr-discovery-*`. Actual SDK/R2 conditional/abort behavior, paired retention/backups, kiosk/hosting and cutover remain release gates. Coalescing/negative cache are per-process memory; restart intentionally rechecks durable state. Nothing is deployed.

## R9 — High: unrelated storage records exposed as QR media — resolved locally

The earlier writer accepted unrelated video/layout/story keys from an authenticated booth, then public signing/proxy read them using relay credentials. The baseline reproduction still exposes synthetic private records; the candidate now rejects those confirmations with 403 and denies pre-existing unsafe mappings with public 404, before any target-object GET. Warm caches and restarted relays enforce the same rule. No live incident or anonymous bucket enumeration was tested.

`qr-media-scope.cjs` is shared by issuance, HTTP/WS/dev-seed confirmation, discovery patches and loads. New references must use exact `sessions/<issued token>/photo.{jpg,png}`, `video.{mp4,webm}`, `layout.{mp4,webm}` or `story.{mp4,webm}` keys for the corresponding field. Immutable expiry proof still binds the authenticated booth/photo identity. Signing rejects unknown/inherited kinds and kind/content-type mismatches. Traversal, encoded paths, JSON disguises, private prefixes and unapproved foreign-session references are rejected before successful metadata/cache/notification changes.

Canonical legacy metadata remains usable with its original proof/wait-clock adoption. Noncanonical legacy media is denied by default. It requires a separate privately reviewed `qr-media-authorizations/v1/<SHA-256(token)>.json` manifest, bound to exact token hash, booth/photo identity hash, original creation/expiry and exact approved asset keys. Approval is restricted to session photo/video filename shapes; it cannot approve subscriptions, quiz codes, pool records or other namespaces. No booth/public route writes this prefix. Stored metadata and client approval flags are never authority. Other historical naming formats need separate private reconciliation; they are not silently grandfathered or rewritten.

Public loads and final signing/proxy sinks recheck authorization. Approval deletion/replacement is noticed even with a warm cache. Missing/invalid scope returns public 404; approval transport/JSON/size/ETag failures return retryable 503. Retry or restart reuses original clocks and bytes. Expiry is rechecked after delayed authorization and asset reads; an expired request cannot begin streaming. Previously issued presigned URLs, cached responses or downloaded bytes cannot be recalled by this check; review outstanding capabilities and caching in the future authorized cutover.

Seventeen focused tests cover all media fields and write callers, new/legacy/public paths, owner conflicts, forged/changed/missing approvals, outages at load and final sinks, malformed/oversized/unversioned responses, expiry, offline manifest generation and SIGKILL/restart with approval retained or removed. The offline tool writes a new 0600 file without cloud access or overwrite. Private ownership verification and protected installation remain operator gates; the tool validates structure, not studio ownership evidence.

Evidence: `audit/reproduce-qr-media-scope.mjs` → `test-results/qr-media-before-after.json` compares three vulnerable baseline cases with three blocked candidate cases, including public proxy before/after restart. `test/qr-media-scope.test.mjs` contains the positive/recovery regressions. Current validation: `audit/qr-cache-validation.json`; earlier audit JSON files retain historical R10/R11 evidence; earlier summaries remain historical. Historical unsafe evidence remains in `test-results/qr-final-rereview-open-media-scope.json`.

Five added discovery overlap/restart cases pass, including cross-relay commits, conflicts, warm/cold 50-reader bursts and ephemeral negative-cache restart. Actual cloud load remains a gate: cold initial hydration is not coalesced. R9 has separate write/read authorization evidence above.

## R10 — Medium: photo-only reconstruction lost approved legacy video — resolved locally

Previously, missing active metadata plus a normal photo-only replay could discard an approved legacy video reference and return false `videoFailed:true`, including after restart. The original video, private approval and original clocks remained intact. Ordinary restart with intact durable metadata was unaffected. Historical unsafe evidence remains in `audit/qr-media-final-rereview.json` and `test-results/qr-media-rereview-open-legacy-restore.json`.

`session-metadata.cjs` now reads the protected approval whenever it creates or reconstructs missing metadata, after establishing original issuance proof and authenticated photo identity. Shared `legacyAssets` validates exact token/identity hashes, original creation/expiry, allowed session-media shapes and exact approved fields. Only the approved video/layout/story fields populate the new record; the approval cannot create a new token/clock, change the photo identity or authorize unrelated namespaces. Conflicting replay media returns 409. Existing metadata/history is preserved; the manifest is not a complete history backup.

A confirmed absent approval restores no legacy assets. Independently authorized canonical photo recovery can still succeed; noncanonical photo/media references remain denied without approval. Missing approval does not revoke separate canonical assets or previously issued capabilities. Invalid/null/mismatched scope fails closed with 403; unreadable/invalid-JSON approval returns retryable 503 before saving. No approval is created or uploaded by recovery. Approved legacy references are rechecked before persistence and again after save/clock work, before cache/notification/success; a mid-save revocation withholds success and cold public reads remain denied. A storage write already committed before revocation may remain, guarded by public authorization checks.

Replay and conditional cross-relay recovery retain original photo/video bytes, expiry proof, video-wait clock and approval bytes. The first recovery writes one complete mapping; simultaneous or repeated replays reuse it. Failed saves leave no successful cache/notice, and lost acknowledgements or post-save approval outages reconcile without another metadata write. Expiry crossing the approval lookup returns 410 without renewing clocks.

Eighteen dedicated regressions cover canonical/noncanonical photos, before/after video grace, all approved video fields, warm/cold replay, conflicts, revoked/missing/malformed/null/mismatched approvals, private-key rejection, read/save/lost-ACK failures, post-save authorization, concurrent replay and two real process-replacement cases. One kills the relay after a failed save; another kills it after the complete metadata is durable but before acknowledgement. Fresh processes serve the original bytes and reuse the commit; later revocation stays denied.

`audit/reproduce-legacy-media-restore.mjs` now asserts safe recovery: original approved video is present, `videoFailed:false`, restart retains it and another photo-only replay adds zero writes. Current evidence: `test-results/qr-legacy-before.json`, `qr-legacy-after.json`, `qr-legacy-focused.txt` and `qr-legacy-full-tests.txt`; current summary: `audit/qr-legacy-validation.json`. No cloud, deployment, push or client message.

## R11 — Medium: stale denied cache hid a valid recovered photo — resolved locally

The earlier warm relay returned terminal 404 after another relay legitimately reconstructed a canonical photo-only record following legacy video approval removal/narrowing. Fresh readers returned 200 and cache eviction repaired the old reader. Historical unsafe evidence remains in `audit/qr-legacy-final-rereview.json` and `test-results/qr-legacy-rereview-open-cache.json`; no revoked video or unrelated object was exposed.

`resolveAuthorized` now rechecks a loaded snapshot and, only on scope denial (403), discards that exact stale cache entry and performs one fully validated fresh load. Fresh denial never recursively refreshes or falls back to old media. The fresh record must match the original booth/photo identity, creation/expiry and known video-wait start; proof and wait records are independently validated before cache promotion. Unreadable/corrupt refresh or authority conflict returns retryable 503; missing, expired or still-unauthorized durable state remains denied. A temporary approval read error also remains retryable rather than being interpreted as revocation or missing metadata.

Both cached load and final public signing/proxy checks use this resolver. Download signing uses the returned record, and the proxy selects its asset key only after resolution; a removed layout/video key therefore returns 404 instead of reading the old key. Revocation between initial load and the final guard is covered. Refresh cannot mint a new lifetime, change the photo owner or permit arbitrary storage namespaces. A late expiry still prevents signing/streaming.

Twenty-four new regressions cover removed/narrowed approvals, warm/fresh readers, actual loopback photo/video proxy, repeated/concurrent requests, read/JSON/proof/wait/approval failures, identity/expiry/wait conflicts, missing/expired/unsafe state, final-guard races and expiry during refresh. Two process tests warm a real child relay, replace its synthetic durable provider state while retaining its cache, exercise success or a refresh read failure, then SIGKILL/restart and retrieve the original photo bytes with no restored approval, extra storage write or moved clock.

The converted `audit/reproduce-stale-legacy-cache.mjs` now asserts warm/recovered/fresh photo 200 for both approval removal/narrowing, revoked video proxy 404, zero revoked-video GETs and unchanged proof/wait/media. Current evidence: `test-results/qr-cache-before.json`, `qr-cache-after.json`, `qr-cache-focused.txt`, `qr-cache-full-tests.txt`; current summary: `audit/qr-cache-validation.json`. No deployment, push, cloud access or client message.

## Offline legacy approval procedure — no cloud action performed

Canonical mappings use the exact token/kind paths automatically. For each noncanonical session-media mapping, an operator must privately establish the original booth/photo identity, source asset ownership, original creation/expiry and exact intended fields from independent studio evidence. A stored `meta.json` or a media extension alone is insufficient. Confirm the original retention is still valid. Do not copy unknown private records into media paths or approve historical mappings in bulk.

Prepare a private JSON input `{ "token": "...", "session": { ...original reviewed metadata... } }`, outside Git. From the relay directory run:

```sh
node prepare-qr-media-approval.cjs --reviewed /private/path/reviewed-session.json
```

This offline command writes one new `qr-media-approvals/<token hash>.json` (0600; directory created 0700) and reports its target `qr-media-authorizations/v1/<token hash>.json` object key. It refuses overwrite and performs no upload. The private output folder is ignored by Git. The tool cannot verify human ownership evidence. Never include real input/output in a PR, diagnostic log or public bucket.

Only a separately authorized operator procedure may install the reviewed file using private, restricted storage access. Verify booth sign/confirm, dev seed and public handlers cannot write that prefix; public direct bucket access must be disabled. Preserve original metadata, proof and wait-clock bytes; approval never establishes or extends expiry. Review any non-session historical filenames separately; the current tool intentionally refuses those keys. With all legacy writers stopped, rehearse replay, approved public reads and fresh-process recovery in isolated staging before release.

To revoke, remove the protected manifest under that approved procedure; subsequent warm/cold application reads deny it. Already-returned URLs/cache/downloads can remain usable until their own expiry. Back up current approval/revocation state privately and restore it with the matching identity/clocks. Never restore a revoked approval from a stale backup without re-review. No remote manifests or migration were created here.

Before restoring any approval, verify a private current decision manifest listing approved/revoked token hashes, approval content hashes and original identity/retention evidence. Missing or ambiguous current decisions require reconciliation; a dated bucket snapshot is not permission to restore an approval. Revocation affects noncanonical asset authorization, not every separately authorized canonical asset or already-issued read capability.

Recovery scope: preserve the original legacy metadata with proof/wait/approval/media wherever possible. Photo-only reconstruction now hydrates exact approved video keys when metadata is absent. An existing truncated record is not automatically repaired; reconcile it privately with original evidence. Missing approval restores no legacy video, and missing metadata plus missing wait clock cannot prove the previous wait start. No unknown history or bytes can be recreated from approval alone. Compare expected media, byte hashes and all original clocks in isolated staging.

## Approval reads during confirmation

Every creation/reconstruction of metadata performs an optional approval GET before saving, including a normal canonical first confirmation. Confirmed missing approval permits only independently authorized assets; unreadable approval returns 503 rather than hiding a possibly recoverable legacy mapping. JSON null is invalid scope, not absence. Existing canonical replay does not add an approval read.

Measured local approval reads: canonical first confirmation 1, canonical replay 0; approved legacy reconstruction 3, approved legacy replay 3 (initial validation, pre-save and post-save checks). Public approved legacy reads remain 2 warm / 3 cold; canonical public reads remain 0. These are provider-operation counts, not cloud latency/cost measurements. Verify required prefix Get/ETag access, timeout behavior and representative load in staging.

R11 recovery now revalidates the current durable mapping when a warm/supplied snapshot fails scope. Final public guards also reconcile a denied snapshot and select keys from the returned record, never an earlier revoked video key. Missing or still-unauthorized state stays denied; read/corrupt-authority failure stays retryable. Original identity/creation/expiry/known wait must match. Repeat warm/fresh and failure/restart checks on all relevant SDK/provider instances before release.

This is a single fresh pass per resolver checkpoint, not a new transport timeout. Valid canonical warm load adds no GET. With intact authority, a denied legacy load uses 4 GETs (one each for approval, metadata, proof and wait), 0 PUTs. Twenty simultaneous stale loads use 80 GETs / 20 metadata GETs / 0 PUTs; initial hydration is not coalesced. Existing approved-legacy public reads remain 2 warm / 3 cold approval GETs. These are local helper counts, excluding public video probing/signing and real cloud latency/cost.
