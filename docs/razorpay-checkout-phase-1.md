# Razorpay Standard Checkout: Phase 1

## Existing Coffee Bond lifecycle

1. `/order` loads active stores, the public menu snapshot, add-on groups, and customer-safe availability.
2. `submitCustomerOrder` validates the public request on the server and creates `onlineOrders`, a sanitized `publicOrderTracking` document, and an idempotency record.
3. Staff review `onlineOrders` in Incoming Orders. The existing Pay-at-Counter path converts an accepted request client-side into `orders`, item and payment subcollections, `kotItems`, `stockMovements`, stock balances, and reports.
4. Rejection updates the private request and sanitized tracking record without creating POS, KOT, payment, or stock records.
5. Public tracking reads one `publicOrderTracking/{trackingToken}` document by its high-entropy token.
6. Running Orders owns settlement and manager/admin void handling. Reporting Centre, Day Close, and Franchise Viewer normalize completed orders and payment rows.

## Razorpay lifecycle

Razorpay uses acceptance before payment:

1. Submission stores `paymentProvider: RAZORPAY`, `paymentMethod: ONLINE`, and `paymentStatus: NOT_STARTED`. It creates no Razorpay order, Coffee Bond payment, KOT, or stock movement.
2. Staff acceptance reuses the existing menu, add-on, GST, BOM, and inventory validation, then records `ACCEPTED_AWAITING_PAYMENT`. It creates no operational sale records.
3. The tracking page calls `createRazorpayOrder`. The callable resolves the private order through the exact tracking token and public reference, rechecks the active store and server total, and creates or reuses a short-lived server-only intent.
4. The browser opens Razorpay Standard Checkout with the returned public Key ID and provider order.
5. The browser callback sends provider IDs and the signature to `verifyRazorpayPayment`; it never marks the order paid.
6. The callable verifies HMAC using the stored provider order ID, then fetches payment and order state from Razorpay. Only captured INR payments with the exact amount and a paid provider order proceed.
7. One Firestore transaction revalidates menu/BOM/inventory and creates the deterministic POS order, lines, payment, KOT, stock movements, pending BOM rows, counter update, and tracking update.
8. Replay returns the existing POS result. Post-payment operational blockers produce `PAYMENT_REVIEW_REQUIRED` with no silent local refund.
9. Signed webhooks recover lost browser callbacks. Event IDs and deterministic document IDs prevent duplicate payment, KOT, or stock writes.

## Server-only data

- `razorpayPaymentIntents/{deterministicIntentId}`
- `razorpayWebhookEvents/{providerEventIdOrChecksum}`

Both collections deny all client reads and writes. Public tracking exposes only provider/status/expiry fields in addition to its existing sanitized fields.

## Configuration for later approval

Create a replacement Razorpay Test Mode key. Do not reuse the previously exposed secret.

```bash
firebase functions:secrets:set RAZORPAY_KEY_SECRET --project coffee-bond-pos
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET --project coffee-bond-pos
```

Set the non-secret Functions parameter during deployment when prompted:

```text
RAZORPAY_KEY_ID=rzp_test_REPLACE_WITH_NEW_KEY_ID
```

Razorpay Dashboard webhook URL after function deployment:

```text
https://us-central1-coffee-bond-pos.cloudfunctions.net/razorpayWebhook
```

Subscribe only to `payment.captured`, `payment.failed`, and `order.paid`, and configure a new independent webhook secret.

## Deployment order for later approval

```bash
firebase deploy --only functions:createRazorpayOrder,functions:verifyRazorpayPayment,functions:razorpayWebhook --project coffee-bond-pos
firebase deploy --only firestore:rules --project coffee-bond-pos
firebase hosting:channel:deploy improvement-razorpay-checkout --project coffee-bond-pos
```

Do not expose the tracking page until all three functions and the rules are available.

## Manual Test Mode plan (not executed in Phase 1)

For each scenario, start with a fresh customer order and record counts before and after:

| Scenario | Expected private/tracking state | Expected operational records |
| --- | --- | --- |
| Successful UPI | accepted awaiting payment, then `PAID`/`CONVERTED` | one POS order, payment, routed KOT set, and one deduction per component; reports show Razorpay/UPI once |
| Failed UPI | remains accepted and unpaid with `FAILED` | no POS order, payment, KOT, or stock movement |
| Modal dismissal | remains accepted and unpaid | no operational records |
| Repeated Pay Now | active provider intent reused | no duplicate provider intent or Coffee Bond records |
| Refresh after success | tracking reloads `PAID`/`CONVERTED` | existing deterministic records only |
| Lost browser callback | webhook verifies and finalizes | same single operational record set |
| Wrong signature | verification denied and sanitized failure recorded | no operational records |
| Already-paid replay | existing order result returned | no duplicate payment/KOT/stock |
| Report reconciliation | payment collection, Day Close, Franchise Viewer show one Razorpay row and correct tender | collection totals equal order total once |
| Void safeguard | local void warns `Gateway refund required` and records `MANUAL_REFUND_REQUIRED` | stock/KOT reversal may proceed; no claim of Razorpay refund |

Cash, UPI, Card, Split, Complimentary, Pay-at-Counter, rejection, and add-on flows must be rerun as non-Razorpay regressions.

## Deferred refund phase

Provider refunds are not implemented. A Razorpay-paid local void is an operational void only and must remain `MANUAL_REFUND_REQUIRED` until a separately designed, provider-confirmed refund workflow exists.
