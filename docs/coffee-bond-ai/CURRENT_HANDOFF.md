# Current Handoff

_Last updated: 2026-09-06._

## Protected staff production baseline

The staff/POS site is healthy after rollback.

```text
HOSTING_VERSION=027a1e1491a811eb
EXACT_SOURCE_COMMIT=ef196da472a8153fb9cea6bf7303ed53328c4c8c
EXACT_SOURCE_TAG=production-staff-hosting-027a1e1491a811eb
PROTECTED_BRANCH=codex/production-staff-baseline-027a1e1491a811eb
```

Golden I has 125 POS menu items; Noida 29 and Noida 51 each have 128. POS menu,
product search, add-to-sale, Running Orders, Online, and Reports are verified PASS.

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
PRODUCTION_BASE_SHA=ef196da472a8153fb9cea6bf7303ed53328c4c8c
PRODUCTION_STAFF_HOSTING_VERSION=027a1e1491a811eb
PRODUCTION_STAFF_TAG=production-staff-hosting-027a1e1491a811eb
PRODUCTION_HOTFIX_PUSHED=NO
```

The exact staff source is committed and tagged locally but is not pushed. Production
Hosting and Firestore were not changed while establishing this baseline.

## High-priority TODO

1. **Push the protected baseline branch and tags only after explicit approval.** The
   exact deployed source is tag `production-staff-hosting-027a1e1491a811eb`; origin is
   intentionally unchanged in this task.
2. **Complete real BOMs** for Tasting Room products.
3. **Run the pending-BOM backfill** so inventory reflects sales already made.
4. **Enable `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`** — only once their structural
   setup is genuinely valid, not by weakening validation.
5. **Investigate production POS Razorpay `rzp_test` configuration** (see `KNOWN_ISSUES.md`).
6. **Build generic "Copy Store Setup"** / reusable new-store provisioning.
7. **Keep this skill and knowledge bank current** after every material build, decision,
   verification, deployment, or handoff.

## What NOT to do next

- Do not weaken composite structural validation to unblock items 4.
- Do not apply `ALLOW_NEGATIVE_DEFER_BOM` to existing stores.
- Do not change POS Razorpay keys as a side effect of other work.
