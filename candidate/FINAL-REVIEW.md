# Final combined patch review — local blockers resolved; rollout gated

Current implementation `1d7ebac0ea112b473e97f5cf7b91e599e32f6593`, against Capturism baseline `1f2df6401997455b456eab9b32d258b997dc4b9d`. Combined patch SHA-256: `dccf9d1f5bffd5e76ad499c7534bafabc81da70d17929ccf311d374d4e667f51`.

**The demonstrated pool, client-deadline and QR metadata findings are fixed locally. Production release remains gated.** No deployment, push, provider/device action or client message was performed.

## R3 resolution after the prior review

Review `190e32e` found that the baseline relay returned 200/ok after a failed metadata save, leaving a QR that returned 404 after restart. The new shared metadata writer acknowledges only a successful conditional write or a fresh durable read proving an identical prior commit. Save/read errors return 503 instead of publishing an in-memory-only session. HTTP/WebSocket notifications and dev-seed success follow the same boundary. Video discovery also persists before updating the cache.

Replay preserves photo/booth identity, existing video fields, historical fields and original timestamps/expiry. Conditional updates prevent competing relays from dropping separate video updates. Stored expired sessions return 410 and cannot renew their clocks; the client stops automatic retries for that response. Recovery retains the same prepared photo/token and skips an already-completed PUT.

The before/after regression uses actual relay handler/storage/load/download source with local provider replacements:

| Injected metadata save failure | Initial response | New success cache / notice | Restart before recovery | After saved retry and restart |
| --- | --- | --- | --- | --- |
| Baseline | 200/ok | Present despite failed save | Download 404 despite prior success | Download 200 |
| Candidate | 503 | Absent | Download unavailable; no prior success was claimed | Download 200 |

Evidence: `test-results/qr-metadata-before-after.json`; contract: [QR metadata](QR-METADATA.md). The regression script now asserts safe candidate behavior instead of expecting both versions to fail the invariant.

## Final verification

- **112 twin tests pass**, zero failures/skips, about 35.7 seconds; **27 targeted kiosk tests pass** across five uploader/probe/privacy/video/UI files. All prior pool withdrawal, immutable bytes, queue persistence, deadline, local ingress and rollback checks remain green.
- Actual handler tests cover failed/ambiguous save, replay/history/retention, conflicting identity, concurrent media updates, failed discovery patch, corrupt/missing/unavailable storage, malformed input and HTTP/WS/dev-seed boundaries.
- A real client over local HTTP sees 503 then 200 and sends one photo PUT, including deadline-then-manual recovery. A real handler child process is killed after acknowledgement; a new process reloads disk-backed provider fixtures and serves the original photo via the recovered download. Actual R2/Windows behavior remains unverified.
- Kiosk TypeScript, full lint with zero warnings, production and twin builds, and candidate JavaScript syntax pass. Existing large-chunk/mixed-import and Node deprecation warnings remain. Node 26 kiosk tests use `NODE_OPTIONS=--no-experimental-webstorage` for jsdom-owned localStorage.
- The exact patch applies to a fresh copy of baseline files and reproduces all **22 changed files byte-for-byte**. No production dependencies or lockfiles changed.

Current evidence: `test-results/qr-durability-full-tests.txt`, `qr-durability-kiosk-tests.txt`, `qr-durability-typecheck.txt`, `qr-durability-lint.txt`, `qr-durability-build.txt`, `qr-durability-artifact.json`. Previous Chrome evidence remains historical. Full production relay startup/integrations and physical devices were not executed.

## Remaining release boundary

The [rollout/rollback plan](ROLLOUT-ROLLBACK.md) retains explicit code/staging, kiosk and cloud gates. Verify the real SDK/conditional writes, permissions, hosting timeouts, QR save/restart recovery, private backups and legacy capability retirement in isolation before release. Include `session-metadata.cjs` with the relay artifact and preserve it in any compatible rollback.

Kiosk startup/updater scripts can switch a detached checkout back to `main` and pull. Freeze automatic source mutation and prove the actual running SHA after launch/restart. Preserve current distributions, withdrawal fences, queue bytes and done/withdrawn receipts. A legacy writable relay remains an unsafe downgrade after v2 state.

Actual Windows/Chrome/filesystem/ACLs, device and real idle behavior, tunnel headers, provider revocation/lifecycle/IAM, Render topology/limits and baseline dependency advisory disposition remain unverified. Production checks must use verified read-only health/config/log signals; GET download/admin-pool paths can have persistence effects. No current local result authorizes a deployment or client message.
