# Rollout and rollback plan — not authorization to deploy

**Current decision: HOLD.** The deletion-replay and published-portrait overwrite blockers in [AUDIT.md](AUDIT.md) must be resolved first. This is a future procedure, not a set of actions performed now. No production credentials are required to review it.

## Gate 0 — establish a releasable artifact

1. Resolve R1/R2 with a reviewed relay/storage protocol and adversarial tests. Keep original consent/withdrawal behavior authoritative; do not ship only a longer timeout and describe the idle issue as solved.
2. Rehearse exact old/new kiosk and relay combinations in isolation, including old-client compatibility, restored pending/uploaded/done queue files, withdrawal, stale backups and uncertain remote outcomes. Verify published bytes and distribution/consent preservation, not just record counts.
3. Run all queue/relay tests, full kiosk lint (`npm run lint -- --max-warnings 0`), `npx tsc -b` and the production build on the final source. Review reachable critical/high dependency advisories and record their disposition. Regenerate/check the patch and record a release commit SHA; the local twin Git SHA is not a production monorepo release SHA.
4. Use an isolated staging bucket/relay and synthetic, explicitly local fixtures. Never reuse live keys for failure injection. Do not inject faults or create synthetic customer entries in production as a smoke test.

## Gate 1 — prepare the studio, outside opening hours

1. Arrange a closed maintenance window with enough time to revert before 09:30. Confirm no customer session, card authorization, payment settlement, print job or scan is active. `git pull` changes the Vite-served kiosk immediately, and bridge restart also affects payment/printer/camera infrastructure.
2. Record actual kiosk checkout SHA and branch, bridge launch paths, Node/Chrome/Windows versions, filesystem and free space. Record Render's active SHA, project/service and instance configuration. Verify deployment topology against the actual account; the README's plan/auto-deploy statements are not sufficient.
3. Verify only one bridge/worker can use the queue directory. Check local-only routes through real Vite, direct network access and the Cloudflare tunnel. Requests arriving through the public hostname must be denied before queue/diagnostic writes, including configurations that rewrite Host. If that cannot be established, keep release on hold.
4. With the relevant processes stopped and no session active, make a private, access-controlled backup of source references and runtime folders: `pool-queue/`, `video-queue/`, `diagnostic-logs/`, printer/media counters and launcher/config files. Keep secrets on the kiosk or its approved private backup destination; do not paste them into Git, logs or this chat. Record job phases/counts without exposing payloads.
5. Verify an up-to-date recoverable backup/snapshot of relay pool metadata and relevant storage state. Source rollback must not overwrite live pool data, distributions, withdrawals or sales. Weekly backups alone may not represent current state.
6. Keep l'INCONNU collection disabled during the staged change using the existing kiosk kill switch (`VITE_LINCONNU_DISABLED=1`) or keep the booth closed. Capture the original setting for restoration. This stops new collection; it must not delete or re-identify accepted jobs.

## Controlled rollout, after explicit deployment authorization

1. Publish the reviewed **relay compatibility layer first**, including all required helpers. Pushing/merging to monorepo `main` auto-deploys Render and restarts its connections; it is itself a release action. Do not push incidental audit commits to trigger stats.
2. Check the exact deployed SHA and bounded read-only health/log signals. Verify successful storage hydration and expected protocol version through staging evidence/configuration; do not call production sign/join/match/payment routes to prove deployment.
3. While the booth remains quiescent, update the kiosk to the recorded release SHA. Confirm helper files and runtime ignores are present. Preserve the original queue directory in place; no `git clean -fdx`, folder replacement, job deletion, or queue-format reset. Keep cloud credentials only in the bridge environment.
4. Relaunch through the existing operator launcher outside business hours so the bridge loads the new code; hard-refresh Chrome. Verify local readiness, diagnostics and queue phase counts. A queued portrait must be labeled accepted locally until remote confirmation completes. Confirm unrelated payment/camera/printer services are ready using established non-customer checks; do not perform financial transactions from the rollout procedure.
5. Reconcile any pre-existing accepted jobs with remote state while maintaining the same identity. Allow the compatible worker to drain. Blocked/corrupt/withdrawn/conflicting jobs require explicit review; they are not permission to generate a fresh id or renew consent. Never replay a stale backup over a newer completion receipt.
6. Enable new l'INCONNU collection only once all gates pass and accepted jobs are accounted for. Monitor the first normal sessions and the first session after a real idle interval. These are observations of ordinary operator/customer use, not automated production fault injection. Retain precise timestamps and local diagnostic files.

No admin/download Pages deployment is required by this patch; those projects are manual and should remain outside this release.

## Stop / rollback triggers

Stop collection for any duplicate entry, mismatched portrait/consent, withdrawn data reappearing, missing local acceptance record, loss of completion receipts, unexpected queue rewrite, unexplained permanent conflicts, public access to local-write endpoints, growing unrecoverable backlog, or regressions affecting payment, camera or printing. Preserve evidence before restarting.

## Preferred rollback: UI collection off, compatible delivery retained

1. Stop new l'INCONNU sessions and wait for any customer/payment/print flow to finish. Record installed SHAs, times, queue phase counts and read-only remote state.
2. Keep the compatible idempotent relay available. Keep the reviewed bridge worker available to settle acknowledged jobs, unless delivery itself is implicated in incorrect data/withdrawal—in that case stop the bridge outside operating hours and preserve all queue files for reconciliation.
3. A frontend revert can use the prior reviewed UI with l'INCONNU disabled while the compatible bridge finishes accepted jobs. Do not enable the old direct browser pool upload while uncertain durable jobs exist: it mints different entry identities and can defeat duplicate reconciliation.
4. Prefer a reviewed forward fix for the relay compatibility layer over a wholesale relay revert. Record every already-applied data effect; do not restore a pre-rollout R2 snapshot over current records.

## Full legacy rollback, only after accounting for accepted jobs

1. Confirm there are no pending/uploaded jobs or in-flight confirmations, or explicitly park the implicated queue with delivery stopped and collection disabled. Account for every accepted portrait; blocked/corrupt is not the same as delivered.
2. Stop the bridge before changing its source/runtime configuration. Preserve queue and receipt files byte-for-byte in a private backup. Never manufacture new session ids, clear receipts or overwrite the active queue with an older backup.
3. Restore the recorded pre-release kiosk SHA/configuration and relaunch safely. If a legacy relay must also be restored, do it **after** v1 workers are stopped/drained. The legacy relay rejects the new protocol; downgrading it underneath a running queue can permanently block accepted work.
4. Verify exact kiosk/relay SHAs and read-only readiness. Keep l'INCONNU disabled until unresolved jobs, data effects and original failure exposure are reconciled. Retain the compatibility worker artifact and private queue backup for controlled recovery—an old checkout alone cannot deliver them.

## Rehearsal status

Local tests cover process death during PUT, restart, ambiguous/lost acknowledgements, saved entries surviving relay restart, phase checkpoints, checksum corruption, disk-write failure, queue limits and duplicate conflicts. Compatibility rehearsals using actual old/new relay handlers confirm new relay + old browser succeeds, while new queue + legacy relay blocks safely with portrait bytes retained. There is no automatic unblock after an incompatible rollback; a later recovery needs explicit reconciliation. The patch applies cleanly to the captured baseline. Local TypeScript, lint and build evidence is recorded in the audit.

Actual Windows restart/filesystem behavior, real reverse-proxy/tunnel denial, a physical hardware maintenance cycle, provider conditional-write/revocation behavior and the full old/new rollout/rollback matrix remain gates. R1/R2 are still demonstrably unsafe; this plan is deliberately not a green light to roll out the current patch.
