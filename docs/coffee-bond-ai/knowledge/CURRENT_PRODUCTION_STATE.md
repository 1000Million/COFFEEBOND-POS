# Current Production State

_Verified 2026-09-04._

## Projects and sites

| | |
|---|---|
| Production Firebase project | `coffee-bond-pos` |
| Preview Firebase project | `coffee-bond-pos-preview` |
| Customer site | `https://order.coffeebond.in` (hosting target `customer`, site `coffee-bond-order`) |
| Staff site | `https://pos.coffeebond.in` (hosting target `staff`, site `coffee-bond-pos`) |

There is **no default project alias** — `--project` is mandatory on every Firebase command.

## Live stores

Five pre-existing stores plus the Tasting Room. See `STORES_AND_IDS.md` for document ids.

Public menus exist for: `GOLDEN_I`, `NOIDA_29`, `NOIDA_51`, `UDAY_PARK`, `TASTING_ROOM_29`.

Verified unaffected by the Tasting Room rollout: Noida 29, Noida 51 and Uday Park each
load 87 items with 73 orderable, with no Tasting Room leakage. With no `?store=`
parameter the app defaults to Golden I — the Tasting Room is correctly excluded from
nearest-store auto-selection.

## Tasting Room

**LIVE.** 18 items available, 3 composites blocked. Full detail in `TASTING_ROOM.md`.

## Inventory model

Active model: **FINISHED_GOODS V2 / FINISHED_GOODS**.

Inventory policy is **opt-in per store** via the `inventoryPolicy` field:
`STRICT` (default) · `ALLOW_NEGATIVE` · `ALLOW_NEGATIVE_DEFER_BOM`.

Only `TASTING_ROOM_29` carries an explicit policy. Golden I resolves to
`ALLOW_NEGATIVE_DEFER_BOM` through a legacy identity fallback. **Every other store is
STRICT and must stay that way** unless explicitly approved.

## BOND loyalty policy

Point earning requires payment completed online in the customer app.

| Origin | Points |
|---|---|
| Customer app + Pay Online (verified Razorpay) | **eligible** |
| Customer app + Pay at Counter | **zero** |
| POS / staff / counter-created | **zero** |

Authoritative provenance for point earning is `PRIVATE_CHECKOUT_SESSION`.
`PRIVATE_CUSTOMER_SUBMISSION` must not earn points.

**Qualifying visits are separate and unchanged.**

## Deployed functions (Tasting Room / customer path)

`createCustomerCheckoutSession`, `verifyCustomerRazorpayPayment`, `razorpayWebhook`,
`acceptPaidRazorpayOrder`, `aggregateKotOrderStatus`, `processBondOrderLoyalty`,
`processBondPickupLoyalty`, `resolveCustomerProfile`, `updateCustomerProfile`.

`aggregateKotOrderStatus` was newly created in production during this work.

## Git state

```
DEPLOYED_BUT_UNCOMMITTED=NO
PRODUCTION_COMMIT_SHA=a8bff838d51fec0a3533b80b492b67a470ac67b4
```

The deployed source is preserved in commit `a8bff83`
("feat: preserve tasting room production rollout", 84 files, +8572/-577) on branch
`release/customer-order-bond-20260820`.

Pushed to `origin/release/customer-order-bond-20260820`.
