# Durable QR confirmation and expiry — local candidate

Combined implementation `001032e`, based on Capturism `1f2df64`. R3–R8 remain resolved within their tested scope; a later review finds R9 high OPEN at media-key authorization; see [final verification](FINAL-REVIEW.md). Actual provider/kiosk/phone-hosting and paired-state retention/backup checks remain in the [rollout plan](ROLLOUT-ROLLBACK.md). No deployment, push, credential change, device operation or client message.

## Issuance and original expiry

Before returning the initial photo upload URL, the relay conditionally creates `qr-expiry/v1/<SHA-256(token)>.json`. This immutable record contains version 1, a SHA-256 of `[authenticated boothId, photoKey]`, `createdAt` and `expiresAt`. It contains no raw token or customer media/contact data. A new server-generated random token starts its 24-hour life at issuance, before uploading. Re-signing a caller-supplied token cannot create a new lifetime.

All metadata writers validate that proof. Legacy records without proof may establish it only from their original durable identity/clocks, with conditional creation and contention reconciliation. Their session metadata/media/history are preserved. These are the current durable legacy clocks; the old relay could already have overwritten the historical first issuance during a later commit, which this migration cannot reconstruct. If both proof and metadata are missing, an old token returns 410, even if an old photo still exists. Corrupt/conflicting/read-failing evidence fails closed; no client timestamp establishes authority.

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

169 twin tests, 27 targeted kiosk tests and 16 phone React tests pass; kiosk TypeScript/full lint/build, phone TypeScript/build/component lint, twin build and exact 24-file artifact/syntax checks pass. Tests include failed saves/reads, lost acknowledgements, video-history replay, competing relays, exact expiry with/without metadata, partial restore, legacy adoption and SIGKILL/restart with actual handler photo retrieval. A separate missing-photo control remains 404.

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

## Later authorization re-review — OPEN R9

The photo identity/expiry proof does not authorize every caller-supplied video key. MEDIA validation currently checks string shape only; an authenticated booth can attach an unrelated bucket object to its own normal QR, and signing/public proxy then read that object. `audit/reproduce-qr-media-scope.mjs` demonstrates all three media fields on baseline/candidate with synthetic private records, including cold restart. It requires valid booth authorization and a known/readable target key; this is not a demonstrated anonymous bucket listing or live incident.

The [rollout plan](ROLLOUT-ROLLBACK.md) adds A12 for new-key ownership/kind/namespace checks and safe public reads of existing mappings. Historical mappings need explicit trusted legacy handling; neither presence in metadata nor a media-looking extension proves ownership. Keep original clocks/media unchanged when rejecting/quarantining unsafe references. Production source is unchanged in this review; current summary is `audit/qr-discovery-final-rereview.json`.

Five added discovery overlap/restart cases pass, including cross-relay commits, conflicts, warm/cold 50-reader bursts and ephemeral negative-cache restart. Actual cloud load remains a gate: cold initial hydration is not coalesced. These positive results do not close R9.
