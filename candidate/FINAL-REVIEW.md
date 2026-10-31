# Final combined re-review — HOLD: video discovery can report false failure

2026-10-31. Reviewed snapshot `7938e3e`, production implementation `d8dea047bfea8e4267a2708db3b249ca6df08306`, review/evidence `7056ddd`. Production patch unchanged: SHA-256 `75e0a3292d4a4c1e53b348bc23e851a6cec3a42b27e39cd51c8e8205283b8f5e`, 24 files, against Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. This review changes tests/fixtures/documentation only. No push, deployment, credentials, cloud/device/payment/print action or client message.

**R8 is a remaining medium release blocker.** The persistent video clock, whole phone read deadline and restart durability remain locally valid. The gap is in the actual video-discovery path, which earlier QR fixtures substituted with a no-op. It is inherited server behavior, not a demonstrated regression introduced by the clock change or a proven cause of the studio incident.

## R8 — Medium: unconfirmed discovery is treated as final video absence

`server.js:795–797` swallows every HEAD failure as if the object were missing. `server.js:775–779` also marks discovery throttled before its reads and durable metadata update complete. A request within 20 seconds then returns the previous session without checking whether the earlier probe succeeded. At/after the persisted video grace boundary, download returns HTTP 200, no video URL, `videoPending:false`, `videoFailed:true`, even though a video object exists.

Three actual-handler local reproductions demonstrate the failure:

1. A transient provider HEAD 503 is swallowed on warm and cold relays. After provider recovery, the warm relay still skips discovery during its throttle window. An explicit fetch after the throttle recovers the existing video; normal phone polling has already stopped.
2. Discovery finds the video but cannot save metadata. The first request returns 500; an immediate retry after storage recovers returns 200/false absence because the failed operation already set the throttle.
3. A second reader arrives while another reader's successful discovery is still in flight. It skips the probe and receives final failure, while the first reader subsequently returns the existing video.

The actual phone component consumes the false-absence response, performs no automatic refetch over 12 minutes of virtual time and offers no retry button. The clock and expiry records remain intact; missing/incorrect timing is not the cause.

Required resolution: distinguish confirmed missing objects from unreadable/failed-save/in-flight outcomes. Return a retryable unknown/error state for unverified discovery; do not throttle failed work as a completed negative result. Coordinate concurrent probes or make their incomplete state retryable. Preserve known media and the independent wait/expiry clocks; confirmed absence after grace must still terminate normally. Test transient HEAD errors/denials/timeouts, partial results, failed metadata persistence, immediate retry and concurrent readers through the actual function and phone contract.

Evidence: `audit/reproduce-video-probe-read.mjs` → `test-results/qr-clock-review-open-probe.json` (three cases); `audit/phone-video-discovery.review.test.tsx` → `qr-clock-review-phone-tests.txt`. Successful probe exits reproduce unsafe outcomes; they are not assertions that R8 is fixed. Production code is unchanged by this review.

## Persistent clock, retries and restart findings that passed

The expiry proof, metadata confirmation timestamp and independent create-only clock retain their identity/times across slow photo confirmation, failed/lost storage acknowledgements, replay, legacy adoption and restart. Whole phone reads still have a 20-second header/body deadline, explicit same-token retry, stale-result/unmount protection and a fixed page polling budget. R1–R7 and the kiosk network deadline remain closed within their tested scope.

Two new child-process tests kill the real handler fixture **after durable metadata but before clock persistence**, and **after durable clock persistence but before acknowledgement**. The client gets a disconnected request, not false success. Cold recovery restores/preserves the exact timestamp and expiry, serves original photo bytes and accepts same-token replay without rewriting the original metadata/proof. Existing restart/video-byte tests still pass.

The QR fixture now runs actual `probeForVideos` by default and models HEAD success/missing/failure. The previous video restart test had pre-seeded its synthetic video while discovery was stubbed. Its timing is corrected: bytes arrive after the waiting assertion, then a restarted relay actually discovers and persists the orphan video. This improves flow fidelity; earlier clock-byte persistence evidence remains valid. Two new positive tests verify confirmed 404 behavior around grace and successful orphan discovery across restart.

## Final validation and limits

- **146 twin tests**, **27 targeted kiosk tests**, **15 positive phone tests** pass. One separate phone consequence probe and three provider scenarios reproduce OPEN R8. Do not report all 16 phone assertions as safe discovery recovery.
- Kiosk TypeScript/full lint/build, phone TypeScript/build/component/helper lint, twin build, JS syntax and exact isolated patch application pass. All **24 unchanged candidate files** match. No dependencies or lockfiles changed; existing warnings remain.
- Summary: `audit/qr-clock-rereview.json`; detailed evidence: `test-results/qr-clock-review-*`. No new browser operation or preview server was needed. Earlier Chrome timeout/recovery evidence remains scoped to that tested flow and does not verify discovery failures.
- Both `qr-expiry/v1/` and `qr-video-wait/v1/` plus matching metadata timestamps still require verified retention/current backup/restore. The built-in pool snapshot includes neither prefix. Paired timing-source loss needs reconciliation; an old writer is not a compatible rollback.
- Full relay integration startup, live SDK/R2 semantics/lifecycle/backups, Windows/hardware/power-loss/studio idle behavior, Pages/Render configuration and dependency disposition remain unverified.

The [updated plan](ROLLOUT-ROLLBACK.md) adds open gate A11 for R8, retains all paired-state/kiosk/cloud gates, and forbids clearing clocks/media merely to trigger discovery. Release remains on hold. Nothing is deployed or sent.
