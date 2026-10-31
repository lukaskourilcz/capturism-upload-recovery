# Final combined re-review — HOLD

Re-reviewed 2026-10-31: combined snapshot `da37ad8`, production implementation `1d7ebac0ea112b473e97f5cf7b91e599e32f6593`, review/evidence `256fe35`. Production patch unchanged: SHA-256 `dccf9d1f5bffd5e76ad499c7534bafabc81da70d17929ccf311d374d4e667f51`, based on Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`.

**Two open findings: R4 high and R5 medium.** Prior pool, client deadline and R3 durable-acknowledgement tests remain green. These findings are remaining QR expiry/read-recovery gaps; passing the prior tests did not prove those boundaries safe. This review changes tests/fixtures/docs only. No deployment, push, credentials, cloud/device/payment/print action or client message.

## R4 — High: metadata removal allows expired-token revival

`session-metadata.cjs` checks expiry only when the old metadata object is present. After its removal, the same token enters the new-record path and receives `createdAt = now()` plus a new 24-hour expiry. Conditional creation protects concurrent writes, but cannot prove this was a genuinely new token.

Actual-handler local reproduction: initially confirmed QR → advance beyond expiry → replay 410 → remove metadata → fresh relay context → replay 200 and download 200 while the photo still exists. The fixture renews expiry by 86,400,001 ms. Real lifecycle timing has not been inspected; the code's behavior after metadata removal is demonstrated. With assets also removed, it may acknowledge metadata pointing at an unavailable photo.

This matters for delayed video delivery/restore: the worker checks a 24-hour age from local enqueue before upload, which is not the authoritative original QR expiry and can be crossed during work. Required resolution: preserve/validate original issuance and expiry independently of disposable metadata, handle legacy tokens and uncertain outcomes explicitly, and test removed metadata with warm/cold relays. Do not create new retention simply to drain a stale queue.

Location: `candidate/capturism-relay/session-metadata.cjs`, new-record initialization around lines 52–57. This review leaves the production protocol unchanged.

## R5 — Medium: a cold read outage becomes false expiry

`loadSession` catches all load failures and returns null; download maps null to 404. The fixture proves: a valid session returns 200 from warm cache during a storage-read failure, 404 from a fresh relay during that failure, and 200 from that same relay after recovery, without changing metadata.

The captured phone page maps 404 to “expired or invalid,” sets an error state and only schedules polling after a successful response. It does not automatically recover from the failed initial read. This is inherited read-path behavior, distinct from the now-fixed false write acknowledgement.

Required resolution: separate confirmed missing/expired state from transient read failures with retryable responses, handle all load callers safely, and verify bounded/explicit phone recovery. If phone source changes, include its Cloudflare Pages build/deployment/rollback target explicitly; the current patch does not change that app.

Location: `candidate/capturism-relay/server.js`, `loadSession` catch at lines 1720–1721 and download/asset-proxy missing-session handling; captured `capturism-download/src/components/DownloadPage.tsx`.

Evidence for both: `audit/reproduce-qr-expiry-recovery.mjs`, saved output `test-results/qr-rereview-open-findings.json`. Script success means unsafe cases were reproduced, not that R4/R5 passed a safety test. It makes no provider/network calls.

## Corrected restart evidence and passing coverage

The child fixture previously seeded its synthetic photo on every start, even after loading existing provider data. That could conceal a missing provider asset. It now seeds only fresh provider storage. The real SIGKILL/acknowledged-photo restart test still passes, and a negative control with metadata but no photo returns asset 404 instead of manufacturing bytes. Earlier metadata-persistence evidence remains valid; the photo-recovery proof is now stronger.

- **115 twin tests pass**, zero failures/skips, about 35.5 seconds. Added exact-expiry warm/cold rejection and stale warm-relay replay reconciliation. Stored-record expiry tests cover the original record remaining present; they do not close R4 after removal.
- **27 targeted kiosk tests pass** across five uploader/probe/privacy/video/UI files. TypeScript, full lint with zero warnings, kiosk/twin builds and candidate JS syntax pass. Existing build warnings remain. Node 26 kiosk tests use `NODE_OPTIONS=--no-experimental-webstorage` for jsdom-owned storage.
- The exact unchanged patch applies to an isolated baseline copy and reproduces all **22 changed files byte-for-byte**. No production source, dependencies or lockfiles changed in this review.
- Actual handler/client/process/provider replacements are tested. Live R2/hosting, full relay startup/integrations, Windows/device behavior and the studio's real idle cause remain unverified. No new browser operation was needed for this review.

Evidence: `test-results/qr-rereview-full-tests.txt`, `qr-rereview-targeted.txt`, `qr-rereview-kiosk-tests.txt`, `qr-rereview-typecheck.txt`, `qr-rereview-lint.txt`, `qr-rereview-build.txt`, `qr-rereview-artifact.json`.

## Rollout / rollback decision

The [updated plan](ROLLOUT-ROLLBACK.md) makes R4/R5 explicit gates A7/A8 before release, with metadata cleanup, exact-expiry, delayed-worker, partial-restore and cold-read fault tests. Any new authoritative expiry evidence must survive migration/compatible rollback; an older writer must not bypass it. Failed or uncertain expired work is parked for review, not given a new token or retention window.

Keep Windows updater/launcher source mutation controlled, preserve pool withdrawal fences/distributions/receipts and all required state, retire legacy write capabilities, verify private backup completeness and real hosting/storage limits in isolation. A detached checkout plus a launcher that pulls `main` is not a pin. Production smoke checks remain limited to verified read-only health/config/log signals. No current local result authorizes rollout.
