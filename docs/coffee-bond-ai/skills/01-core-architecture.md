# 01 — Core Architecture

**This is an existing production system serving real customers.** Treat every change
accordingly.

## Projects

| | |
|---|---|
| Production | `coffee-bond-pos` |
| Preview / QA | `coffee-bond-pos-preview` |

There is **no default project alias**. `--project` is mandatory on every Firebase command.

`coffee-bond-pos` is a **prefix** of `coffee-bond-pos-preview` — never distinguish them
with a substring match.

## Applications

Two frontends share one `frontend/` source tree and one `frontend/index.css`:

| App | Build | Output | Site | Domain |
|---|---|---|---|---|
| Customer | `vite build --config vite.customer.config.ts` | `dist-customer/` | `coffee-bond-order` | `order.coffeebond.in` |
| Staff / POS | `vite build` | `dist/` | `coffee-bond-pos` | `pos.coffeebond.in` |

A change to shared code affects both. Always rebuild and test both.

Customer OTP runs on a **separate Firebase app** (`coffee-bond-customer-auth`) while
Firestore is bound to the default app — which is why customer Firestore traffic is
unauthenticated and reads only the public menu snapshot.

## The approved customer order lifecycle

```
OTP
  → canonical private checkout (server re-prices the cart)
  → Razorpay
  → server-side payment verification
  → PAID_PENDING_ACCEPTANCE
  → staff acceptance
  → POS order
  → KOT
  → inventory consumed exactly once
```

### Non-negotiable rules

1. **Never create a POS order, KOT or stock movement before staff acceptance.**
2. **The browser callback is not authoritative payment proof.** The server independently
   fetches payment and order state from the provider.
3. **Callback-loss recovery and idempotency must remain supported.** A lost browser
   callback is recovered by the webhook path; every write is idempotency-keyed.

## Key collections

`stores` · `finishedGoods` · `categories` · `addOnGroups` · `publicMenuAvailability` ·
`rawIngredients` · `prepItems` · `storeStock` · `stockMovements` ·
`pendingInventoryConsumption` · `orders` · `onlineOrders` · `customerCheckoutSessions` ·
`customerOrderSubmissions` · `kotItems` · `publicOrderTracking` · `loyaltyPointLedger` ·
`qualifyingVisitEvents` · `qualifyingVisitDays` · `loyaltyAccounts` · `loyaltyShadowLogs` ·
`users` · `appSettings`

## Where to look first

| Concern | File |
|---|---|
| Order → inventory | `functions/onlineOrderInventory.js` |
| Menu availability | `frontend/lib/publicMenuAvailability.ts` |
| Store aliasing | `functions/inventoryStoreResolver.js` |
| Payment-first flow | `functions/razorpayPaymentFirst.js` |
| Checkout canonicalization | `functions/customerCheckoutCanonicalization.js` |
| Composite policy | `functions/compositeProductPolicy.js` |
| KOT aggregation | `functions/kotStatusAggregation.js` |
| Loyalty | `functions/bondLoyalty.js`, `functions/bondLoyaltyPolicy.js` |
| Native POS inventory | `frontend/lib/inventoryDeduction.ts` |
