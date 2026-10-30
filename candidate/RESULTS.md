# Missing QR: local reproduction and fix candidate

Baseline: Capturism commit `1f2df6401997455b456eab9b32d258b997dc4b9d`. No production changes, remote pushes or client messages.

## Reproduction

Identical 1 MiB photo, shared uplink capped at 125 KiB/s, 150 ms modeled cloud latency. Real uploader and real HTTP bytes; no fake retry timers. The thank-you page inactivity deadline was shortened from five minutes to four seconds to exercise the race quickly. This is an accelerated reproduction of a failure mechanism, not proof of the exact historical studio incident.

| Version | Photo confirmed | QR returned | Outcome |
| --- | --- | --- | --- |
| Baseline | 8.776 s | No | Reset at 4 s; original privacy guard rejected the late token |
| Candidate | 8.831 s | Yes | Pending window remained open; token returned; fresh scanning window began |

Detailed traces: `test-results/slow-upload-comparison.json` (local ignored artifact). Browser repeated the same comparison: original produced no QR; candidate logged QR shown around 8.9 s, then reset four seconds later as intended. The final demo uses the production five-minute scan window.

## Candidate changes

1. `ByePage.tsx` uses ten minutes of inactivity while a requested QR has no token, matching the upload patience. Token arrival re-arms a fresh five-minute scan window. Sessions that do not request a QR retain the normal five-minute window. Explicit restart remains immediate. After the bounded wait the kiosk can still return home; a persistent outage is not solved by this change.
2. `relayUpload.ts` remembers a successful photo PUT. If confirmation exhausts its inner retries, the outer retry registers the same photo again instead of signing and uploading all bytes again. PUT failures still use the existing retry/re-sign path. The epoch guard continues rejecting tokens from ended sessions.
3. `qrWaitPolicy.ts` is shared between the candidate kiosk screen and the twin, avoiding a different deadline rule in the demo.

Original `vendor/` files are unchanged and checked by SHA-256. Candidate files are complete replacements under the same monorepo-relative paths. `local-fix.patch` contains only the proposed production diff; twin UI and test changes are separate.

## Validation

- `npm test`: 16 tests passed, including baseline reproduction, fixed slow upload, five failed confirmations with **one** successful photo PUT, explicit-reset privacy guard and production 5/10-minute timer values. Includes the earlier integration coverage and invokes all five upstream queue regressions.
- Candidate overlaid onto a disposable full kiosk source copy: TypeScript check passed (`tsc --noEmit -p tsconfig.app.json`). ESLint on all three changed files passed with zero warnings.
- Chrome: baseline missing QR reproduced; candidate QR-return event observed after the same upload; scan window reset verified. Generated photo and both synthetic video downloads were already verified in the original twin; candidate does not change media bytes or video queue delivery.

The full five/ten-minute wall-clock wait was not run; constants and actual timer selection are checked separately. The twin substitutes the relay, R2 and kiosk state. Hardware, real Cloudflare behavior, browser rendering/video composition stalls and the kiosk's running version remain unverified. A network outage exceeding the pending window can still end without a QR.

## Local review

Run `npm run dev`, open http://127.0.0.1:4317 and compare both Upload version settings with Slow studio connection, 1 MiB, no synthetic videos, reset after 4 seconds. The local candidate stays available for review. Choose reset after 300 seconds for the normal scanning window.

Before applying this patch elsewhere, check the kiosk's actual revision and compare against that revision. It has only been prepared for the downloaded baseline. No deployment is part of this work.
