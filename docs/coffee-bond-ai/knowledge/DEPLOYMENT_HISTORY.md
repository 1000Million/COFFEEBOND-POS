# Deployment History

Production deployments (project `coffee-bond-pos`). Preview work is noted where it
provided the evidence for a production step.

> **Preserved rollout commit:** `a8bff838d51fec0a3533b80b492b67a470ac67b4`
> ("feat: preserve tasting room production rollout", 84 files, +8572/-577) on branch
> `release/customer-order-bond-20260820`. The later Phase 4 hotfix recorded below is
> deployed and preserved by this local commit, but intentionally not pushed.

## 2026-09-03 — Tasting Room go-live

Rollback points captured before starting:

| Target | Previous state |
|---|---|
| hosting `coffee-bond-pos` (staff) | version `47ec1ac71b83eda3`, released 2026-08-21 |
| hosting `coffee-bond-order` (customer) | version `609b3a35e6c38f54`, released 2026-09-02 |
| firestore rules | ruleset `61ec26df-859d-481d-8d6f-7f6269a94cc5` |

### Functions — 9 deployed

`createCustomerCheckoutSession`, `verifyCustomerRazorpayPayment`, `razorpayWebhook`,
`acceptPaidRazorpayOrder`, `processBondOrderLoyalty`, `processBondPickupLoyalty`,
`resolveCustomerProfile`, `updateCustomerProfile` (updates) and
**`aggregateKotOrderStatus` (created — new in production)**.

All six string params were recovered **verbatim from the live deployment** rather than
retyped, so Razorpay configuration was provably unchanged.

### Firestore rules

Compiled and released.

### Data — 48 documents

1 store + 8 categories + 35 finished goods + 4 add-on groups. Hard guards asserted
before applying: document count 48, available items 14, blocked composites 7,
`inventoryStoreId=cJk69Ti1mveh603L4edw`, `inventoryPolicy=ALLOW_NEGATIVE_DEFER_BOM`.

### Public menu snapshot

`publicMenuAvailability/TASTING_ROOM_29` created with a **create-only** precondition
(`currentDocument.exists=false`). Public menus went 4 → 5; the existing 4 unchanged.

> The customer app reads **only** `publicMenuAvailability`. The 48-document write alone
> left the storefront showing "Menu unavailable" — the snapshot is required.

### Hosting

Customer (`coffee-bond-order`, 31 files) and staff (`coffee-bond-pos`, 111 files).

### Result

18 → *(at this point 14)* items live; existing stores verified unaffected.

## 2026-09-03 — Four flights enabled

Code: composite child validation relaxed for **explicit** `ALLOW_NEGATIVE_DEFER_BOM`
stores, empty-child-BOM case only.

> A first attempt gated this on the broader sales-first predicate and broke the existing
> invariant *"Golden I cannot bypass composite child readiness"*. The suite caught it;
> the gate was re-scoped to the explicit policy field.

Data: 16 finished goods set `isAvailable=true` — the 4 flights plus the 12 components they
use. Mini Affogato's 2 components and the 3 blocked parents were untouched.

Snapshot updated: **18 available, 3 blocked**. Both hosting targets redeployed.

## 2026-09-04 — BOND payment-method policy + checkout copy

Rollback points: `processBondOrderLoyalty` rev `processbondorderloyalty-00002-dab`;
hosting `coffee-bond-order` version `2df929dd8c0c5dd1`.

- **`processBondOrderLoyalty` only** deployed → rev `processbondorderloyalty-00003-hof`.
- **`processBondPickupLoyalty` deliberately NOT redeployed** (still `00002-mox`) — it owns
  the qualifying-visit path, so leaving it untouched guarantees visit policy did not move.
- Customer hosting redeployed with the new payment copy and loyalty warning.

Verified after deploy: copy live, warning toggles correctly, 0 ERROR-level function logs,
Razorpay config unchanged (`rzp_live` customer / `rzp_test` POS, both on prior revisions).

## 2026-09-04 — Immutable composite/PENDING_BOM production hotfix

Preview evidence first: Pay at Counter order `CBWEB-ZYTKQ7QUQH` became POS order
`CB-TASTING_ROOM_29-20260904-0001`; its frozen three-child snapshot drove acceptance,
BARISTA/KITCHEN KOT routing and PENDING_BOM records exactly once, including an idempotent
acceptance replay. The Razorpay payment-first suite passed 105/105 without placing a paid
production order.

Production deployment was deliberately scoped to four functions:
`submitCustomerOrder`, `authorizePosAddOns`, `createCustomerCheckoutSession`, and
`acceptPaidRazorpayOrder`. The staff hosting target was then deployed. Direct downloads
of all four live function source archives matched the corresponding local hotfix files
byte-for-byte. Customer hosting, Firestore rules, BOND functions and Razorpay values and
secret fingerprints were unchanged.

After all four functions were ACTIVE, a guarded transaction re-enabled only
`TR_COFFEE_THREE_WAYS`, `TR_COLD_BOND_FLIGHT`, `TR_ZERO_PROOF_FLIGHT`, and
`TR_WAKE_UP_WITH_BOND`. `publicMenuAvailability/TASTING_ROOM_29` finished at **18
available / 3 blocked**, with the blocked set exactly `TR_MINI_AFFOGATO`, `TR_SET_A`, and
`TR_SET_B`. All other public menu snapshots and store policies were unchanged.

Protected historical orders `SyxpmdmKJhVH01Ril1Sb` and `ix3Tv99oCC3nzBrC6t57` retained
their exact document hashes and update times. No order was migrated, rewritten, accepted,
or rejected by this deployment. Post-deploy public-site, staff-route, live-data and
function-log checks passed with zero ERROR/CRITICAL/ALERT entries in the observed window.

```
DEPLOYED_BUT_UNCOMMITTED=NO
PRODUCTION_BASE_SHA=85f4fec3b292aa977fa41f01b9afc6c661790fe6
PRODUCTION_HOTFIX_COMMIT_SHA=THIS_COMMIT
PRODUCTION_HOTFIX_PUSHED=NO
```

`THIS_COMMIT` is intentionally symbolic because a Git commit cannot embed its own hash;
the concrete preservation SHA is the output of `git rev-parse HEAD` for this commit.

## Rollback quick reference

```
processBondOrderLoyalty  → redeploy from origin/release/customer-order-bond-20260820
                           (previous rev processbondorderloyalty-00002-dab)
customer hosting         → version 2df929dd8c0c5dd1
staff hosting            → version 47ec1ac71b83eda3
firestore rules          → ruleset 61ec26df-859d-481d-8d6f-7f6269a94cc5
```
