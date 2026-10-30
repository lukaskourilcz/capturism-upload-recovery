# Safe pool upload retries — local candidate

**Updated:** browser-owned delivery has now been replaced by the [durable bridge queue](DURABLE-POOL.md). The direct-browser algorithm and its limits below describe the earlier candidate, retained as a regression fixture. Stable relay identity and durable, idempotent confirmation remain in use.

Based on Capturism `1f2df64`. These are local review files and a combined patch, not installed production changes.

## Behavior

- JPEG conversion runs once. Signing, PUT and confirmation each have at most five attempts with 1, 2, 4 and 8 second pauses. Network failures, timeouts, HTTP 408/429 and 5xx are retried. Ordinary validation/auth/conflict failures stop immediately. The overall request budget is ten minutes; individual signing/join calls have up to 20 seconds and PUTs up to 120 seconds, capped by remaining budget.
- Signing carries protocol version 1, session id and redeemed quiz code through the existing authenticated bridge. The relay derives the same entry id from booth + session + code every time. Re-signing after a lost response or expired URL therefore keeps the same object key.
- Once PUT succeeds, only confirmation retries. Lost PUT acknowledgements can resend the identical JPEG to the same key; they cannot mint another portrait or pool entry.
- Concurrent browser calls share one in-flight promise for that session/code. A bounded cache remembers 100 successful deliveries for the current page. Reloading loses that cache, but the relay's stable identity and persisted entry still prevent a duplicate.
- The relay serializes simultaneous joins for the same booth/session and persists before adding to its visible pool. Replaying the same committed entry returns success without overwriting consent, created time, distributions or retired status. Conflicting identities or portrait keys return 409, never assumed success.
- Failed storage writes return 503. A relay restart waits for pool hydration before accepting protocol-v1 writes. Failed hydration returns 503 and can recover on a later request; it does not silently recreate existing entries from an empty cache.

The same redeemed-quiz lookup remains authoritative for identity and consent. New requests also check the redeeming booth where recorded. Existing request formats retain their legacy route support; the new retry client requires the explicit v1 acknowledgement and fails safely if connected to an old relay.

## Local results

All five modeled after-idle scenarios recover in the candidate:

| Scenario | Recovery | Duplicate protection checked |
| --- | --- | --- |
| First signing request returns 503 | Signing retries | One stable key and entry |
| First portrait PUT returns 503 | PUT retries | One durable entry |
| First pool join returns 503 | Join retries | No extra portrait PUT |
| Entry saved but response lost | Same join repeated | One durable save, one entry |
| First record persistence fails | Join retries after 503 | No false success; one eventual save |

Additional tests drop signing and PUT responses after success, renew an expired presign, call the client and relay concurrently, repeat after success and after relay restart, check permanent HTTP 400 and retry exhaustion, reject incompatible old-relay responses, and simulate unavailable storage during startup. Actual candidate relay handlers are loaded with local mocked S3/quiz dependencies; this exercises the production candidate code as well as the twin endpoints.

Chrome test with real canvas conversion: pool portrait saved despite the simulated lost confirmation response; the QR appeared around 9.9 seconds and both videos subsequently delivered. The timeline showed one pool record persistence event with two confirmation requests. The first one-attempt client is kept under **Original studio code** for comparison.

## Review and compatibility

`local-fix.patch` now includes the kiosk client, relay `pool.js`, its `pool-retry.cjs` helper, earlier QR reliability work and persistent diagnostics. The new client and relay protocol must be reviewed together. Any eventual authorized rollout must establish relay protocol support before enabling this client; otherwise pool delivery deliberately returns failure rather than attempting unsafe retries. No live rollout has been performed.

The source snapshot and original vendor files remain unchanged. No keys or `.env` files are part of the candidate. Local diagnostics continue excluding quiz codes, session identifiers, payloads and signed URLs.

Retries are bounded and currently browser-owned: prolonged outages, an exhausted budget or closing the page/PC before the bytes are delivered can still lose the pending in-memory portrait. This change does not introduce a durable portrait queue. It also does not establish the cause of the real studio's idle failure. Real Cloudflare semantics and Windows/Chrome idle behavior still require kiosk evidence. In-process serialization matches the current single-relay model; it is not a distributed transaction implementation for multiple writers.
