# 02 — POS Checkout and Payments

Preserve the existing POS rather than rebuilding checkout flows. It already supports
Cash, UPI, split payments, held bills, recall, discounts, receipts, reporting, KOT,
inventory, online orders, and role permissions.

## Tender invariants

- Cash, UPI, and split payments remain supported.
- Split tenders must total the final payable amount exactly.
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

## First places to inspect

- `frontend/pages/pos/POSHome.tsx`
- `frontend/pages/pos/RunningOrders.tsx`
- `functions/posRazorpay.js`
- `frontend/lib/inventoryDeduction.ts`
- `frontend/lib/onlineOrderConversion.ts`
