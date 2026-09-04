# 03 — Customer Ordering

## Approved payment-first flow

```text
OTP
→ canonical private checkout session
→ Razorpay payment
→ server-side payment verification or webhook recovery
→ PAID_PENDING_ACCEPTANCE
→ staff acceptance
→ POS order
→ KOT
→ stock consumption exactly once
```

The browser callback is not authoritative. Server verification must independently check
the payment and provider order. Callback-loss recovery and every idempotency boundary must
remain intact.

Before staff acceptance, all three counts must remain zero: POS order, KOT, and stock
movement. A retry or duplicate acceptance must not duplicate POS, KOT, stock, reporting,
or loyalty.

## Customer data boundary

The customer app reads the public menu snapshot rather than private Finished Goods. The
canonical public document is `publicMenuAvailability/{storeCode}` and contains both menu
presentation and availability verdicts. Creating or assigning Finished Goods does not
publish them automatically.

Direct store selection uses `?store=<STORE_CODE>`. Stores with
`excludeFromNearestSelection=true` remain available by deep link but must not be chosen by
nearest-store logic. Switching stores must clear or protect an incompatible basket.

## Auth persistence

Customer Firebase Auth uses the named customer app and browser-local persistence.
Persistence initialization must complete before auth restoration, OTP send, and OTP
verification. Do not store Firebase tokens manually or add cookie/localStorage hacks.

## Pay at Counter

Pay at Counter is a separate canonical submission path and creates no BOND point earn.
Current customer copy must accurately state that only eligible Pay Online orders earn
points. See `06-bond-loyalty.md`.

## Snapshot contract (concrete)

`publicMenuAvailability/{STORE_CODE}` — the doc id is the store **code**, not the id.

- `menuItems[code]` — the customer-visible product card
- `items[code]` — the verdict `{itemCode, fgCode, available, publicStatus, publicMessage}`

`available` is `publicStatus === 'AVAILABLE'` and nothing else. The four statuses are
`AVAILABLE`, `CURRENTLY_UNAVAILABLE`, `STORE_DISABLED`, `SETUP_INCOMPLETE`.

The snapshot is **curated, not derived**: the refresh script republishes only codes already
present. Adding a Finished Good to a store does not put it on the customer menu, and
writing finished goods without regenerating the snapshot leaves the storefront showing
"Menu unavailable".

## What one verification transaction creates

`verifyCustomerRazorpayPayment` performs HMAC signature validation, then an independent
server-to-server fetch of payment and provider order state. Only then does a single
transaction create exactly five things: the online order
(`onlineOrders/{WEB_RZP_…}`, `status=PAID_PENDING_ACCEPTANCE`), the public tracking
document, the payment intent, a soft inventory reservation, and the checkout session
status flip.

## Pay at Counter writes a different collection

`submitCustomerOrder` writes `customerOrderSubmissions`; the Razorpay path writes
`customerCheckoutSessions`. The Razorpay branch returns before reaching
`submitCustomerOrder`. This distinction is what the loyalty provenance gate keys on — see
`06-bond-loyalty.md`.

## UI and server read the same source

Both server-side availability gates read `available` from the **stored snapshot** that the
UI reads, so the two cannot disagree. Never make something appear available in the UI that
payment or acceptance will later reject.

Deep links are case-insensitive; an unknown store code falls back rather than selecting a
store.

## Checkout copy rules

Never imply money has changed hands before it has, or that paying is the end of the story —
the cafe still has to accept. Current production copy is recorded in
`../knowledge/CURRENT_PRODUCTION_STATE.md`.

## First places to inspect

- `frontend/lib/customerAuth.ts`
- `frontend/pages/customer/CustomerOrder.tsx`
- `functions/customerCheckoutCanonicalization.js`
- `functions/razorpayCheckout.js`
- `functions/razorpayPaymentFirst.js`
- `functions/index.js`
