# Durable pool delivery — local protocol 2 candidate

Prepared against Capturism `1f2df64`. No deployment, push or client message. See [publication/withdrawal guarantees](PUBLICATION-FENCING.md) and [audit](AUDIT.md).

## Handoff and durability

`joinPool()` JPEG-encodes the selected portrait and sends bytes, quiz code, session id and seed flag to local `/api/pool-queue`. Transient local handoff retries reuse the same portrait. Success means **saved locally**, not delivered online. Printing reports local-save failure accurately.

The bridge validates a bounded request and saves one self-contained JSON file with identity and photo. It writes a temporary file, flushes it, renames atomically and attempts directory flush before acknowledging. Windows filesystem support varies. Durability starts after this acknowledgement; page closure before JPEG conversion/handoff completes, destructive queue-folder deletion and catastrophic disk damage are outside the guarantee. Physical Windows power-loss behavior is not verified.

## Restart and duplicate handling

- The Node bridge scans at startup and every fifteen seconds, independently of Chrome. Accepted delivery survives browser disappearance and tested process SIGKILL/restart.
- Current phases are pending → done, with blocked/corrupt for attention and withdrawn as a terminal receipt. Old uploaded checkpoints remain readable. Both pending and uploaded jobs use retained bytes with the same stable identity under publication protocol 2; no old signed URL is replayed as authority.
- The worker POSTs JPEG plus identity/digest to the authenticated relay upload endpoint. The relay conditionally reserves and publishes once; it never returns a mutable published-key PUT URL. A committed retry acknowledges the same bytes/consent/history without another write. A stale job after withdrawal cannot recreate the entry.
- Success atomically replaces the job with a small done receipt. A withdrawal response must have HTTP 410, matching entry id, `withdrawn: true` and protocol version 2 before replacing it with a withdrawn receipt. Both receipts remove local photo/code/session and retain only hashed identity, digest, seed and completion time. Generic or malformed 410 responses retain the photo in a blocked job.
- Re-enqueue after completion reports already delivered. Changed bytes/seed conflict. Re-enqueue after a withdrawn receipt returns 410. Checksum/metadata errors retain a corrupt record for review; incomplete temporary files are discarded, never acknowledged.
- Local completion history and canonical relay tombstones must survive updates/rollback. Do not clear receipts, change sessions or restore old pending files over newer receipts.

## Bounds and attention

The worker sends one portrait at 25 KiB/s; the unchanged video queue separately uses 50 KiB/s. Transient delivery failures persist 1, 2, 4… minute backoff capped at thirty minutes. Request budget is twenty minutes, portrait limit 20 MiB. The relay admits two bounded pool bodies concurrently. No USB rescan or hardware recovery is added.

Queue usage is capped at 1 GiB including blocked jobs and receipts. Full queues reject new handoff rather than acknowledge unsaved photos. Permanent failures block; after twenty-four hours automatic delivery stops and retained bytes require operator review. There is no automatic consent renewal or silent undelivered-photo deletion. Validated withdrawal is the intentional terminal cleanup exception. There is no automatic operator unblock tool.

Jobs live in `pool-queue/` beside `payment-bridge.js`, containing private portraits/codes until a terminal receipt. Owner-only permissions are requested where supported; Windows permissions follow the kiosk account/filesystem. Candidate `.gitignore` excludes queue and diagnostic folders. Status exposes phases/attempts only; safe diagnostic events exclude payloads, codes, session ids and signed URLs. One worker per directory is required; there is no inter-process directory lock.

The twin uses a private queue per experiment. Restart bridge reopens the same experiment's directory; starting a new experiment intentionally creates another. Restarting the whole lab does not restore its in-memory session dashboard. Tests separately reopen the actual queue/relay state.

## Evidence and compatibility

The 132-test twin suite covers atomic write/disk failures, quotas/corruption, lost local ACK, concurrent handoffs, browser disappearance, actual bridge SIGKILL, all five after-idle failure presets, ambiguous remote commit, old uploaded checkpoint migration and a stale pending backup after withdrawal. Replay after relay restart preserves portrait pixels and distributions; withdrawal tests cover cross-relay races and partial cleanup. No timing test establishes the cause of the studio incident.

Historical direct-browser protocol 1 remains only in `test/fixtures/browser-pool-retry.ts` and old-model comparison routes. The candidate relay rejects old sign/join clients with 426; the new worker on an old relay blocks and retains bytes. The queue and relay must be installed together during a closed, reconciled cutover. Outstanding old upload capabilities must be retired first. See [rollout/rollback](ROLLOUT-ROLLBACK.md); a blanket legacy relay rollback is unsafe.
