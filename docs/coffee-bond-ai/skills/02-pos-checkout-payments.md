# 02 — POS Checkout and Payments

Preserve the existing POS rather than rebuilding checkout flows. It already supports
Cash, UPI, split payments, held bills, recall, discounts, receipts, reporting, KOT,
inventory, online orders, and role permissions.

## Tender invariants

- Cash, UPI, and split payments remain supported.
- Split tenders must total the final payable amount exactly. Note that a store price
  override plus a percentage discount can produce a fractional payable — see the open
  release-QA item at the end of this file.
- A held bill creates no KOT and consumes no stock.
- Recalling a held bill must resume the same transaction without duplicating an order,
  KOT, stock movement, payment, or report row.
- Payment, discounts, GST, voids, and receipts must reconcile to the same final payable.

## Discount authority

| Role | Maximum percentage discount |
|---|---:|
| Cashier | 10% |
| Store Manager | 20% |
| Admin | 100% |

Do not enforce role limits only in presentation code. Preserve the existing server/rules
and operational checks. Store Managers remain limited to assigned stores.

## Voids and reversals

- A void requires a reason and authorized role.
- Reverse stock exactly once and retain the original movement trail.
- Update reports and payment state consistently; never edit the original sale into a
  history that no longer explains what happened.
- Do not redesign the pre-existing provider-refund/client-void workflow as a side effect
  of unrelated work. Its known risks are recorded in `../knowledge/KNOWN_ISSUES.md`.

## Razorpay separation

Customer Pay Online and staff POS Razorpay are distinct configurations and flows.
Production currently has a live customer key and a test-mode POS key. Do not silently
change either. Never print or reconstruct secret values.

## POS must price from the resolved store item

POS reads `storeItemConfig` and resolves each menu row through the shared resolver
(`resolvePosMenuItems`, see `01-core-architecture.md`). In `POSHome.tsx` the display list,
the cart lookup and the **authoritative checkout re-read** all consume the same resolved
array, so they cannot drift apart.

Non-negotiable: **never fix the displayed price while checkout still reads the global
`salePrice`.** Any future change must preserve

```text
customer menu price == POS display price == POS authoritative checkout price
```

Availability parity holds the same way: an item unavailable for customers is unavailable in
POS. The one deliberate asymmetry is `menuVisibilityOverride`, which is customer-menu only
and must not remove an item from POS.

## The override price is the base for money

Discount authority is unchanged — Cashier 10%, Store Manager 20%, Admin 100%. What changed is
the base those percentages apply to: the **resolved** price, not the global `salePrice`.

The override price feeds discounts, GST, cash, UPI, split tenders and quantity line totals.
GST precedence is unchanged (item → store → application default) and **no GST field exists on
`storeItemConfig`** — do not add one; that would create a second, competing GST mechanism.

## OPEN release-QA item: fractional payables

Not solved. Recorded so it is not rediscovered or casually "fixed":

> A store override price combined with a percentage discount can produce fractional payable
> values under current calculation semantics — ₹375 with a 10% discount yields ₹354.375.

Receipt, report and payment rounding on override-derived totals has **not** been verified.
Do not invent or prescribe a rounding algorithm. This must be explicitly verified and
approved in release QA before override prices are rolled out to a production store.

## First places to inspect

- `frontend/pages/pos/POSHome.tsx`
- `frontend/lib/storeItemConfig.ts`
- `frontend/lib/posPricing.ts`
- `frontend/pages/pos/RunningOrders.tsx`
- `functions/posRazorpay.js`
- `frontend/lib/inventoryDeduction.ts`
- `frontend/lib/onlineOrderConversion.ts`
