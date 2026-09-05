/**
 * Day Close money aggregation, extracted VERBATIM from pages/reports/DayClose.tsx so it can be
 * exercised by a runtime test. DayClose.tsx imports lib/firebase at module scope, which makes
 * the page itself unloadable outside a browser.
 *
 * No behaviour change: the logic below is a byte-for-byte move, and DayClose.tsx now imports
 * buildDayCloseSummary instead of declaring it. All order arithmetic still comes from the
 * shared real implementation summarizeReportingRecords in functions/reportingCore.mjs.
 */
import type { OnlineOrder, Order, PaymentMethod } from '../types';
import { financialNumber as moneyNumberLocal } from './financialNumber';
// @ts-ignore - untyped .mjs module, imported by the page the same way
import { summarizeReportingRecords } from '../../functions/reportingCore.mjs';

export const DAY_CLOSE_PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'RAZORPAY', 'ONLINE', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY', 'PAY_AT_COUNTER'];

export type DayCloseSummary = {
  completedBillCount: number;
  voidedBillCount: number;
  grossSales: number;
  voidedSales: number;
  netSales: number;
  gstTotal: number;
  discountTotal: number;
  paymentBreakdown: Record<PaymentMethod, number>;
  expectedCash: number;
  grossPaymentsReceived: number;
  voidedPaymentTotal: number;
  refundedOrReversedPayments: number;
  refundPendingPayments: number;
  manualRefundRequiredPayments: number;
  netCollections: number;
};

/** Finite coercion only - no rounding. Shared with RunningOrders via lib/financialNumber. */
export { financialNumber as moneyNumber } from './financialNumber';

export function buildDayCloseSummary(orders: Order[], onlineOrders: OnlineOrder[]): DayCloseSummary {
  const metrics = summarizeReportingRecords(orders.map(order => ({ order, items: [], payments: [] })));
  const unlinkedGatewayOrders = onlineOrders.filter(order => (
    order.paymentProvider === 'RAZORPAY'
    && !order.linkedOrderId
    && ['PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(order.paymentStatus || '')
  ));
  const gatewayGross = unlinkedGatewayOrders.reduce((sum, order) => sum + moneyNumberLocal(order.grandTotal), 0);
  const gatewayRefunded = unlinkedGatewayOrders
    .filter(order => order.paymentStatus === 'REFUNDED')
    .reduce((sum, order) => sum + moneyNumberLocal(order.grandTotal), 0);
  const gatewayPending = unlinkedGatewayOrders
    .filter(order => order.paymentStatus === 'REFUND_PENDING')
    .reduce((sum, order) => sum + moneyNumberLocal(order.grandTotal), 0);
  // G7.4: coerce the POS RAZORPAY tender BEFORE adding gatewayGross.
  // reportingCore seeds paymentBreakdown as {} and only adds a key for methods actually paid,
  // so with no RAZORPAY-paid POS order the term was `undefined + gatewayGross` === NaN, which
  // the finite guard then flattened to 0 - silently dropping unlinked gateway revenue from this
  // bucket while grossPaymentsReceived and netCollections still counted it.
  // gatewayGross itself is unchanged, and it is added exactly once.
  const paymentBreakdown = DAY_CLOSE_PAYMENT_METHODS.reduce((summary, method) => {
    summary[method] = method === 'RAZORPAY'
      ? moneyNumberLocal(metrics.paymentBreakdown.RAZORPAY) + gatewayGross
      : moneyNumberLocal(metrics.paymentBreakdown[method]);
    return summary;
  }, {} as Record<PaymentMethod, number>);

  return {
    completedBillCount: metrics.orderCount,
    voidedBillCount: metrics.voidOrderCount,
    grossSales: metrics.netSales,
    voidedSales: metrics.voidedOrderValue,
    netSales: metrics.netSales,
    gstTotal: metrics.gstCollected,
    discountTotal: metrics.discounts,
    paymentBreakdown,
    expectedCash: paymentBreakdown.CASH,
    grossPaymentsReceived: metrics.grossPaymentsReceived + gatewayGross,
    voidedPaymentTotal: metrics.voidedPaymentTotal + gatewayRefunded,
    refundedOrReversedPayments: metrics.refundedOrReversedPayments + gatewayRefunded,
    refundPendingPayments: metrics.refundPendingPayments + gatewayPending,
    manualRefundRequiredPayments: metrics.manualRefundRequiredPayments,
    netCollections: metrics.netCollections + gatewayGross - gatewayRefunded,
  };
}
