# One QR upload deadline and explicit recovery — local candidate

Deadline implementation originated in `fcac656`; current combined implementation is `001032e`, based on Capturism `1f2df64`. No push, deployment, live credentials, studio operations or client messages.

## Contract

`uploadSessionToCloud` starts one absolute photo-network deadline. The relay now also requires [durable metadata confirmation](QR-METADATA.md); save failures retain the same client checkpoint until a later successful acknowledgement. Signing, reading its response JSON, R2 PUT, confirmation and its response body, inner retries, outer retries and every backoff all consume that same budget. Per-request limits can shorten a request but cannot renew the root deadline. The timer aborts the current transport; a separate promise race ensures even a stalled/non-cooperative operation cannot keep the caller waiting. Before exposing a token, the code checks the deadline and session again.

| Caller / state | Bound and behavior |
| --- | --- |
| Background photo/calendar/l'INCONNU | Requested `retryForMs`, capped at ten minutes total |
| Legacy caller without an outer retry window | One outer attempt, at most two minutes across all inner requests; no automatic outer retry |
| Explicit Retry download | New ten-minute budget for the same prepared photo/checkpoint; rapid duplicate taps do not start another operation |
| Successful photo PUT, failed/unknown confirmation | Retry confirmation only; retain original token/key and skip re-sign/PUT |
| Failed/unknown PUT | Keep token, obtain a fresh upload URL and send the same immutable Blob |
| Ready QR or failed state | Five-minute inactivity window, rearmed by touch; ready gives fresh scanning time |
| Pending upload | Thank-you timer uses the actual deadline; touching cannot extend it |
| Missing/stalled preparation | Separate ten-minute thank-you watchdog shows studio-help instructions when no retryable JPEG exists |
| Explicit/automatic session reset | Abort current request, clear recovery state/references and never expose a token in the next session |

Video handoff/delivery remains asynchronous and does not gate the photo QR. Rendering, JPEG conversion and video composition precede the network entry point; this patch does not claim to interrupt those device/rendering operations. Printing callers capture the session epoch before preparation so an old render finishing after reset cannot begin a new customer's upload.

## Recovery UI and privacy

The thank-you screen replaces the preparing box with **Retry download** after an upload failure. It gives a timeout/error explanation in French, English or Korean. If there is no prepared JPEG, it explicitly asks the customer to contact the studio. Start over remains available.

Retry invokes only the retained upload/confirmation closure. It does not rerun the printing component, collect payment or print again. Ready state populates the same session's cloud token. `qrUploadState.ts` is an in-memory external store read with `useSyncExternalStore`; it is never persisted to localStorage. A reset drops its recovery references and aborts active work. A page reload loses QR recovery; the independent durable pool queue is unchanged.

Network abort is best effort at the provider boundary. A server may already have accepted work or may detect disconnect later; never interpret timeout as proof that storage/confirmation failed. Recovery uses the same token/bytes and completed-upload checkpoint. JavaScript cannot preempt a frozen main thread; deadline/current-session checks reject stale completion when execution resumes. This is not a physical Windows idle or R2 cancellation guarantee.

Safe diagnostics add `photo.flow` start/ok/error with elapsed duration and fixed timeout/aborted/other classification. Request deadline errors also classify as timeout. No photo, code, token, URL or request/response body is added to diagnostic records.

## Validation

- `npm test` in the twin: **164 pass**, zero failures/skips. Includes 14 deadline/recovery checks and 8 local-network checks, plus prior QR/pool/video/storage/privacy regressions.
- Deadline tests stall each network stage and signing/confirmation body reads, including a deliberately abort-ignoring promise. They cover exhausted retry waits, manual confirmation-only recovery, retained token after failed PUT, repeated taps, session reset and late completion.
- Local HTTP tests send real bytes through a slow uplink, expire a 300 ms network budget, then recover with one token/session. They also test first-use sign/PUT/confirmation/save errors, lost successful response and a shortened cold-signing wait. Shortened budgets accelerate testing; real provider/hardware timing is not emulated.
- Kiosk tests: **27 pass** across five selected uploader/probe/privacy/video/UI test files, including six actual thank-you component tests for absolute pending time despite touch, retry-to-QR, five-minute failure privacy reset and three-language help. Node 26 uses `NODE_OPTIONS=--no-experimental-webstorage` for jsdom's localStorage. No baseline assertion was removed.
- Final TypeScript, full lint with zero warnings, production kiosk/twin builds, candidate JS syntax and combined-patch application pass. Existing build warnings remain.
- Chrome: 1 MiB, 125 KiB/s, first PUT 503, two-second test deadline. Timeout appeared at experiment 2.2s; Retry download completed in about 8.9s with the original token, one stored photo and one confirmed session. The local server observed cancellation later, demonstrating the provider-boundary caveat above. Screenshots and `qr-browser-recovery.json` are under ignored `test-results/`.

Evidence: `test-results/qr-full-tests.txt`, `qr-focused-tests.txt`, `qr-kiosk-tests.txt`, `qr-network-recovery.json`, `qr-kiosk-typecheck.txt`, `qr-kiosk-lint.txt`, `qr-kiosk-build.txt`, `qr-timeout-browser.png`, `qr-recovery-browser.png`. The [audit](AUDIT.md) and [rollout/rollback plan](ROLLOUT-ROLLBACK.md) retain real kiosk, provider, dependency and pool-cutover release gates. Nothing is deployed.
