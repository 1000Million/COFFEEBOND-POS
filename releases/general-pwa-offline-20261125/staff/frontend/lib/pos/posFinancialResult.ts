import type { PosCheckoutFinancials } from '../posAddOnAuthorization';

/** Verify the committed response before displaying an initial receipt. */
export function assertCommittedFinancialResult(
  plan: PosCheckoutFinancials,
  order: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
  payments: Array<Record<string, unknown>>,
): void {
  const fail = () => { throw new Error('The saved checkout result could not be verified. Check this checkout before retrying.'); };
  const fields = ['subtotal', 'discountPercent', 'discountAmount', 'taxableAmount', 'taxTotal', 'gstTotal', 'grandTotal'] as const;
  for (const field of fields) if (order[field] !== plan[field]) fail();
  if (order.discountTotal !== plan.discountAmount || order.discount !== plan.discountAmount
    || order.commercialStatus !== plan.commercialStatus || order.paymentStatus !== plan.paymentStatus
    || order.paymentMethod !== plan.paymentMethod || (order.isSplitPayment === true) !== plan.isSplitPayment) fail();
  const expectedItems = new Set(plan.itemIds);
  if (items.length !== expectedItems.size || new Set(items.map(item => item.id)).size !== items.length) fail();
  for (const item of items) {
    if (typeof item.id !== 'string' || !expectedItems.has(item.id)) fail();
    const expected = plan.lines[item.id as string];
    for (const field of ['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal'] as const) {
      if (item[field] !== expected[field]) fail();
    }
  }
  if (payments.length !== plan.paymentIds.length || new Set(payments.map(payment => payment.id)).size !== payments.length) fail();
  for (const payment of payments) {
    const expected = typeof payment.id === 'string' ? plan.payments[payment.id] : undefined;
    if (!expected || payment.method !== expected.method || payment.amount !== expected.amount
      || payment.paymentIndex !== expected.paymentIndex) fail();
  }
}

/** Recovery may see a later server settlement; original sale prices/lines stay bound. */
export function assertRecoveredFinancialResult(
  plan: PosCheckoutFinancials,
  order: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
  payments: Array<Record<string, unknown>>,
): void {
  const initialIds = new Set(plan.paymentIds);
  const initialPayments = payments.filter(payment => typeof payment.id === 'string' && initialIds.has(payment.id));
  assertCommittedFinancialResult(plan, {
    ...order, paymentStatus: plan.paymentStatus, paymentMethod: plan.paymentMethod, isSplitPayment: plan.isSplitPayment,
  }, items, initialPayments);
  if (!order.settledAt) {
    assertCommittedFinancialResult(plan, order, items, payments);
    return;
  }
  const tenders = new Set(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO']);
  const fail = () => { throw new Error('The recovered checkout financial records require review. Keep the original checkout identity.'); };
  if (order.paymentStatus !== 'PAID' || typeof order.id !== 'string'
    || new Set(payments.map(payment => payment.id)).size !== payments.length) fail();
  for (const payment of payments) {
    if (typeof payment.amount !== 'number' || !Number.isFinite(payment.amount) || payment.amount < 0) fail();
    if (!initialIds.has(String(payment.id)) && (typeof payment.id !== 'string'
      || !payment.id.startsWith(`${order.id}_SETTLE_`) || !tenders.has(String(payment.method)))) fail();
  }
  const collected = payments.filter(payment => tenders.has(String(payment.method)))
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  if (Math.abs(collected - plan.grandTotal) > 0.010000001) fail();
}
