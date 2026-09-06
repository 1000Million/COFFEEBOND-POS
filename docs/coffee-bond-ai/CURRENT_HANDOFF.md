# Current Handoff

_Last updated: 2026-09-06._

## Protected staff production baseline

The Global Items staff/POS release is verified healthy in production.

```text
HOSTING_VERSION=b6dd6eb6c731ec98
EXACT_SOURCE_COMMIT=0b7f97e712c8238886c38b6534d8f1620a75782d
EXACT_SOURCE_TAG=production-staff-hosting-b6dd6eb6c731ec98
PROTECTED_BASELINE_TAG=production-staff-release-baseline-b6dd6eb6c731ec98
PROTECTED_BRANCH=codex/production-staff-baseline-b6dd6eb6c731ec98
PROTECTED_WORKTREE=/Users/narendrashukla/Developer/COFFEEBOND-POS-production-staff-baseline-b6dd6eb6c731ec98
```

Golden I has 125 POS menu items; Noida 29 and Noida 51 each have 128. POS menu,
product search, add-to-sale, Running Orders, Online, Reports, Global Items, and customer
ordering smoke are verified PASS. A fresh staff build matched all 114 active user-file
Hosting paths and Firebase gzip/SHA-256 hashes exactly.

Do not deploy a long-running feature branch. Every staff release must follow
`skills/10-protected-staff-release-workflow.md` and pass the non-deploying preflight gate.
If any mandatory production POS smoke check fails, roll back staff Hosting immediately
and do not touch Firestore to compensate.

## Production

**The Tasting Room is LIVE.**

Customer URL: `https://order.coffeebond.in/?store=TASTING_ROOM_29`

### Current menu

- **18 available**
- **3 blocked:** `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`

The four flights are live: `TR_COFFEE_THREE_WAYS`, `TR_COLD_BOND_FLIGHT`,
`TR_ZERO_PROOF_FLIGHT`, `TR_WAKE_UP_WITH_BOND`.

### Loyalty

- Pay Online (customer app, verified Razorpay) → **points eligible**
- Pay at Counter → **zero points**
- POS / staff-created → **zero points**
- Qualifying visits → **unchanged**

### Inventory

- `inventoryPolicy = ALLOW_NEGATIVE_DEFER_BOM`
- Physical inventory store: `cJk69Ti1mveh603L4edw`
- Logical sales store: `TASTING_ROOM_29`

## Git state

```
DEPLOYED_BUT_UNCOMMITTED=NO
PRODUCTION_BASE_SHA=0b7f97e712c8238886c38b6534d8f1620a75782d
PRODUCTION_STAFF_HOSTING_VERSION=b6dd6eb6c731ec98
PRODUCTION_STAFF_TAG=production-staff-hosting-b6dd6eb6c731ec98
PRODUCTION_BASELINE_TAG=production-staff-release-baseline-b6dd6eb6c731ec98
PRODUCTION_BASELINE_BRANCH=codex/production-staff-baseline-b6dd6eb6c731ec98
```

The exact staff source and protected baseline refs are preserved on `origin`. Production
Hosting and Firestore were not changed while establishing this baseline.

## High-priority TODO

1. **Complete real BOMs** for Tasting Room products.
2. **Run the pending-BOM backfill** so inventory reflects sales already made.
3. **Enable `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`** — only once their structural
   setup is genuinely valid, not by weakening validation.
4. **Investigate production POS Razorpay `rzp_test` configuration** (see `KNOWN_ISSUES.md`).
5. **Build generic "Copy Store Setup"** / reusable new-store provisioning.
6. **Keep this skill and knowledge bank current** after every material build, decision,
   verification, deployment, or handoff.

## What NOT to do next

- Do not weaken composite structural validation to unblock items 4.
- Do not apply `ALLOW_NEGATIVE_DEFER_BOM` to existing stores.
- Do not change POS Razorpay keys as a side effect of other work.
