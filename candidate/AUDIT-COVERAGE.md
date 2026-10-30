# Patch audit coverage

Scope: combined candidate patch against Capturism `1f2df64`; starting local revision `e649a43`. Local replacements only; no production requests, credentials, device operations, deployment or messaging.

| Area | Files / callers | Final status / evidence |
| --- | --- | --- |
| Queue acceptance, persistence, checksums, receipts | `pool-queue.cjs`, bridge POST route, browser `joinPool` | Reviewed/tested: process-kill and acknowledgement recovery, byte retention, blocked/corrupt states, quota and receipt cleanup. Added recovery metadata validation. Single-writer limitation remains. |
| Relay identity / durable acknowledgement | `pool.js`, `pool-retry.cjs`, quiz lookup | Reviewed/tested: concurrent join, durable save failure, hydration/restart and seed conflict. Published bytes remain mutable (R2 blocker). |
| Cross-boundary withdrawal and replay | pool delete handler, deletion log, retry coordinator | Reviewed and unsafe replay reproduced using actual handlers. R1 remains open; artifact in test-results, script in audit/. |
| Old/new client coexistence and rollback | legacy pool branch, manual kiosk update, Render auto-deploy | Tested new relay + old client and new queue + old relay. Downgrade blocks delivery and retains bytes. Full real-environment rehearsal remains a release gate. |
| Browser upload and timing | `relayUpload.ts`, `qrWaitPolicy.ts`, `ByePage.tsx`, `Printing.tsx` | Reviewed all changed call sites. Existing tests cover confirmation-only retry, late-token guard and 5/10-minute policy. Real idle cause/hardware rendering still unverified. |
| Diagnostic safety / listeners / proxy | `diagnostics.ts`, `diagnostics.cjs`, `App.tsx`, bridge forwarding | Reviewed/tested allowlist, rotation/reopen, bounded requests, failure isolation and listener cleanup. Local proxy provenance guard added. |
| Dev server and external ingress | existing Vite `/api` proxy and tunnel configuration | Vite source confirms generic proxy precedes normal handlers and changes origin Host. Local origin/forwarded/Host-denial tested. Actual tunnel/header rewrite behavior remains unverified and is a release gate. |
| Tests / simulation fidelity | twin, process tests, relay handler mocks | Full suite and adversarial reproductions run locally. No provider writes. Known-bug scripts are explicitly separate from passing safety checks. |
| Dependencies and build | baseline lockfiles, candidate source overlay | No new production dependencies. Full TypeScript/lint/Vite build passed; registry advisory counts recorded; real exploitability/upgrade triage not completed. |
| Payments / camera / printer / lights | surrounding bridge paths | Reviewed diff/callers for unintended effects; no API contracts changed. Hardware and financial execution deliberately excluded. |
| Cloudflare Pages admin/download | unchanged code and manual deployment targets | Not applicable to release patch; no deploy planned |
| Actual Windows, R2, Render and kiosk versions | external runtime | Unverified; explicit release gates required |
