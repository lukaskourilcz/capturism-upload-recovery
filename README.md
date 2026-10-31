# Capturism upload twin

A local diagnostic replica of the studio's **photo → upload → confirmation → QR → download** path. It is an upload lab, not a complete Windows kiosk or an exact reproduction of the October incident.

## Run

Requires Node 22+ and npm. Verified here with Node 26.8.2 and Chrome.

```sh
cd /Users/lukasbarsinbars/Documents/ChatGPT/capturism/digital-twin
npm ci --ignore-scripts
npm run dev
```

Open **http://127.0.0.1:4317**. The server binds only to the local computer. The QR encodes a local URL; use **Open local download page** on this computer. Scanning it on a phone will not reach the lab.

Stop with Ctrl+C. `npm test` runs the isolated integration tests and the upstream queue's five regression checks. `npm run build` rebuilds the browser bundle after code changes; reload Chrome afterwards. No cloud credentials or environment files are needed.

## What is real, and what is modeled

| Part | Fidelity |
| --- | --- |
| Photo compression, signing requests, PUT requests, confirmation, retry/backoff, late-token guard | Original `relayUpload.ts`, unchanged |
| Video enqueue, disk queue, retry timing, 50 KiB/s throttle, size/age limits, raw-video dropping | Original `video-queue.js`, unchanged, in a separate local Node process |
| Session identity | Minimal epoch adapter matching the uploader's reset contract; not the full Zustand store |
| Kiosk screen | Diagnostic UI; shows QR only after the original uploader returns |
| Camera/photo rendering | Generated test card or locally selected JPEG/PNG; original JPEG compression; synthetic image optionally padded to a chosen size |
| Video composition | Two short synthetic WebM fixtures; optional preparation delay, not the real compositor |
| Local bridge | Upload-only proxy/enqueue boundary; no printer, payment or camera drivers |
| Render relay | Local sign/download API model using the production QR metadata writer; actual server handlers are tested separately, not full production startup |
| Cloudflare R2 | Local disk object store; QR/original pool URLs are modeled, candidate pool and QR metadata conditional writes use local ETags. No real S3 signing, Cloudflare CORS, provider IAM or physical recovery verification |
| Download page | Local simplified preview with polling; not the deployed Cloudflare build |
| Network | Shared PUT throughput and configurable latency, congestion, outage and cold-start models; not OS-level packet shaping |

Upstream snapshot: [`capturismstudio/capturism`](https://github.com/capturismstudio/capturism), commit `1f2df6401997455b456eab9b32d258b997dc4b9d`, retrieved October 30, 2026. `vendor/provenance.json` records SHA-256 hashes. Tests verify that the original files remain unchanged. Build aliases replace only `sendBoothError` and `getSessionEpoch`; they cannot open production WebSockets.

This is the **post-fix** queue version. The congestion preset approximates bandwidth consumed by competing traffic; it does not run the historical pre-fix raw-video retry loop.

## Useful experiments

1. **Healthy connection:** keep defaults and start. Follow sign → PUT → confirmation → QR; open the download preview and wait for both videos.
2. **Slow connection:** choose the studio preset and a 2–8 MiB test photo. The 125 KiB/s preset approximates 1 Mbps; it is not a measured studio speed.
3. **Congestion:** the preset reserves 90 of 125 KiB/s for other traffic. Compare QR timing with the slow preset.
4. **Confirmation failure:** five confirmation requests return 503 after the photo is stored. Observe the real uploader's retries and its outer photo retry with the same token.
5. **Late completion:** choose the slow preset, a 2 MiB photo and reset after 2 seconds. The server may finish storing the photo, but the original uploader must reject its token after the epoch changes. No late QR should appear.
6. **Bridge restart:** while clips are queued, press Restart bridge. The process restarts and reopens the same queue directory. Starting an entirely new test uses a fresh directory and discards the previous run from the active dashboard.
7. **Idle/cold-start approximation:** choose the 55-second wake-up preset. This injects a delay at upload signing; it does not reproduce Render's complete idle lifecycle or the kiosk's keep-warm pings.
8. **Outage:** the first 20 seconds return 503 from modeled cloud operations; the uploader's own retry timings remain unchanged.

Save the timeline, config, queue and session metadata with **Save test report** before starting another test. Files remain under `.runtime/<run-id>/` and are excluded from Git. The current session map and event history live in memory; restarting the whole server does not restore past download links. Bridge restart within a run preserves the real disk queue. Old run data is not automatically removed; it contains synthetic fixtures by default or whichever local test image you explicitly chose.

## Isolation

- Loopback-only listener; fixed local worker destination; no production keys or `.env` loading.
- Browser CSP and fetch guard block external service calls; cross-origin control requests are rejected.
- Independent local Git repository with no remote. Nothing is pushed or deployed.
- No printer, payment terminal, camera, customer messaging, or live bucket access.

## Calibration still needed

To call this an exact studio twin, obtain the kiosk's current Git SHA, bridge process version/restart time, Windows/Chrome/Node versions, photo/video sizes, queue metadata and browser/bridge error logs. Measure uplink speed/latency during a failure. Match those values and reproduce the recorded failing session before deciding on a production change. Source and cloud access alone cannot establish those local facts.

## Verification

The lab now has an **Upload version** selector: original studio code or the local fix candidate. Candidate details, reproduction results and patch instructions are in [candidate/RESULTS.md](candidate/RESULTS.md). The original vendor files remain unchanged.

It also runs the original pool-upload client in parallel with the QR photo. Three **After idle** presets inject first-use failures at signing, direct storage PUT, or pool confirmation. See [persistent diagnostics and idle tests](candidate/DIAGNOSTICS.md) for the modeled behavior, kiosk logging candidate and limitations. The candidate records safe diagnostics locally under `.runtime/diagnostic-logs/`; an eventual kiosk installation would use `diagnostic-logs/` beside its bridge.

The **Local fix candidate** includes [durable pool retries](candidate/DURABLE-POOL.md) and [publication protocol 2](candidate/PUBLICATION-FENCING.md). Two additional presets cover lost responses and failed record persistence. All five idle presets recover with the candidate; the original selector retains its one-attempt behavior for comparison. The preset names retain their historical sign/PUT/join labels; candidate faults are injected at reservation/body/publication boundaries. [Direct-browser retries](candidate/POOL-RETRIES.md) are a historical fixture. The candidate requires its matching relay and is not a client-only production patch.

Pool delivery is now [durable on the bridge](candidate/DURABLE-POOL.md): browser acceptance means the portrait was written locally, and the bridge resumes delivery from disk after browser reloads or process restarts. The twin reports **saved locally** separately from **delivered**. Use Restart bridge within the current experiment to test recovery; starting a fresh experiment intentionally uses a different queue folder.

The candidate relay no longer issues pool PUT URLs. It binds delivery to the portrait digest, writes published bytes only once, and retains a minimal durable withdrawal fence. Tests cover deletion during upload, competing relays, stale queue/remote backups and restart recovery. Old pool sign/join clients receive 426. Retiring old write capabilities and preserving v2 fences on rollback are mandatory future cutover steps; see the [updated audit](candidate/AUDIT.md) and [rollout/rollback plan](candidate/ROLLOUT-ROLLBACK.md). All 126 twin tests, 27 targeted kiosk tests and 7 phone tests pass; nothing is deployed. The [final review](candidate/FINAL-REVIEW.md) closes R3/R4/R5 locally: QR success requires durable metadata; immutable original-expiry proof prevents renewal after cleanup; temporary cold reads return 503 and the phone page offers same-token retry. Actual provider/kiosk/phone-hosting, dependency and cutover gates keep release on hold. The patch now includes the download page; preserve expiry proof and pool fences on compatible rollback.

Automated coverage: original-source integrity; upstream queue guards; shared bandwidth and cancellation; real uploader to local storage/download; recovery after five failed confirmations; late-token rejection after reset; outage recovery; durable video queue delivery after process restart; local request-boundary checks.

Browser verification on October 30: generated JPEG renders, QR appears after confirmation, both real synthetic WebM files reach the local viewer. The first healthy browser run showed QR at 2.8 seconds. This is a local test measurement, not a studio benchmark. The 55-second cold-start preset and physical hardware are not covered by the automated checks.

The QR candidate now uses [one absolute upload deadline](candidate/QR-DEADLINE.md) for signing, photo PUT, confirmation bodies and every retry wait. Timeout shows **Retry download** rather than spinning indefinitely. Recovery reuses the same prepared photo/token and completed upload; it does not print or charge again. Reset clears recovery for the next customer. To try it quickly, select the candidate, choose an after-idle or slow preset, disable optional videos/pool, and set **QR upload deadline** to 2 seconds. After timeout, Retry download opens a new normal bounded window. Three QR-specific presets also cover failed confirmation, failed record save and a lost successful response. The production background ceiling remains ten minutes; the short value is a local experiment setting.

[Durable QR confirmation](candidate/QR-METADATA.md) now returns a retryable failure if metadata cannot be saved. It preserves committed videos and expiry on replay, and success is verified after a relay process kill/restart with original photo-byte retrieval. The QR save-after-idle preset now fails the production metadata writer itself. These are local provider replacements; live R2/hosting validation remains required.
