# 10 — Protected Staff Release Workflow

## Protected production baseline

The currently working staff/POS release is Firebase Hosting version
`b6dd6eb6c731ec98` on site `coffee-bond-pos`.

- Exact deployed source commit: `0b7f97e712c8238886c38b6534d8f1620a75782d`
- Exact-source tag: `production-staff-hosting-b6dd6eb6c731ec98`
- Protected release-baseline tag: `production-staff-release-baseline-b6dd6eb6c731ec98`
- Protected branch: `codex/production-staff-baseline-b6dd6eb6c731ec98`
- Protected worktree:
  `/Users/narendrashukla/Developer/COFFEEBOND-POS-production-staff-baseline-b6dd6eb6c731ec98`

The source commit is the exact clean release source used to build the verified Global
Items staff release. A fresh production build was compared with active Hosting: all 114
user-file paths and Firebase gzip/SHA-256 hashes matched. The Hosting API reports 116
files in total because it also includes 2 Firebase-reserved `/__/firebase/` files.

The protected branch and worktree are release inputs, not development space. Never
develop on them and never deploy a long-running feature branch directly to production.

## Required release flow

```text
FEATURE DEVELOPMENT
  -> separate feature branch and separate worktree

APPROVED RELEASE
  -> create a new clean release worktree from the protected baseline
  -> apply only the approved feature commit or patch
  -> review the exact changed-file list
  -> run the full Coffee Bond POS release QA
  -> run the mandatory staff preflight gate
  -> capture the currently active staff Hosting version as the rollback point
  -> deploy only the affected approved surface
  -> run the production POS smoke test immediately
  -> roll back staff Hosting immediately if any critical smoke check fails
```

Each release must use a short-lived release branch/worktree. The protected baseline is
advanced only after the new staff release passes every smoke check and its exact deployed
source and Hosting bundle are committed, tagged, and hash-verified.

## Mandatory pre-deploy gate

All checks must pass in the clean release worktree:

- production Firebase `.env` is present and complete
- `VITE_FIREBASE_PROJECT_ID` equals exactly `coffee-bond-pos`
- the preview token `coffee-bond-pos-preview` is absent from `.env` and `dist/`
- the `staff` Hosting target resolves exactly to site `coffee-bond-pos`
- Git status is clean
- the release diff contains exactly the approved files and no others
- TypeScript passes
- the staff production build passes
- Node 20 is used

Run the non-deploying gate with one `--approved-file` per approved path, or a newline
delimited manifest:

```bash
node scripts/staff-release-preflight.mjs \
  --project=coffee-bond-pos \
  --baseline=production-staff-release-baseline-b6dd6eb6c731ec98 \
  --approved-file=frontend/example.tsx
```

The gate builds but cannot deploy. A `PASS` result is required release evidence; it is
not authorization to deploy.

## Full Coffee Bond POS release QA

Select and record every relevant repository test for the approved change. At minimum,
cover all affected behavior and the existing critical POS paths: staff authentication and
permissions, store resolution, POS menu and taxonomy, product search, add-to-sale, tenders,
discounts, hold/recall and Running Orders, KOT, Online acceptance/rejection, stock and void
handling, Reports/GST/payment summaries, Razorpay retries/idempotency when applicable, and
hosting headers/PWA behavior when applicable. Shared frontend code requires both staff and
customer builds and tests even when only one Hosting target will be deployed.

Do not waive a failing check. Fix the release in its feature branch, then create a new clean
release worktree from the protected baseline and reapply only the approved patch.

## Mandatory production staff smoke test

Immediately after a staff Hosting release, verify all of the following on production:

- Golden I POS menu is non-zero (known baseline: 125 items)
- Noida 29 POS menu is non-zero (known baseline: 128 items)
- Noida 51 POS menu is non-zero (known baseline: 128 items)
- product search works
- adding an item to the current sale works
- Running Orders works
- Online works
- Reports works

If any one of these checks fails, roll back staff Hosting immediately to the captured
pre-deploy version. Do not touch Firestore or catalogue data to repair a frontend release
failure. After rollback, repeat the complete production smoke test and preserve the failed
release evidence for diagnosis.
