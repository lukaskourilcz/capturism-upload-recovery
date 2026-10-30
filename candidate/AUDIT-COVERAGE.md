# Patch audit coverage

Scope: complete candidate against Capturism `1f2df64`; tested implementation `8f738df`. Earlier hardening `0dd1d4f` retained. Local replacements only; no production requests, credentials, deployment, device operations or messages.

| Area | Files / callers | Status / evidence |
| --- | --- | --- |
| Queue acceptance, checksums, receipts | `pool-queue.cjs`, bridge POST, browser `joinPool` | Reviewed/tested: process kill, lost local ACK, corruption, disk failure, quotas, duplicate/conflicting handoff, old uploaded checkpoint migration, withdrawn receipt and generic 410 retention. Single-writer/physical Windows limits remain. |
| Immutable publication / identity | `pool-publication.cjs`, `pool.js`, `server.js` route, quiz lookup | Reviewed/tested actual handlers: digest binding, commit-time conditional image/record writes, competing relays, lost provider ACK, retired/history preservation, legacy digest verification. R2 blocker closed locally. Full server runtime/provider auth execution unverified. |
| Withdrawal / replay / startup | canonical tombstone, deletion marker, `withdraw`, hydration, match persistence, portrait/list reads | Reviewed/tested: delayed body/image/metadata, cross-relay races, partial cleanup, lookup outage, stale backups, stale match writes and restart orphan cleanup. R1 closed locally. No claim of atomic multi-object physical deletion. |
| Upgrade / rollback | old sign/join endpoints, new worker, legacy relay | Tested: old browser rejected with 426/no URL; new queue + old relay blocked with bytes retained. Old pending/uploaded jobs use v2 with original identity. Outstanding old write capabilities and real cutover remain gates. |
| Browser QR / timing | `relayUpload.ts`, `qrWaitPolicy.ts`, `ByePage.tsx`, `Printing.tsx` | Reviewed call sites, tests cover confirmation-only retries, token privacy, 5/10-minute policy and local-save failure. End-to-end absolute deadline remains medium open. |
| Diagnostics / ingress | `diagnostics.ts/cjs`, `App.tsx`, bridge proxy, `local-request.cjs` | Reviewed/tested allowlist, rotation, reopen, bounds, failure isolation, listeners, cross-origin/forwarded/Host rejection. Actual tunnel stripping/rewrites remain unverified. |
| Test fidelity / performance | twin, local disk storage, handler fixtures, child processes | 71 tests pass. Real local HTTP/disk/SIGKILL; mock R2 has commit-time ETags and failure hooks. Historical v1 browser tests are fixtures, not the shipped protocol. Earlier queue scan measurement recorded; new relay performance unmeasured. |
| Build / dependencies | baseline lockfiles, candidate kiosk overlay | TypeScript, full lint, production/twin builds, JS syntax and patch check pass. No new dependencies. Baseline advisory reachability/upgrade triage remains open. |
| Payments / camera / printer / lights | unchanged surrounding bridge paths | Diff/callers checked for unintended changes; no device or financial execution. Full hardware operation unverified. |
| Cloudflare Pages admin/download | unchanged applications | No deployment needed by this patch; no write actions performed. |
| Actual Windows, R2, Render and kiosk versions | external runtime | Unverified. Conditional permissions, retention, credentials cutover, hosting limits, disk recovery and studio idle evidence are release gates. |

Evidence paths and remaining decisions are recorded in [AUDIT.md](AUDIT.md). Green local tests do not certify untested provider/hardware behavior.
