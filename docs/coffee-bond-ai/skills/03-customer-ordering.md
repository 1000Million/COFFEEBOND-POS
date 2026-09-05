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
single public document is `publicMenuAvailability/{storeCode}` and contains both menu
presentation and availability verdicts — it is the customer's only view, but it is
**generated state, not the source of truth** (see the snapshot contract below).

Creating or assigning a Finished Good does not publish it *by itself*: assignment via
`availableStoreIds` is the derivation input, and the next canonical rebuild is what puts it
on the customer menu.

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

**Superseded (2026-09).** This paragraph previously read "the snapshot is curated, not
derived". That is no longer true of the collection.

`publicMenuAvailability/{STORE_CODE}` is **generated / derived state**. It is produced by the
canonical builder `buildPublicMenuAvailabilitySnapshot()`
(`frontend/lib/publicMenuAvailability.ts`) from current catalogue, store assignment
(`finishedGoods.availableStoreIds`), per-store overrides (`storeItemConfig`), and
inventory/BOM/composite availability state.

Consequences:

- It is **not canonical source data**. Do not hand-edit it operationally; a canonical
  rebuild may replace the whole document for that store.
- Writing finished goods without regenerating the snapshot still leaves the storefront
  showing "Menu unavailable" — regeneration is what publishes.
- The legacy ops script `scripts/refresh-public-menu-availability.mjs` is *curated in what
  it republishes* (only codes already present). That is a property of that one script, not
  of the collection, and it is not the path Global Items uses.
- Never write a second snapshot resolver, and never patch a single field into a stored
  snapshot by hand.

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
UI reads, so the two cannot disagree about availability. Never make something appear
available in the UI that payment or acceptance will later reject.

This equality is about the customer surface. Price is re-derived server-side at checkout
(the canonical session re-prices the cart), and POS resolves its own effective values — see
`02-pos-checkout-payments.md`. Customer price and POS price must agree because both resolve
the same `storeItemConfig` override through the same shared resolver, not because one reads
the other's document.

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

## Atomic override publish

An Admin override change and the rebuilt customer snapshot **must publish together**, in one
Firestore `writeBatch`:

```text
batch.set/delete  storeItemConfig/{storeId}__{itemCode}
batch.set         publicMenuAvailability/{store.code}   <- canonical builder output
one commit
```

POS reads `storeItemConfig` directly, so a non-atomic save would leave POS on the new price
while customers still saw the old snapshot. Rules:

- build the snapshot for the **post-save** state (project the override forward) — never write
  the override first and rebuild afterwards;
- if snapshot generation throws, **write nothing**;
- a Global Items save requires **no** separate manual refresh step. POS Readiness stays
  available for operational whole-store rebuilds.

Publishing a snapshot must never change `customerOrderingEnabled`, `posEnabled`, `isLive`,
`readiness` or store status. Snapshot publication and customer-ordering enablement are
separate decisions.

## Customer Home is an Order OS

Home exists to get a returning customer to their order. It is **not** a category wall, a
favourites wall, a loyalty sales page, or a cart supermarket.

Hierarchy, in order:

```text
store → live order (if present) → usual / start a usual → Something else → Bond status → nav
```

One Home skeleton serves every state; do not build separate pages for them. Verified states:
signed-in regular with a saved usual; live order; no usual; signed-out / first open;
ready-for-pickup; Bond progress; Club member; Club + live order; Club + no usual; and a
Bond-data-unavailable fallback.

**My Usual** is the signed-in hero: real display name, real modifiers, current *effective*
price (resolved, so a store override shows), real product image or its fallback, and the
existing basket/order path. `Place pickup` is UI hierarchy only — it must never bypass the
payment-first architecture at the top of this file.

**Signed out** is product-first: Join in the header, store chip as the location blocker,
signature products drawn from real menu data, product selection before OTP where the current
flow permits. No loyalty wall, no fabricated recent orders.

**Club** is recognition layered on the same Home — a quiet marker and the THE BOND CLUB
strip. No gold lounge, no separate premium Home, no large Club marketing module. The usual
still dominates, and a live order still outranks Club.

Nav is Home / Menu / Orders / Bond. There is **no permanent Cart tab** — the basket stays
contextual — and the Orders icon must not read as a shopping bag or cart.

The PWA install banner must stay offset above the fixed bottom nav and the safe-area inset;
it must never cover primary navigation.
