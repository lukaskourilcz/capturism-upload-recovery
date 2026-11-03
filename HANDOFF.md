# Private implementation and review handoff

Repository: `lukaskourilcz/capturism-upload-recovery`. This preserves the local development history of the upload twin and candidate fixes. It is not Claire's full application repository and is not connected here to a deployment. No collaborator has been added or client message sent.

## Start here

1. Read [the latest follow-up](candidate/FOLLOWUP-2026-11-03.md): R12 postcard upload is still open; optional-video preparation is a separate delay risk. Do not interpret an older closed review as approval of the complete product flow.
2. Read [AUDIT.md](candidate/AUDIT.md), [coverage](candidate/AUDIT-COVERAGE.md) and [rollout/rollback](candidate/ROLLOUT-ROLLBACK.md). R1–R11 and upload deadlines have local evidence; real kiosk/cloud and legacy-data decisions remain unverified.
3. Compare [candidate/local-fix.patch](candidate/local-fix.patch) with the actual application checkout and running versions. The patch targets upstream `capturismstudio/capturism` at `1f2df6401997455b456eab9b32d258b997dc4b9d`. The local twin implementation SHA `8d0f265` is not a commit to fetch/reset to in that upstream repository.

## What is included

- Original commits, preserved without squash, rebasing or altered timestamps/authors.
- Local synthetic upload simulator, pinned uploader/video queue excerpts and provenance.
- Candidate source files and the combined 26-file production patch.
- Failure/replay/restart/authorization tests, audit tools and historical/current review reports.
- New product upload inventory and sanitized media timing measurements.

Customer photos/videos, WhatsApp exports, real session references, credentials, private approvals, runtime queues/logs, dependency caches, ignored builds and the full captured upstream checkout are excluded. Historical source and test outputs contain synthetic scenarios, not evidence that every incident happened in production. Pattern scanning of all 47 original commits found no credential-shaped values beyond deliberately invalid test storage paths; this is a limited pre-upload check, not a guarantee about all possible secret formats.

## Reproduce locally

Use Node 22+ and the locked dependencies. The synthetic lab has no production credentials; see the [README](README.md) for startup. Never add booth/cloud environment files to make a test pass.

Some historical verification tools also require the separately captured upstream source or ignored `.runtime` kiosk/phone overlays. Inspect their prerequisites and paths before running them in a fresh clone; those private work directories are not restored by this repository. Do not run Windows launchers, full production services or customer workflows as a shortcut. Preserve original vendor files.

Read-only new checks:

```sh
node audit/review-product-upload.mjs
# Expected on the current candidate: JSON evidence and exit 2, R12 remains open.

node audit/review-product-upload.mjs <path-to-upstream-Printing.tsx>
# Source inventory only; also inspect shared hooks and all token writers.

node audit/analyze-media-timing.mjs <local-main-video> <local-story-video>
# Requires an existing ffprobe; prints numeric/codec information, no images/paths.
```

The historical final implementation checks passed 242 twin, 27 targeted kiosk and 16 phone tests. Those counts predate R12 and do not cover a working postcard delivery route. No production code changed in this follow-up; do not claim a freshly tested product fix from documentation/tool changes. After implementation, rerun the appropriate complete tests/builds, regenerate the patch, verify its exact bytes and update the current audit.

## Next implementation boundary

Add postcard digital delivery with product-route regression coverage; separate photo/QR readiness from optional video composition; bound preparation events and preserve original session ownership, clocks and retry identity. Keep print/payment effects out of QR recovery. Validate original media and the actual Windows build privately. Complete the existing environment, storage-authority, backup and cutover checks before any separately authorized release.

This private backup authorizes neither deployment nor messaging Claire. The current GitHub account cannot read the original private upstream repository; obtain the current source/version through an authorized connection before adapting the patch.
