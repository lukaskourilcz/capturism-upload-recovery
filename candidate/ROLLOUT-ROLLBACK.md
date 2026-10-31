# Rollout and rollback plan — HOLD: QR replay/expiry and cold-read recovery

**Re-review 2026-10-31: do not release the current artifact until R4 (expired-token replay after metadata removal) and R5 (storage-read failure reported as expired) are resolved and verified.** R3 durable acknowledgement and prior pool/deadline fixes remain locally tested. This plan describes future authorized maintenance; no kiosk/cloud changes or client messages were performed.

## Artifact and evidence to record

| Item | Current evidence / required release value |
| --- | --- |
| Captured monorepo baseline | `1f2df6401997455b456eab9b32d258b997dc4b9d` |
| Reviewed local combined snapshot / implementation | `da37ad8` / `1d7ebac`; these are twin SHAs, not deployed monorepo SHAs |
| Current patch SHA-256 | `dccf9d1f5bffd5e76ad499c7534bafabc81da70d17929ccf311d374d4e667f51` — unchanged production candidate; R4/R5 open |
| Exact artifact check | Patch applied in an isolated directory; all 22 changed files match candidate bytes |
| Local verification | 115 twin tests, 27 targeted kiosk tests; TypeScript, full lint, kiosk/twin builds and syntax checks pass |
| Actual kiosk / relay SHA and topology | Unknown; obtain from running processes/deployment metadata |
| Future release / compatible rollback SHA | Must be recorded after R4/R5 fixes, monorepo review, environment gates and final checks |
| Gate evidence | Responsible operator, timestamp, environment, artifact SHA, expected/actual result; keep private evidence in its approved location |

Local evidence and scope: [final review](FINAL-REVIEW.md), [audit](AUDIT.md), [coverage](AUDIT-COVERAGE.md), [pool protocol](PUBLICATION-FENCING.md), [QR deadline](QR-DEADLINE.md). Do not upload photos, secrets or diagnostic payloads into Git or this plan.

## Gate A — code and isolated staging; all must pass

| Check | Required evidence before approval |
| --- | --- |
| A1: QR persistence blocker | Actual relay path returns a retryable failure on metadata-save error, retains the same client checkpoint, and only acknowledges durable success. Reproduce failed save, ambiguous acknowledgement, replay and relay restart with the stored photo/download intact. Preserve existing video metadata and retention behavior. A1 passes local actual-handler/client/process tests; repeat against the real SDK/provider in isolated staging. R4/R5 remain separate open code/recovery gates A7/A8. |
| A2: Exact final artifact | Record monorepo release SHA, patch hash, dependency lockfiles and coherent helper set; apply/build/test that exact artifact. Repeat all local regression tests on the exact final release artifact. A twin commit alone is not a release artifact. |
| A3: Dependencies | Triage reachable critical/high findings from the captured kiosk/relay audits and record supported upgrades or an explicit risk decision. Captured counts are not a fresh registry scan or an exploitability assessment. |
| A4: Pool provider semantics | Use an isolated R2 bucket/service and synthetic data: conditional QR metadata and image creation, ETag updates/publication, competing relays, withdrawal during body/image/metadata writes, partial cleanup and restart reconciliation. Preserve original portrait bytes and distribution/consent history. |
| A5: QR recovery | In isolated Chrome/bridge/relay: slow link, first request after idle, stalled bodies, lost response and deadline expiry; Retry download uses the original token/completed PUT and never reprints or charges. Touch cannot extend the pending deadline; reset clears recovery before another session. Test all supported languages and screen scaling. |
| A6: Upgrade/rollback matrix | Old pool clients get 426/no PUT URL; new queue on an old relay blocks with bytes retained; old pending/uploaded files migrate with original identity; stale withdrawn backups cannot recreate data; generic 410 retains bytes. Rehearse the compatible rollback below, including scheduled-update behavior. Any new expiry-evidence state/protocol must also survive compatible rollback and legacy-token migration; an old writer must not bypass it. |
| A7: Original QR expiry survives metadata cleanup — OPEN | Resolve R4 before release. Test first confirmation, lost-save recovery and late replay before/on/after expiry with metadata present, removed or partially restored; use warm and fresh relays. Retain authoritative original token/expiry evidence or equivalent validated issuance, so missing metadata cannot mean a fresh 24-hour life. Include video delivery started before expiry but confirmed after it. Preserve legitimate new-token and legacy recovery behavior without trusting client timestamps or renewing old sessions. |
| A8: Cold-read recovery — OPEN | Resolve R5 before release. With intact durable metadata and an empty cache, inject provider read denial/timeout/failure and prove a retryable response, distinct from confirmed missing/expired 404. Exercise download and asset proxy plus all load callers without real subscription/report/message effects. Verify phone-page bounded or explicit retry returns the same token/photo after storage recovers, without falsely claiming expiry. |

Use synthetic data, isolated queues and replacement credentials only. No production fault injection, financial/customer workflows, synthetic customer records, review/rating links or test messages. Full server startup/scheduled integrations are not covered merely by handler tests; staging must prevent real notification/report delivery.

## Gate K — studio Windows kiosk; operator access still needed

We currently have source/hosting access, not the kiosk. These checks remain unverified.

| Check | Required evidence |
| --- | --- |
| K1: Running source and process | Actual checkout SHA/branch, Node/Chrome/Windows versions, working directory, executable/launcher paths, service accounts, ports and bridge process start time. Confirm which wrapper, service or task restarts each process. |
| K2: Startup/update control | Inventory nightly updater, startup and scheduled restart tasks, NSSM services and wrapper loops. The stock `start-kiosk.bat`/`update-kiosk-auto.bat` can stash edits, switch a detached/side-branch checkout to `main` and pull. A detached SHA plus normal relaunch is not a safe pin. Freeze automatic mutation for maintenance and verify the real `main` SHA, or prepare an approved launcher that starts the pinned artifact without its branch guard. Do not execute the Windows launchers here. |
| K3: Disk and recovery | Free space, queue locations, account permissions and one worker per directory. On an isolated representative queue, verify browser close, bridge/process kill, Windows restart and receipt-write/disk-full failure recovery; compare job hashes/counts and terminal receipts. Physical power-loss behavior remains a separate filesystem check. Restart fixtures must not reseed lost assets; validate both metadata and original photo bytes, including a missing-asset negative control. |
| K4: Queue preservation | Privately inventory pending/uploaded/done/withdrawn/blocked/corrupt records and video jobs without exporting portraits/codes. Back up with writers stopped, preserve ownership/ACLs and verify recovery from that backup in isolation. Never clear receipts or restore an old pending record over a terminal receipt. |
| K5: Network/ingress | Actual Vite/direct bridge/LAN/tunnel topology, local HTTPS trust and real forwarded/Host/Origin headers. In an isolated kiosk configuration, prove public-origin and tunneled writes are denied before queue/log mutation, including rewritten headers. A loopback last hop is insufficient. Verify production protections from read-only config; do not probe live write routes with synthetic submissions. |
| K6: UI and idle behavior | Use synthetic staging photos at the measured studio photo/video sizes and uplink/latency, including a real idle interval and browser visibility/sleep settings. Check actual fixed-resolution recovery controls, scan window, next-customer privacy and that QR recovery does not invoke payment/printing. Capture privacy-safe diagnostics with timestamps. Record kiosk/server clock health and test the exact 24-hour UTC timestamp boundary using isolated virtual-clock fixtures; do not change a live kiosk clock for fault injection. |
| K7: Devices and launch order | Arrange an approved operator maintenance procedure for camera/printer/lights/payment-service readiness and bridge order. The stock restart scripts can kill processes broadly. No active capture, card authorization/settlement, print or scan may overlap a restart; do not automate financial transactions from this plan. |

## Gate C — cloud checks still needed

| Check | Required evidence |
| --- | --- |
| C1: Target and automation | Correct Render account/service, root/start/build commands, Node version, active SHA, instance/plan/count, auto-deploy branch/path filters and health/readiness behavior. Confirm from the account; repository prose is not evidence of current settings. Freeze auto-deploy before any release-branch push. |
| C2: Real request limits | Staging evidence that host/proxy/TLS/body buffering allow the v2 authenticated JPEG hop at representative slow speeds. Verify 20 MiB limit, two-body admission, worker twenty-minute budget, relay twenty-minute body timer and twenty-one-minute Node request timeout. Other request-body deadlines and WebSocket health must remain compatible. Do not assume Node settings override hosting limits. |
| C3: Storage permissions/retention | Correct bucket, private access, required Get/List/Put/Delete/Copy permissions and actual conditional-write/ETag behavior. Sessions lifecycle must not affect `pool/`, `pool-portraits/` or `pool-deletions/`. Keep canonical withdrawal fences and live deletion markers permanently; verify backup retention/pruning only affects snapshot prefixes. For the R4 fix, record the retention of authoritative minimal expiry evidence separately from customer media/metadata. Cleanup must not erase that evidence while an old request can still be accepted; the current metadata-only expiry guard does not meet this requirement. |
| C4: Legacy write retirement | Inventory every old relay/booth and all issued published-key presigns. Stop old writers and reconcile in-flight requests. Rehearse revocation/rotation of the signing capability with all QR/video/pool consumers identified. Code cannot revoke old URLs; URL expiry alone does not prove an already-accepted write ended. If retirement cannot be established, stay closed. |
| C5: Current backups | Recoverable current snapshots of pool metadata/images plus canonical tombstones and deletion markers, protected with appropriate access. Verify object counts/hashes/errors rather than trusting only a backup timestamp: the baseline backup can log individual copy failures and still write a last-run marker. Never restore a pre-withdrawal snapshot over newer fences/history. Verify metadata/photo pairs and the original expiry evidence after a restore; a session JSON object alone does not prove an intact recoverable download. |
| C6: Integrations and safe observation | Review startup backup/reconciliation, review/email/report timers and monitoring alerts. Isolated staging must not send real messages. Production verification is bounded/read-only: deployed SHA, provider/config/log metadata and `GET /api/health`. A GET is not automatically read-only: download routes can probe/persist session metadata, admin pool listing can trigger reconciliation, and rating/report routes have effects. Do not use those as production smoke tests. |

## Maintenance and controlled release — only after explicit authorization

1. Resolve R4/R5, complete A1–A8, and prepare the approved compatible rollback artifact. Record all K/C gate results and responsible operators. Obtain release authorization for the exact monorepo SHA/environment. Do not push incidental audit commits: an auto-deployed push can itself release code.
2. Close the booth/disable new l'INCONNU collection (`VITE_LINCONNU_DISABLED=1`, after checking how the actual Vite process reads it). Record the original setting. Let customer/payment/print/scan flows settle. Freeze updater/restart tasks, launcher branch switching and auto-deploy; stop old writer processes/wrappers so they cannot return unnoticed.
3. With writers stopped, back up source/config/launcher references, private queue/video/diagnostic folders, receipts and device/media counters. Snapshot current storage including withdrawal fences. Reconcile each accepted job and any legacy random-id upload; do not invent a new session/consent to make a mismatch disappear. Keep secrets only in approved private storage.
4. Retire outstanding legacy published-key write capabilities and reconcile accepted in-flight writes using the rehearsed provider procedure. Rotation can affect QR/video and every other credential consumer. Privately update required environments and confirm the intended capability is active; never restore revoked credentials as a rollback shortcut.
5. Install the approved relay **first**, including the reviewed R4/R5 fixes and `server.js`, `session-metadata.cjs`, `pool.js`, `pool-publication.cjs`, `pool-retry.cjs`. Check exact deployed SHA, bounded health and logs/config. Readiness requires completed storage reconciliation, not only a healthy process. Do not invoke customer routes to demonstrate it.
6. Update the quiescent kiosk to its reviewed coherent artifact, retaining queues/receipts in place. Use the approved pinned/main-aligned launcher path from K2; verify the actual SHA again **after** launch and after any planned automatic restart. Hard-refresh Chrome. Check local readiness and protected endpoint configuration. A browser pool ACK means saved locally until a remote receipt exists.
7. Reconcile/drain accepted jobs under the compatible worker without changing identity. Blocked/corrupt/conflicting/withdrawn or incomplete withdrawal cleanup requires review; no automatic consent renewal, receipt clearing or blind unblock. Account for every accepted portrait and preserve published pixels/history.
8. Enable new collection only after all gates pass and job effects are accounted for. Restore approved automation only when its branch/commit/config cannot undo the rollout. Observe ordinary sessions and the first real after-idle session; retain timestamps and safe logs. No automated production fault injection, payments, prints or client messages.

No Cloudflare Pages admin/download deployment is included in the current patch; the R5 resolution may add one and must be reviewed explicitly. A release needs a final actual-environment approval; this local plan grants none.

## Stop / rollback decision matrix

Stop collection for a wrong/late QR, a QR that vanishes after relay restart, renewed expiry after cleanup/replay, false-expired responses during a provider outage, changed/withdrawn portrait reappearing, duplicate identity, lost local acceptance/receipts, public local-write access, cleanup failure, growing unrecoverable backlog or camera/printer/payment regression. Preserve evidence before any restart.

| Point of failure | Safe response |
| --- | --- |
| Before any release/state change | Leave existing versions intact, keep the prepared artifact private and investigate. Do not rotate credentials or push code just to test. |
| New relay, old kiosk still stopped | Keep collection closed. Use the approved compatible forward fix/rollback preserving v2 fences and QR durability; verify exact service SHA. Do not enable legacy sign/join to make the old UI work. |
| New kiosk, no sessions accepted | Stop wrappers/worker safely; restore the reviewed compatible kiosk/UI/config artifact. Verify K2 branch guard/updater cannot switch it back. Keep the v2 relay and private queue state. |
| Accepted pool jobs or new tombstones exist | Prefer collection off with the compatible worker/relay retained. If delivery is implicated, park the worker with files unchanged and reconcile privately. Empty queue alone does not make legacy relay downgrade safe. |
| R2/signing capability already rotated | Keep the replacement credential/config and update the compatible artifact to use it. Do not re-enable a retired published-key capability or paste secrets into Git to make old code run. |
| Original expiry cannot be established for an old replay/job | Keep delivery/collection paused for the affected work and reconcile privately. Never change the token, create a new retention clock, remove expiry evidence or revive the session just to drain a queue. |
| New business data/distributions/withdrawals exist | Preserve current durable effects; forward fix. Never blanket-restore an older bucket snapshot or delete canonical tombstones/receipts or any authoritative expiry evidence introduced by the R4 fix. Any full downgrade needs a separately reviewed migration/reconciliation. |

A UI-only revert is acceptable only with collection disabled and a coherent reviewed helper/store set; keep protocol-2 delivery/fencing, durable QR acknowledgement and the reviewed expiry/read-recovery behavior. After R4 introduces authoritative expiry evidence, an older metadata writer that ignores it is not a compatible rollback. Do not revert an arbitrary subset of `qrUploadState`, store reset, deadline helper and screen code. QR recovery itself is page/session memory and is lost on reload; never restart an active customer session expecting that state to survive.

Full legacy relay rollback is **not approved** after v2 state exists: it ignores terminal fences and can reissue mutable published-key URLs. Never `git clean -fdx`, re-identify jobs, clear receipts, overwrite current queues from old backups, or blindly restore source followed by a stock launcher that pulls `main`. Record installed/running SHAs, private state backup and read-only provider evidence at each step.

## Phone download target and recovery scope

The current patch does not change Cloudflare Pages download/admin source. R5 exposes that the unchanged phone page treats 404 as invalid/expired and has no retry after the first failed fetch. If the resolution adds phone-page recovery, include its exact build/deployment target, frontend/relay compatibility and rollback artifact in the release manifest. Do not assume returning 503 alone adds a retry control. Any Pages release needs separate explicit authorization; none is performed here.

## Current rehearsal status

Local artifact equivalence, 115 twin tests, 27 targeted kiosk tests, TypeScript/lint/build and additional receipt/fairness/auth-router checks pass. The before/after R3 reproduction now verifies baseline false success versus candidate retryable failure, then durable success and a recovered download after restart. A real relay handler process also passes SIGKILL/restart and photo-byte retrieval using an isolated disk-backed provider. Actual Windows/device/idle, real provider semantics/revocation, hosting limits, tunnel protection, dependency disposition and controlled launch/rollback remain unverified. The 2026-10-31 re-review separately reproduces R4/R5 as unsafe; passing regression tests do not close them. The corrected restart fixture no longer manufactures photos and includes a missing-asset negative control. Everything performed stayed local.
