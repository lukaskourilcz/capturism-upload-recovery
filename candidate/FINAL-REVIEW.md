# Final combined verification — R6/R7 fixed locally; release gated

2026-10-31. Tested implementation `d8dea047bfea8e4267a2708db3b249ca6df08306`, based on Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Production patch SHA-256 `75e0a3292d4a4c1e53b348bc23e851a6cec3a42b27e39cd51c8e8205283b8f5e`, **24 changed files**. This fixes the two findings from review `0b13cc7`. No push, deployment, credentials, cloud/device/payment/print action or client message.

## R6 — stalled phone reads — closed locally

`capturism-download/src/lib/readDownload.ts` gives each GET one 20-second deadline for fetch and JSON-body consumption. Timeout rejects and aborts even when a transport ignores cancellation; a wall-clock check rejects a result after a suspended main thread resumes. The page shows **Try again** and repeats the same token. Previous requests/timers are cancelled on retry/unmount, and late results cannot overwrite the recovered photo. Confirmed 404/410 remains terminal. There is no automatic error retry loop, upload, print, charge or expiry renewal.

The page's separate 11-minute polling budget now survives manual retry. Fifteen phone tests pass, including stalled headers/body, late abort-ignoring results, rapid taps, stalled video polling, suspended-clock response, retry to terminal expiry, unmount and returned errors. The two former unsafe probes now assert successful bounded recovery; historical failing evidence remains in `test-results/qr-retention-phone-tests.txt`.

Chrome against the local synthetic relay: a stalled read reaches the timeout/retry state, then the same QR retrieves and renders the original synthetic photo after storage recovers. Request trace records client aborts and GET 200, with three initial storage writes unchanged by retry. No contact/share form was submitted. Screenshots: `test-results/qr-clock-phone-timeout.png`, `qr-clock-phone-recovered.png`; log: `qr-clock-browser-server.txt`. Temporary preview services were stopped. This is a phone-flow check, not a live provider/latency benchmark.

## R7 — video waiting clock — closed locally

QR `createdAt/expiresAt` still follow immutable issuance proof. New metadata records `videoWaitStartedAt` on its first successful metadata commit attempt; failed metadata attempts do not persist a wait clock. A lost metadata acknowledgement is reconciled from that durable timestamp. Before success/cache/notifications, the relay also conditionally saves a minimal immutable `qr-video-wait/v1/<token hash>.json`, bound to the original identity and expiry. Download pending/failed uses this independent clock.

Metadata cleanup with the wait record retained cannot restart waiting. If only the wait record is missing, new metadata restores its exact persisted confirmation time; legacy metadata without that field uses its original durable creation time. A conflicting/corrupt/unreadable record fails closed. Client-supplied timing fields are ignored. QR expiry remains an absolute upper bound; no retry starts another retention period.

Ten new tests cover a nine-minute photo upload and later video, nine minutes of failed metadata recovery, exact video grace and QR expiry, replay/patch/client timestamp, metadata removal, failed/lost clock saves, conflicting/corrupt reads, competing relays, legacy/missing-clock recovery and SIGKILL/restart. A restarted real handler process continues waiting two minutes after slow photo confirmation, then delivers the original video bytes; expiry and clock bytes remain unchanged. This is local Mac process evidence, not physical Windows/R2 proof.

`audit/reproduce-qr-video-grace.mjs` now asserts that baseline and candidate both remain pending two minutes after a nine-minute photo path. Previous unsafe output is retained in `test-results/qr-retention-video-grace.json`; current safe result is `qr-clock-video-grace.json`. The timestamp is the first durable commit attempt's recorded time, not a fresh time on every acknowledgement/retry.

## Retention, compatibility and limits

The independent backup/restore requirement now covers **both** `qr-expiry/v1/` and `qr-video-wait/v1/`, plus the metadata field when present. The unchanged built-in pool snapshot includes neither prefix; its marker is not QR backup coverage. Preserve these records outside sessions cleanup and across compatible rollback. Provider lifecycle/permissions and any external backup remain unverified.

With metadata removed but clock retained, authenticated same-identity recovery preserves the clock. With clock removed but metadata retained, restore its stored timestamp (or conservative legacy creation time). If both timing sources are lost, the previous video-wait start cannot be reconstructed; pause/reconcile affected work rather than promising a preserved wait window. Original expiry proof still caps retention. This is outside ordinary sessions-only cleanup and requires the paired-state retention/restore gate.

Legacy migration preserves existing durable clocks/media/history; it cannot recover a historical issuance already overwritten by the baseline. An old writer ignoring proof, a relay calculating video grace from issuance or a phone bundle without whole-read timeout is not a compatible rollback.

## Final local evidence

- **142 twin tests**, **27 targeted kiosk tests**, **15 phone tests** pass, including all slow/idle, pool withdrawal/duplicate/restart and QR deadline/expiry regressions. The former R6/R7 reproducers now assert safe outcomes, not unsafe behavior.
- Kiosk TypeScript/full lint/build, phone TypeScript/build/component/helper lint, twin build, JavaScript syntax and isolated exact patch application pass. Existing build/deprecation warnings remain. No dependencies or lockfiles changed.
- All **24 files** match candidate bytes after isolated patch application. Summary: `audit/qr-clock-validation.json`; detailed outputs: `test-results/qr-clock-*`.

No further blocker was demonstrated within these tested paths. Full relay integrations, Windows/hardware/power-loss, actual R2 conditional semantics/paired retention/backups, Render/Pages settings and dependency disposition remain unverified. The [rollout/rollback plan](ROLLOUT-ROLLBACK.md) keeps release gated on those checks and exact-artifact authorization. Nothing is deployed.
