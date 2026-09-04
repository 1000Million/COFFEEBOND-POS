# Current Handoff

_Last updated: 2026-09-04._

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
PRODUCTION_BASE_SHA=85f4fec3b292aa977fa41f01b9afc6c661790fe6
PRODUCTION_HOTFIX_COMMIT_SHA=THIS_COMMIT
PRODUCTION_HOTFIX_PUSHED=NO
```

The earlier Tasting Room rollout is preserved in `a8bff83`; the Phase 4 immutable
composite/PENDING_BOM hotfix is deployed and preserved by this local commit, but is not
yet pushed. `THIS_COMMIT` is intentionally symbolic because a commit cannot contain its
own hash; use `git rev-parse HEAD` for the concrete SHA. Production has the scoped updates to
`submitCustomerOrder`, `authorizePosAddOns`, `createCustomerCheckoutSession`, and
`acceptPaidRazorpayOrder`, plus the matching staff hosting bundle. Firestore rules,
customer hosting, Razorpay configuration, and BOND logic were not changed.

## High-priority TODO

1. **Push the preserved production hotfix only after explicit approval.** The exact
   deployed delta is in the current local commit; origin intentionally remains at the
   pre-hotfix base.
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
