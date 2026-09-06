# Current Production State

_Verified 2026-09-06._

## Staff/POS verified production baseline

The production staff site is healthy on verified Global Items Hosting version
`b6dd6eb6c731ec98`.

Verified production POS state:

| Check | Result |
|---|---|
| Golden I menu | 125 items |
| Noida 29 menu | 128 items |
| Noida 51 menu | 128 items |
| POS menu | PASS |
| Product search | PASS |
| Add to sale | PASS |
| Running Orders | PASS |
| Online | PASS |
| Reports | PASS |
| Global Items live | YES |
| Customer ordering smoke | PASS |

Exact deployed source is committed as
`0b7f97e712c8238886c38b6534d8f1620a75782d` and tagged
`production-staff-hosting-b6dd6eb6c731ec98`. A fresh production staff build matched all
114 user-file Hosting paths and Firebase gzip/SHA-256 hashes; the remaining 2 of the 116
Hosting API entries are Firebase-reserved files. See
`../skills/10-protected-staff-release-workflow.md`.

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

`submitCustomerOrder`, `authorizePosAddOns`, `createCustomerCheckoutSession`,
`verifyCustomerRazorpayPayment`, `razorpayWebhook`, `acceptPaidRazorpayOrder`,
`aggregateKotOrderStatus`, `processBondOrderLoyalty`, `processBondPickupLoyalty`,
`resolveCustomerProfile`, `updateCustomerProfile`.

`aggregateKotOrderStatus` was newly created in production during this work.

The verified Global Items release deployed Firestore rules, only
`createCustomerCheckoutSession` and `submitCustomerOrder`, and the staff Hosting target.
Customer Hosting, Razorpay configuration, and BOND functions were unchanged.

## Git state

```
DEPLOYED_BUT_UNCOMMITTED=NO
PRODUCTION_BASE_SHA=0b7f97e712c8238886c38b6534d8f1620a75782d
PRODUCTION_STAFF_HOSTING_VERSION=b6dd6eb6c731ec98
PRODUCTION_STAFF_TAG=production-staff-hosting-b6dd6eb6c731ec98
PRODUCTION_BASELINE_TAG=production-staff-release-baseline-b6dd6eb6c731ec98
PRODUCTION_BASELINE_BRANCH=codex/production-staff-baseline-b6dd6eb6c731ec98
```

The exact-source tag and protected baseline branch/tag are preserved on `origin`.
