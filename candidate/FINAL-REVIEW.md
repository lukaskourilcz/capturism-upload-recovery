# Final combined verification — local fixes pass; release remains gated

2026-10-31. Tested implementation `485d20a47435462a0ddc566b88cfb6be2c78d3f2` against Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`. Production patch SHA-256 `3c54fdc8c290fdd8a8666dd205d5d9e73aaab8e7bb0b48c62ddab98d09f345fd`; 23 changed files. This verification implements the two findings from the preceding review. No deployment, push, cloud/device/payment/print action, credentials or client message.

## R4: cleanup cannot create a fresh QR lifetime — closed locally

An immutable `qr-expiry/v1/<token hash>.json` is saved before the server grants a new photo upload capability. Only server-minted tokens may establish a clock. Replays, video updates and re-signing use the original identity/deadline. Missing session metadata can be recovered before expiry with those exact clocks; at/after expiry it cannot renew the token. With neither proof nor original legacy metadata, an old token fails closed. Legacy adoption preserves original metadata/timestamps; conflicting/corrupt evidence is not replaced.

Tests cover cleanup, warm/cold relays, original expiry, unknown and partial restores, conditional concurrent creation and lost acknowledgement. A child process is killed, its metadata is removed while proof/photo remain, and its replacement rejects replay at expiry. Existing first-save, video-history, acknowledged-download restart and missing-asset controls pass.

## R5: temporary reads offer recovery — closed locally

Download/asset reads return retryable 503 for unreadable storage instead of false-expired 404. The subscription caller returns safely before any side effects. Confirmed missing/expired/invalid links remain terminal. The phone page offers **Try again**, retrieves the same token, ignores late/unmounted responses and resumes bounded video polling after recovery. It cannot upload, print, charge or renew the QR.

Chrome against the actual candidate handler and synthetic provider: cold read outage → error/button; recover provider → click → same photo renders; GET 503 → 200, storage writes unchanged. No contact form or sharing control was submitted. Temporary preview services were stopped. Screenshots: `test-results/qr-expiry-phone-retry.png`, `qr-expiry-phone-recovered.png`; request log: `qr-expiry-browser-server.txt`.

## Final evidence

- **126 twin tests**, **27 targeted kiosk tests**, **7 phone recovery tests** pass. Shared upload deadline, slow internet, first requests after idle, pool withdrawal/publication, replay and restart regressions remain green.
- Kiosk TypeScript/full lint/build, phone TypeScript/build/changed-component lint, twin build, candidate JavaScript syntax and byte-exact isolated patch application pass. Existing build/deprecation warnings remain; no dependencies/lockfiles changed.
- Exact patch matches all **23 candidate files**. Reproducible tools: `audit/verify-qr-artifact.mjs`, `audit/prepare-phone-check.mjs`. Saved validation summary: `audit/qr-expiry-validation.json`; detailed local outputs: `test-results/qr-expiry-*`.
- `audit/reproduce-qr-expiry-recovery.mjs` now verifies safe outcomes. The previous unsafe output remains historical in `qr-rereview-open-findings.json`. R3 baseline/candidate comparison still passes and remains separate.

No further blocker was demonstrated by these tests/reviewed paths. This is not whole-application certification: physical Windows/power-loss, full relay integrations, actual R2 conditional operations/retention, Render topology/limits, Cloudflare Pages environment and dependency reachability remain unverified.

## Rollout / rollback implications

The [plan](ROLLOUT-ROLLBACK.md) now includes the phone app and the persistent expiry prefix. Preserve current pool tombstones/distributions/receipts and expiry proof in backups and rollback. Stop legacy writers; freeze the Windows launchers/updaters that can pull `main` over a pin. Existing valid legacy metadata needs preserved-clock adoption; ambiguous old work stays parked. An original relay that ignores expiry proof or a phone build without retry is not the compatible rollback target. All kiosk/cloud gates and exact-artifact authorization remain outstanding; nothing here authorizes deployment.
