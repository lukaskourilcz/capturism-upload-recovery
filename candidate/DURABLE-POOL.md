# Durable pool delivery — local candidate

Prepared and tested locally against Capturism `1f2df64`. No deployment, push or client message was performed.

## Handoff contract

`joinPool()` converts the selected portrait to JPEG and POSTs the bytes, quiz code, session id and seed flag to the existing local bridge at `/api/pool-queue`. It retries a transient local handoff failure up to five times, using the same portrait. A true result now means **saved to the local queue**, not **delivered online**. The printing screen reports a local-save failure accurately.

The bridge validates the bounded request, derives a stable job identity and writes one self-contained JSON file containing both the portrait and its delivery details. It writes a temporary file, flushes the file, renames it atomically and attempts to flush the directory before acknowledging. Directory flush support differs on Windows filesystems. The durability guarantee starts after this acknowledgement; closing Chrome before the handoff finishes can still interrupt the portrait's initial encoding or transmission. Disk failure, deleting the queue folder or catastrophic filesystem damage cannot be recovered by this queue.

## Restart and duplicate handling

- `pool-queue.cjs` runs in the bridge, independently of Chrome. It scans pending jobs at startup and every 15 seconds. Browser reload/close no longer cancels accepted delivery.
- Job phases are pending → uploaded → done. A successful portrait PUT is checkpointed before confirmation. A restart after that point retries only confirmation. A crash before the checkpoint may resend identical bytes to the same object key.
- The earlier relay protocol still derives a stable entry id and accepts repeated confirmation idempotently. A lost commit acknowledgement, lost local acknowledgement, duplicate enqueue, or restart therefore cannot create a second pool entry for that operation. Re-enqueuing the same identity with different bytes/seed returns a conflict rather than replacing the acknowledged portrait.
- Successful confirmation atomically replaces the job with a small completion receipt. Local photo bytes, quiz code and session id are removed. The receipt retains only hashed identity, photo digest, seed flag and completion time for duplicate prevention.
- Jobs are checksum-validated before delivery. Incomplete `.part` files are discarded; damaged records remain visible as corrupt for operator attention. They are never uploaded as if valid.
- The bridge and relay patches must be reviewed together. The new queue requires the explicit idempotent relay protocol and blocks incompatible responses instead of falling back to unsafe delivery.

## Limits and operator attention

The worker delivers one portrait at a time at 25 KiB/s. The existing video queue remains capped separately at 50 KiB/s. Transient network/storage failures use a persisted 1, 2, 4… minute backoff capped at 30 minutes. No periodic USB rescan or hardware recovery is added.

Each portrait is limited to 20 MiB. Total queue disk usage, including receipts and blocked jobs, is capped at 1 GiB; a full queue rejects a new handoff instead of falsely acknowledging it. Permanent errors block the job. After 24 hours, automatic delivery stops and the portrait is retained for operator review because the underlying redeemed quiz record has a limited lifetime. Nothing silently deletes an undelivered portrait. Blocked/corrupt jobs need review and cleanup; there is no automatic unbounded delivery loop or automatic consent renewal.

On an eventual kiosk installation, pending jobs live in **`pool-queue/` beside `payment-bridge.js`**. They necessarily contain a portrait and redeemed quiz code until delivery. The directory is created with owner-only permissions where supported (Windows access follows the kiosk account/filesystem permissions). The candidate `.gitignore` excludes the queue and diagnostics folders. The status response used by the twin exposes phases/attempt counts only. Diagnostic events never include portrait bytes, quiz codes, session ids or signed URLs.

Do not clear this folder as part of an update/restart. The configured bridge must run for delivery to resume. The twin uses a separate queue folder per experiment; starting a fresh test creates a new experiment, while **Restart bridge** reopens that experiment's same queue.

## Local evidence

- Atomic write and disk-failure tests: interrupted replacement preserves the old acknowledged record; incomplete temp files never become jobs; full disk budget refuses a new handoff; corrupted bytes are detected.
- Browser-client test: the first local acknowledgement is lost after persistence; retry and concurrent browser calls leave one job. The browser environment is then removed and a new bridge process completes delivery.
- Process-crash test: a real bridge child is killed with SIGKILL during PUT. A different process reopens the queue and delivers one pool entry.
- All five idle-failure presets recover after reconstructing the worker from disk: signing, portrait PUT, join, lost join response and failed pool persistence. Confirmation failures do not re-upload checkpointed portraits.
- Successful receipt tests confirm local portrait/code/session data are removed. Re-enqueueing after completion is accepted as already delivered.
- Browser verification: a portrait was acknowledged locally, Chrome reloaded to discard its JS state, and the bridge restarted. The same saved job continued delivery independently of the original page.

Time advancement in the deterministic unit tests skips backoff waits without changing the production backoff rules. Actual child-process tests use real HTTP and real process death. This does not constitute a physical Windows power-loss test or a reproduction of the studio's real two-hour idle root cause.

The previous direct-browser retry client is retained only as a regression fixture in `test/fixtures/browser-pool-retry.ts`. The shipped candidate uses the bridge queue.
