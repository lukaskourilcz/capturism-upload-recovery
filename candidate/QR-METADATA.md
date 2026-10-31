# Durable QR confirmation and expiry — local candidate

Combined implementation `485d20a`, based on Capturism `1f2df64`. R3/R4/R5 remain resolved within their tested scope. The later review finds R6 (stalled phone read) and R7 (issuance time shortens video grace) OPEN; see [final review](FINAL-REVIEW.md). Actual provider/kiosk/phone-hosting gates remain in the [rollout plan](ROLLOUT-ROLLBACK.md). No deployment, push, credential change, device operation or client message.

## Issuance and original expiry

Before returning the initial photo upload URL, the relay conditionally creates `qr-expiry/v1/<SHA-256(token)>.json`. This immutable record contains version 1, a SHA-256 of `[authenticated boothId, photoKey]`, `createdAt` and `expiresAt`. It contains no raw token or customer media/contact data. A new server-generated random token starts its 24-hour life at issuance, before uploading. Re-signing a caller-supplied token cannot create a new lifetime.

All metadata writers validate that proof. Legacy records without proof may establish it only from their original durable identity/clocks, with conditional creation and contention reconciliation. Their session metadata/media/history are preserved. These are the current durable legacy clocks; the old relay could already have overwritten the historical first issuance during a later commit, which this migration cannot reconstruct. If both proof and metadata are missing, an old token returns 410, even if an old photo still exists. Corrupt/conflicting/read-failing evidence fails closed; no client timestamp establishes authority.

Session cleanup must exclude this prefix. The unchanged built-in pool backup does not snapshot it; its pruner leaves live proof intact but expires dated pool snapshots. An independent verified current-proof backup/restore procedure is still required, and the pool backup timestamp is not coverage evidence. Retain proof permanently while the random-token protocol accepts old replays; include it in current backups and compatible rollback. Delete/restore tests cannot make a session new again: metadata recovery before expiry uses original clocks; on/after expiry confirmation/patch/re-signing reject it. A late save also cannot acknowledge a usable expired QR. Unknown legacy jobs require reconciliation, never a new token/TTL to drain a queue.

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

The phone app shows **Try again** for temporary HTTP/network/JSON errors. It repeats the same GET, cancels the old request/timer, ignores late results and resumes existing bounded video polling after success. Actual 404/410 remains terminal without a retry control. No automatic error retry loop, upload, charge, print or retention renewal is added. This recovery still requires a response/rejection: fetch or JSON consumption can hang without a timeout/retry control (OPEN R6).

Kiosk recovery still reuses its original Blob/token/completed PUT checkpoint after 503 or timeout; it remains memory-only for the active page/session. The durable pool queue is independent. Photo PUT and metadata are not a multi-object transaction, so orphan bytes may exist without a ready QR. This fix does not recreate missing photos or prove physical Windows durability.

## Evidence and reproduction

132 twin tests, 27 targeted kiosk tests and 7 positive phone React tests pass; kiosk TypeScript/full lint/build, phone TypeScript/build/component lint, twin build and exact 23-file artifact/syntax checks pass. Tests include failed saves/reads, lost acknowledgements, video-history replay, competing relays, exact expiry with/without metadata, partial restore, legacy adoption and SIGKILL/restart with actual handler photo retrieval. A separate missing-photo control remains 404.

`node audit/reproduce-qr-expiry-recovery.mjs` now asserts safe R4/R5 outcomes (`test-results/qr-expiry-after.json`); prior unsafe output is retained separately. `node audit/reproduce-qr-persistence.mjs` still compares baseline false acknowledgement to safe candidate recovery. `node audit/verify-qr-artifact.mjs` checks exact isolated patch application. `node audit/prepare-phone-check.mjs` prepares the isolated phone test checkout using already-installed kiosk dev tools.

Phone tests: from `.runtime/download-check`, run `NODE_OPTIONS=--no-experimental-webstorage ./node_modules/.bin/vitest run`. Its existing build runs `npm run build`; component lint uses the copied kiosk lint config. No production dependency or lockfile changes are needed. Chrome evidence: `test-results/qr-expiry-phone-retry.png`, `qr-expiry-phone-recovered.png`, `qr-expiry-browser-server.txt`. Provider fixture records 503 → 200 with unchanged storage writes. All data is synthetic; no phone contact/share form was submitted.

## Later re-review: release remains on hold

`audit/qr-retention-review.json` and [final review](FINAL-REVIEW.md) record the unchanged artifact and new evidence. Six legacy/retention checks pass; two separate phone probes demonstrate R6 rather than safe timeout recovery. `audit/reproduce-qr-video-grace.mjs` demonstrates R7: nine minutes before photo confirmation consumes nine minutes of the ten-minute video wait. Preserve immutable expiry, but establish an independent durable first-photo-confirmation wait clock before release. Neither a client retry nor legacy adoption may reset that clock or renew QR retention. No production source was changed by this re-review.
