# Final combined re-review — HOLD: phone read deadline and video wait regression

2026-10-31. Reviewed snapshot `0394f44`; production implementation `485d20a47435462a0ddc566b88cfb6be2c78d3f2`; review tests/evidence `49b05ad`. Baseline Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. The production patch is unchanged: SHA-256 `3c54fdc8c290fdd8a8666dd205d5d9e73aaab8e7bb0b48c62ddab98d09f345fd`, 23 changed files. No deployment, push, credentials, cloud/device/payment/print action or client message.

**Two remaining medium findings: R6 and R7.** R4's cleanup/replay guard and R5's handling of returned read errors remain locally valid. The added phone timeout probes reproduce a separate stalled-request gap; the new clock comparison demonstrates a video-wait regression. Green existing tests did not cover these boundaries.

## R6 — Medium: a stalled phone read never offers retry

`capturism-download/src/components/DownloadPage.tsx:97–107` starts `fetch` and reads `res.json()` without a deadline. Its controller is aborted only when the effect is replaced/unmounted. Retry becomes visible only in the rejection handler. If headers or a response body stop arriving, the initial page remains on “Loading your photos…” indefinitely. The 11-minute video polling limit is checked only after a successful response; it cannot settle a stuck read.

Two isolated tests execute the actual component with stalled headers/body. After 12 minutes of virtual time: one request, no retry button and no abort. These are reproductions of unsafe behavior, not passing recovery tests. This is an inherited phone read gap; the new button correctly recovers from returned 500/503/network errors, but cannot recover from a promise that never settles.

Required before release: one bounded per-read deadline covering fetch **and** body consumption; abort/settle and show explicit retry; retain same token and guard late results/unmount. Test stalled/abort-ignoring headers and bodies, retry to success, rapid taps, expiry and pending-video polling. Do not change the QR expiry or introduce an unbounded retry loop.

Evidence: `audit/phone-stall.review.test.tsx`, copied to the isolated phone checkout; `test-results/qr-retention-phone-tests.txt`. The seven prior positive phone tests still pass. No new browser interaction was needed: production UI is unchanged and the unresolved boundary is demonstrated by component/timer tests.

## R7 — Medium: issuance time consumes the video wait window

New records use expiry-proof `createdAt` from initial signing (`session-metadata.cjs:108–109`), while download still measures `VIDEO_PENDING_GRACE_MS` from that same field (`server.js:875,886`). Previously new metadata's clock started at photo confirmation. A long photo upload or confirmation recovery therefore leaves less time for video delivery after the QR becomes ready.

Actual baseline/candidate handlers with a virtual clock: issue → photo confirmation at +9 minutes → inspect +2 minutes later. Both QRs are unexpired. Baseline reports `videoPending: true`, `videoFailed: false`; candidate reports `false/true`, including after a cold relay restart. The photo page stops polling when pending becomes false, so a later valid video can be missed until manual refresh. This is a regression in the undeployed candidate, not a demonstrated cause of the studio incident.

Required before release: keep immutable issuance/expiry and use a separate durably established first-photo-confirmation wait clock for new sessions. Replay, lost acknowledgements and restart must not reset it. Define legacy and metadata-reconstruction fallback explicitly; never move QR expiry or fabricate a fresh legacy lifetime. Verify slow photo followed by delayed video, before/on/after grace, concurrent confirmation, replay and cold restart.

Evidence: `node audit/reproduce-qr-video-grace.mjs`, `test-results/qr-retention-video-grace.json`. A successful script exit reproduces R7; it does not mean the regression is fixed.

## Expiry-proof retention and legacy recovery

The proof prefix is outside `sessions/`. Actual built-in `backup.js` still snapshots only `pool/`, `pool-portraits/`, `pool-deletions/`; it does **not** back up QR proof. Its pruning stays under `backups/pool/` and leaves live proof intact. An old snapshot object nested there is pruned normally: the pool's 28-day snapshot rule must not be mistaken for permanent proof retention. These behaviors were exercised with the actual backup module and local storage, without starting server integrations.

This is a concrete operational release requirement, not evidence that an external backup is absent. Real bucket lifecycle, other cleanup/replication and any independent backup are unverified. Require an owner, exact prefix/permission/retention inventory and verified current manifest/restore rehearsal for proof. The pool backup timestamp is insufficient. Restore must preserve newer proof/fences and original clocks; never use a legacy writer or rebuild unknown tokens to drain jobs.

Six added local tests pass: legacy proof save failure/retry after restart, lost proof acknowledgement, concurrent adoption, noncanonical historical photo identity with video signing/replay, proof-read outage, and actual backup/pruning boundaries. Metadata/video/history bytes and clocks remain unchanged. A noncanonical photo re-sign is correctly rejected as an identity change. Legacy adoption trusts the existing durable legacy clocks; the baseline could already have overwritten them on video commits, so migration cannot establish a historical first issuance that was never retained. Legacy work without proof or original metadata stays parked.

## Verification and release boundary

- **132 twin tests**, **27 targeted kiosk tests**, **7 positive phone recovery tests** pass. Two additional phone probes reproduce R6; a separate baseline/candidate script reproduces R7. Do not report those unsafe reproductions as safe timeout/video behavior.
- Kiosk TypeScript/full lint/build, phone TypeScript/build/component lint, twin build, JavaScript syntax and exact isolated patch application pass. Existing build/deprecation warnings remain. The unchanged patch matches all 23 files; no production dependencies or lockfiles changed.
- Saved summary: `audit/qr-retention-review.json`; detailed local output: `test-results/qr-retention-*`. Earlier SIGKILL/photo-byte recovery, expired cleanup replay, missing-photo control, pool withdrawal/publication and shared kiosk deadline remain covered.
- No full relay integration startup, live R2/Render/Pages verification, Windows device/power-loss test or new studio timing evidence. Previous local Chrome evidence remains scoped to returned failures and successful retry; it does not close R6/R7.

The [updated plan](ROLLOUT-ROLLBACK.md) adds A9/A10 as open code gates, a concrete expiry-proof backup/adoption/restore gate, and a compatibility matrix that forbids rollback to a writer ignoring proof. Release stays on hold for R6/R7 and the remaining kiosk/cloud/dependency/cutover checks. This review changes tests and documentation only.
