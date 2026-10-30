# Durable QR confirmation — local candidate

Implementation `1d7ebac`, based on Capturism `1f2df64`. No deployment, push, credentials change, device operation or client message. This closes the local R3 reproduction; actual provider/kiosk checks remain in the [rollout plan](ROLLOUT-ROLLBACK.md).

## Success boundary

`session-metadata.cjs` owns all relay writes to `sessions/<token>/meta.json`: HTTP confirmation, WebSocket photos-ready, dev seed and discovered-video patches. The session JSON format and object path stay compatible with existing records.

For each confirmation, the writer takes a per-token lock and reads durable metadata. It creates a new object with `If-None-Match: *`, or updates existing metadata with `If-Match` against its ETag. Bounded conflict retries reread and merge. The cache is promoted only after a successful storage response, or after a fresh durable read proves the identical operation already committed. A warm cache alone never proves a confirmation was saved.

| Outcome | Response / recovery |
| --- | --- |
| Metadata cannot be saved/read or storage is unconfigured | HTTP 503; no success notification or new in-memory-only session |
| Storage committed but its response was lost | 503 for the unknown outcome; retry reads the existing commit and can acknowledge it without another PUT |
| Identical confirmation repeated | 200 from confirmed durable state; same photo/token, original clocks and existing media |
| Two relays add different video fields | Conditional updates merge without replacing one another's completed fields |
| Photo/booth/completed-video identity conflicts | 409; committed data remains intact |
| Stored metadata is expired, or expires during save | 410; no renewed retention clock or success notification |
| Stored metadata is corrupt | Retryable failure; no replacement with a new session |
| Video-discovery save fails | Previous committed metadata/cache remains unchanged; no cache-only discovery promotion |

HTTP notification/200, WebSocket notification and dev-seed success all follow the durable boundary. A replay can still produce another admin notification after confirmed success; this is not an exactly-once notification delivery system. No test used a real notification recipient.

## Replay and compatibility

Replays retain `createdAt`, `expiresAt`, photo key, booth identity and saved video keys. Omitted optional fields cannot erase completed videos. Unknown historical metadata fields are retained. A pending-video flag does not renew the original video wait or session retention clocks. Expired stored sessions cannot be revived, and the client treats 410 as permanent instead of entering another automatic retry loop.

The existing client keeps its completed photo PUT checkpoint when confirmation gets 503 or times out. Automatic retry/manual recovery therefore retries confirmation with the same token and bytes, without another sign/PUT when already complete. It does not repeat printing or payment. QR recovery remains limited to the current browser page/session; it is not a new durable local QR queue. The independent pool queue is unchanged.

There is no multi-object transaction between photo PUT and metadata. A photo may exist while metadata persistence is failing; that is deliberately not reported as a ready QR. Provider work may also complete after a client timeout. Durable reads and conditional writes reconcile ambiguous outcomes; actual provider consistency/permissions still need staging validation. The established R2 conditional-write reference is linked in [pool publication](PUBLICATION-FENCING.md).

## Evidence

- **112 twin tests and 27 targeted kiosk tests pass**; TypeScript, full lint, kiosk/twin production builds and JavaScript syntax checks pass. Existing build warnings remain. The regenerated patch applies exactly to the captured baseline and matches all 22 candidate files.
- Twelve actual-relay-handler/service tests cover failed save, ambiguous provider response, replay after video delivery, concurrent relay updates, failed discovery writes, retention expiry including during save, identity conflict, missing/read-failing/corrupt storage, malformed requests, dev seed and WebSocket failure/success.
- A real client over local HTTP gets 503 then 200 with one sign and one photo PUT. Tests include save failure, lost provider acknowledgement and deadline-then-explicit-recovery. Its QR checkpoint stays available until confirmation succeeds.
- A real relay-handler child process acknowledges a successful save, is killed with SIGKILL, and a new process reloads an isolated disk-backed provider replacement. The recovered download returns 200 and serves the original photo bytes. This is process-restart evidence on this Mac, not physical Windows power-loss or live R2 proof.
- The twin now uses the production metadata writer. The after-idle save preset fails the metadata write itself; local QR cache restart preserves external provider state. All five QR idle-failure cases also verify download metadata after a cache restart.

`node audit/reproduce-qr-persistence.mjs` now compares the unsafe baseline with the fixed candidate. Baseline returns 200 on the injected save failure and loses the download after restart. Candidate returns 503 with zero new success-cache entries/notifications; retry saves, returns 200 and resolves after restart. Historical failing-review evidence is retained separately.

Current local evidence: `test-results/qr-metadata-before-after.json`, `qr-metadata-focused.txt`, `qr-metadata-relay-checks.txt`, `qr-durability-full-tests.txt`, `qr-durability-kiosk-tests.txt`, `qr-durability-artifact.json`. The [audit](AUDIT.md) records remaining environment, dependency and cutover gates. Nothing is deployed.
