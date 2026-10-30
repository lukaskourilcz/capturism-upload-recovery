# Rollout and rollback plan — not authorization to deploy

**Current decision: local R1/R2 fixes pass; production remains on hold for environment, provider and cutover gates.** This is a future maintenance procedure. Nothing below has been performed on the studio or hosting accounts.

## Gate 0 — establish a releasable artifact

1. Review the complete [audit](AUDIT.md) and [protocol 2 contract](PUBLICATION-FENCING.md). Tested local implementation is `8f738df`; the twin SHA is not a production monorepo release SHA. Record the actual release SHA and patch hash. Keep the QR absolute-deadline issue and baseline dependency advisories explicit rather than claiming the historical idle cause is solved.
2. Repeat the 71 local checks and full kiosk TypeScript/lint/build on the exact release source. Review critical/high dependency reachability and supported upgrades before accepting that risk.
3. In an isolated staging relay/bucket with synthetic fixtures and no live credentials, verify real R2 conditional writes, ETags, IAM and lifecycle rules. Rehearse competing relay publication/withdrawal, restart, partial deletion and orphan reconciliation. Confirm canonical tombstones and deletion markers are not removed by lifecycle/backup cleanup.
4. Verify the new authenticated body route, twenty-minute body budget, twenty-one-minute Node request timeout, hosting/proxy limits, 20 MiB size limit and two-upload admission under a representative slow uplink. The relay now carries pool JPEG bytes; measured local queue scans do not benchmark this new hop.
5. Rehearse old/new source and saved queue formats. Expected results: old sign/join clients receive 426 with no URL; v2 queues on an old relay block and retain portraits; old pending/uploaded jobs migrate using retained bytes and the original identity; withdrawn backups return a verified 410 and scrub only the corresponding job. A generic 410 must retain bytes. Rehearse data-preserving rollback with v2 fences retained.

Do not inject faults, seed synthetic customer records, trigger financial/customer workflows or send test messages in production.

## Gate 1 — prepare a closed maintenance window

1. Keep the booth closed or l'INCONNU disabled using the established `VITE_LINCONNU_DISABLED=1` switch. Record the original setting. Verify no customer, payment settlement, camera/print operation or active scan is in progress. A kiosk `git pull` can change the served UI immediately; a bridge restart also affects device/payment services.
2. Record kiosk checkout/branch, actual launch paths, Node/Chrome/Windows/filesystem/free space, active relay SHA/service/instance settings, and every writer that shares the pool bucket or R2 credential. Confirm deployment topology and auto-deploy configuration from the account rather than repository prose.
3. Stop **all** old pool writers, including open browser tabs, bridges and any other relay instance. Prevent automatic restarts with old code. Settle in-flight uploads/confirmations and inventory acknowledged jobs against existing remote records. Legacy random-id browser uploads may not reconcile automatically with a stable-id queue; unresolved histories require operator review, never a fabricated new session or consent.
4. Retire outstanding legacy published-key write capabilities before enabling v2. Code cannot revoke already-issued presigned URLs. Inventory their TTLs and all users of the signing credential; rehearse provider credential/key revocation or rotation, reconcile already-in-flight writes, and privately update every authorized QR/video/relay consumer affected. A rotation can affect more than pool uploads. Do not assume merely waiting for one URL to expire terminates a request already accepted by storage. If safe retirement cannot be established, remain closed.
5. With writers stopped, take access-controlled backups of source/config/launcher references and runtime `pool-queue/`, `video-queue/`, `diagnostic-logs/` and device/media counters. Keep secrets in their approved private location. Record phases/counts without logging portraits/codes. Verify a recoverable, current pool snapshot includes both `pool/` canonical tombstones and `pool-deletions/` markers; do not rely on an older weekly snapshot to represent newer withdrawals.
6. Check there is one bridge worker per queue folder. Verify new local-write routes are denied through actual Vite, LAN and Cloudflare tunnel paths, including rewritten Host/Origin. If a proxy strips provenance, establish protection at that boundary before release. Verify Windows permissions and restart durability under representative backlog.

## Controlled rollout — only after explicit deployment authorization

1. Keep collection disabled and legacy writers stopped. Install the reviewed **protocol-2 relay first**, including `pool.js`, `pool-publication.cjs`, `pool-retry.cjs` and `server.js`. Pushing/merging an auto-deployed branch is itself a release action; do not push incidental commits to increase activity statistics.
2. Confirm the exact deployed SHA and bounded read-only health/log signals. Verify successful startup reconciliation and storage configuration using staging evidence and deployment metadata. Do not call production upload/sign/join/match/payment routes as smoke tests. A pool status endpoint alone does not prove storage hydration.
3. Update the quiescent kiosk to the recorded release SHA and install all bridge/diagnostic/queue helpers. Keep its existing queue folder and receipts in place; no `git clean -fdx`, replacement with an old snapshot, receipt deletion or queue reset. Store cloud credentials only in the bridge environment.
4. Relaunch through the normal operator launcher and hard-refresh Chrome. Confirm local readiness, safe diagnostics and queue phase counts. A browser acknowledgement must mean saved locally until the remote receipt arrives. Use established non-customer device readiness checks without automated charges, prints or client messages.
5. Reconcile and drain accepted jobs under v2 with the same identities. Blocked/corrupt/conflicting/withdrawn jobs require review; never automatically unblock by changing identity, clearing receipts or renewing consent. Confirm matching history and old committed portrait bytes remain unchanged. Re-verify partial withdrawal/orphan cleanup through approved operator evidence, not production fault injection.
6. Enable collection only after all gates and job reconciliation pass. Observe ordinary first sessions and the first session after a real idle interval; retain precise timestamps and privacy-safe diagnostics. Do not claim a fix of the historical studio root cause based solely on local fault models.

No admin/download Cloudflare Pages deployment is required by this patch.

## Stop and rollback

Stop collection for recreated withdrawn data, changed portrait pixels/consent, duplicates, missing local acceptance, lost receipts, unexpected queue rewrites, public access to local writes, cleanup failures, growing unrecoverable backlog or payment/camera/printing regressions. Preserve evidence and state before restarting.

The preferred rollback is **collection off, v2-compatible relay and recovery retained**. Wait for active customer/device/payment flows to finish. Keep the reviewed worker to settle accepted work unless delivery is itself implicated; then stop it and preserve its queue. A UI revert is allowed only with old direct pool collection disabled. Prefer a forward fix to the relay.

**Do not restore the legacy writable relay after v2 state or withdrawal fences exist**, even if the queue is empty. Old code ignores these terminal records and can issue mutable published-key URLs again. A source rollback must retain the v2 publication/withdrawal layer and its helpers; a full downgrade would require a separately reviewed migration and reconciliation of every durable effect. Never restore a pre-withdrawal R2 snapshot over newer state.

If parking the queue, stop its bridge before changing source/config and preserve jobs/receipts byte-for-byte in a private backup. Account for each portrait; blocked/corrupt is not delivered. Do not restore stale pending files over done/withdrawn receipts. Keep v2 artifacts available for controlled recovery. There is no automatic unblock after connecting a queue to an incompatible old relay.

## Rehearsal status

All local protocol/recovery tests pass, including actual bridge process death and local HTTP/disk tests. Patch, TypeScript, lint and builds pass. Real provider revocation/conditional behavior, full server hosting limits, Windows power-loss/restart, tunnel denial, physical maintenance cycle, dependency disposition and the complete environment cutover/rollback remain unverified release gates. No deployment or provider mutation was performed.
