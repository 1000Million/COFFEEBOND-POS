# Razorpay payment-first checkout

## Customer lifecycle

1. Pay-at-Counter continues through the existing `submitCustomerOrder` request and staff acceptance path.
2. Pay Online requires Firebase Phone Authentication in the isolated `coffee-bond-customer-auth` Firebase app. It never changes the primary staff Auth session.
3. `resolveCustomerProfile` creates or retrieves a private `customerProfiles/{customerUid}` profile from the verified UID and phone claim.
4. `createCustomerCheckoutSession` revalidates the store, availability, finished goods, add-ons, prices, GST, and final amount. It creates or reuses a private checkout session, Razorpay Customer, and Razorpay order. It does not create `onlineOrders`, KOT, stock movements, or a POS order.
5. Standard Checkout receives the public Key ID, Razorpay `customer_id`, verified read-only contact, `remember_customer: true`, and UPI/card/netbanking instruments.
6. `verifyCustomerRazorpayPayment` validates the HMAC against the server-stored provider order, fetches Razorpay payment/order state, and requires the exact captured INR amount and a paid provider order.
7. Verified payment atomically creates one `PAID_PENDING_ACCEPTANCE` online order, one sanitized public tracking document, one payment intent, and one soft inventory reservation. No KOT or permanent deduction is created.
8. Incoming Orders displays the paid order. Assigned Cashier, Store Manager, or Admin may accept it through `acceptPaidRazorpayOrder`.
9. Acceptance revalidates menu, BOM, and inventory, then deterministically creates the POS order, payment row, KOT, stock movements, and converts the reservation exactly once.
10. Before acceptance, Store Manager or Admin may use `cancelAndRefundRazorpayOrder` for a full refund. Cashier is denied in UI and backend.

## Private server-only collections

- `customerProfiles/{customerUid}`
- `customerCheckoutSessions/{sessionId}`
- `razorpayPaymentIntents/{sessionId}`
- `inventoryReservations/{onlineOrderId}`
- `razorpayRefunds/{onlineOrderId}`
- `razorpayWebhookEvents/{eventId}`

Clients cannot read or write these collections. Customer recovery uses the authenticated `listMyCustomerOrders` callable, which filters by verified Firebase UID. Public tracking remains a sanitized exact-token document with no customer UID, verified phone, Razorpay Customer ID, signatures, or instrument details.

## Refund lifecycle

- Request: `REFUND_PENDING`; reservation released; no KOT or permanent stock deduction.
- `refund.created`: remains `REFUND_PENDING`.
- `refund.processed`: payment becomes `REFUNDED`, online order becomes `CANCELLED_REFUNDED`, and public tracking confirms the refund.
- `refund.failed`: becomes `REFUND_FAILED` and remains actionable for Manager/Admin.

Provider acceptance of a refund request is not treated as completion.

## Recovery and idempotency

- Stable route: `/order/status/{trackingToken}`
- Browser keys: `coffeeBondLastOrderTrackingToken`, `coffeeBondPendingOrderTokens`
- Authenticated recovery: `listMyCustomerOrders`
- Deterministic checkout session, online order, POS order, payment, KOT, stock movement, reservation, and refund IDs
- Firestore creation leases prevent parallel customer/order provisioning; provider lookups by verified contact and deterministic receipt recover interrupted attempts
- Full refunds use a deterministic `receipt` and Razorpay `X-Refund-Idempotency` header
- `payment.captured` and `order.paid` webhooks recover lost browser callbacks

The current inventory architecture cannot reserve raw/prep quantities without mutating stock. The `inventoryReservations` record is therefore an explicit soft reservation of finished-good quantities with `SOFT_REVALIDATION_REQUIRED`; staff acceptance performs the authoritative menu/BOM/inventory revalidation. It is not presented as guaranteed physical stock. The record carries an expiry for operational cleanup, and refund/cancellation releases it without touching stock.

## Standard and Magic Checkout

`RAZORPAY_MAGIC_CHECKOUT_ENABLED=false` is the default. Standard Checkout still uses the Razorpay Customer and remembered-payment support where enabled on the account.

Magic Checkout is not a release blocker. Set the flag to `true` only after Razorpay enables Magic Checkout/QuickBuy for the account; the backend will then return `one_click_checkout` and canonical line items. Standard Checkout remains the fallback.

Coffee Bond never stores card numbers, CVVs, UPI PINs, bank details, or provider payment tokens.

## Dashboard configuration required

1. Enable Firebase Phone Authentication and configure authorized domains, SMS quotas, reCAPTCHA, and test phone numbers.
2. Confirm Razorpay saved-card/tokenisation support for the account.
3. Request Magic Checkout/QuickBuy activation only if desired.
4. Create replacement test/live Key IDs and secrets. Never reuse an exposed secret.
5. Register the webhook and subscribe to:
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
   - `refund.created`
   - `refund.processed`
   - `refund.failed`

## Configuration and later deployment

```bash
firebase functions:secrets:set RAZORPAY_KEY_SECRET --project coffee-bond-pos
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET --project coffee-bond-pos
```

Non-secret parameters:

```text
RAZORPAY_KEY_ID=rzp_test_REPLACE_WITH_NEW_KEY_ID
RAZORPAY_MAGIC_CHECKOUT_ENABLED=false
```

Later approved deployment order:

```bash
firebase deploy --only functions:resolveCustomerProfile,functions:createCustomerCheckoutSession,functions:verifyCustomerRazorpayPayment,functions:listMyCustomerOrders,functions:acceptPaidRazorpayOrder,functions:cancelAndRefundRazorpayOrder,functions:razorpayWebhook --project coffee-bond-pos
firebase deploy --only firestore:rules --project coffee-bond-pos
firebase hosting:channel:deploy improvement-razorpay-checkout --project coffee-bond-pos
```

## Manual preview QA plan

Use only Razorpay Test Mode after Functions and rules are deployed to preview:

| Scenario | Expected |
| --- | --- |
| OTP isolation | Customer OTP succeeds without changing an open staff session |
| Failed/dismissed payment | No online order, POS order, payment, KOT, or stock movement; cart remains |
| Successful UPI Intent | One paid pending online order and reservation; no KOT/stock until acceptance |
| Refresh/lost callback | Stable tracking and My Orders recover the same order; webhook creates no duplicate |
| Cashier acceptance | One POS order, payment, routed KOT, and permanent deduction |
| Manager refund | Full refund pending, no KOT/deduction, reservation released |
| Refund webhooks | Processed reduces gateway collection once; failed remains actionable |
| Regressions | Pay-at-Counter, Cash, UPI, Card, Split, Complimentary, add-ons, reports, and void remain unchanged |
