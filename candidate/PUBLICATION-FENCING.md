# Pool publication protocol 2 — local candidate

This closes the local R1 deletion-replay and R2 portrait-overwrite reproductions. It changes both the relay and bridge worker; it is not a client-only fix. Nothing has been deployed or pushed. Baseline: Capturism `1f2df6401997455b456eab9b32d258b997dc4b9d`.

## Identity and immutable publication

The bridge POSTs the retained JPEG to authenticated `/api/booth/pool/upload`. `X-Pool-Upload` carries base64 JSON containing `retryVersion: 2`, session, redeemed code, seed and SHA-256 photo digest. Booth credentials remain in Node. Metadata is bounded to 2 KiB, the body to 20 MiB, and admission to two concurrent bodies per relay. The worker still sends one portrait at a time at 25 KiB/s; its request budget is twenty minutes. The relay bounds body collection to twenty minutes and uses a twenty-one-minute Node request timeout; other request bodies receive a one-minute deadline. Hosting/proxy limits still require staging validation.

The stable entry id remains the first sixteen hex characters of SHA-256 over JSON `[boothId, sessionId, String(code)]`. The canonical `pool/<id>.json` slot transitions:

```
absent -> pending -> active -> retired
                 \             \
                  +-----------> withdrawn (terminal)
```

Withdrawal can also occupy an absent slot. A pending reservation is invisible to matching/admin lists. Consent is validated server-side against the redeemed quiz record before reservation and publication. The digest and immutable identity are fixed by the reservation. Different bytes or seed on a replay return 409; a new body whose digest does not match its declaration returns 422 before any portrait write.

`pool-publication.cjs` writes a reservation with `If-None-Match: *`, writes final `pool-portraits/<id>.jpg` with the same create-only condition, and publishes metadata with `If-Match` against the reservation's ETag. An existing image is read and hash-verified, never overwritten. A committed replay verifies identity/digest and returns success without replacing pixels, consent, creation time, distributions or retired state. A legacy committed record lacking a digest is compared against its stored photo and acknowledged without rewriting metadata.

Cloudflare documents that conditional PutObject checks happen atomically at commit time, including competing writers: [R2 S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/). A delete or a 404 alone cannot prevent an earlier in-flight write from completing later: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/). Tests model these conditions; no live R2 calls were made.

## Withdrawal and stale writers

Withdrawal conditionally replaces the same canonical slot with only `{id, status: 'withdrawn', deletedAt, portraitExtension}`. No name, handle, quiz answers, session or portrait content remains in that object. It then persists `pool-deletions/<id>.json`, removes the portrait, and only then acknowledges deletion. Partial cleanup returns 503, keeps the terminal fence if committed, and can be finished by retry/startup. A failed initial fence write is never acknowledged as deletion. Preserve both prefixes permanently; neither belongs under the sessions lifecycle rule.

Upload reservation/publication, startup hydration, metadata/distribution writes, admin lists and portrait reads consult durable state. Per-id locking coordinates operations inside a relay. Conditional canonical writes prevent stale writers in a different relay from replacing a tombstone. Existing legacy deletion markers are also enforced; hydration scrubs a stale active record restored beside such a marker. Metadata updates preserve immutable identity and history and cannot resurrect a deleted slot. Portrait reads now use `private, no-store`; copies already downloaded or streaming before withdrawal cannot be recalled.

Image and metadata operations are not one multi-object transaction. A process dying immediately after a late image write can leave a private orphan beside a tombstone. That orphan cannot be published, matched or served by this protocol; startup/withdrawal retry removes it. Successful withdrawal is not a claim that an in-flight cross-process write can never leave an orphan until reconciliation. A recovery test explicitly constructs this crash boundary.

## Durable queue and compatibility

Old pending/uploaded checkpoints still contain their original JPEG. The new worker delivers those bytes under protocol 2 with the same identity; it ignores old write URLs/checkpoints as publication authority. On success it writes a small done receipt. A confirmed 410 with matching entry id, `withdrawn: true` and `publicationVersion: 2` writes a withdrawn receipt and removes local portrait/code/session data. A generic/malformed 410 blocks delivery and retains the portrait for review. Disk-write failure leaves the earlier acknowledged job recoverable.

`/pool/sign-upload` and `/pool/join` now return 426 for all legacy/v1 requests. There is no fallback that issues a mutable published-key PUT URL. The old direct browser client deliberately cannot continue collection against the new relay. The new queue against the old relay blocks and retains its bytes.

**Cutover requirement:** close collection, stop all legacy writers, settle in-flight requests, and retire outstanding old R2 write capabilities before enabling protocol 2. This patch cannot revoke an old presigned URL. Provider credential/key rotation and its effect on QR/video/other bucket users require an authorized, separately verified maintenance procedure. Never restore the old writable relay once new tombstones exist. See [rollout/rollback](ROLLOUT-ROLLBACK.md).

## Local evidence

- Actual candidate handlers: repeated/concurrent delivery, competing relays with different pixels, metadata-save failure and ambiguous acknowledgement preserve one entry and original bytes.
- Withdrawal: before body completion, during publication, across relays before metadata commit and before a delayed image commit; retries and relay restarts return 410 and preserve the canonical fence.
- Failure recovery: marker-write and image-delete failures, initial tombstone failure, deletion-lookup outage, stale backup restoration, orphan cleanup, stale match persistence and distribution-save failure.
- Real disk/HTTP/process queue tests: five first-use idle faults, old uploaded checkpoint migration, lost local/remote acknowledgements, bridge SIGKILL/restart, stale pending backup after withdrawal, generic 410 retention and conflicting enqueue rejection.
- Chrome prototype: browser handoff completed, protected publication ran once, dashboard showed delivered, and a manual bridge restart preserved the same done receipt and single pool entry. Saved screenshot and state are under `test-results/` (local ignored evidence).

Deterministic backoff tests advance an injected clock; process tests use actual child-process death and local HTTP. This does not verify physical Windows power-loss behavior, real provider IAM/lifecycle settings or the studio's exact idle root cause. [Audit](AUDIT.md) records the remaining gates.
