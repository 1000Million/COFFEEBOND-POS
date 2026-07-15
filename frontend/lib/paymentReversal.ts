import { Order, OrderItem, OrderPayment, PaymentMethod } from '../types';

export type PaymentReversalStatus =
  | 'NOT_REQUIRED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'REFUND_PENDING'
  | 'MANUAL_REFUND_REQUIRED';

export type PaymentReversalLine = {
  method: PaymentMethod | string;
  originalAmount: number;
  amount: number;
  reversalStatus: PaymentReversalStatus;
  reason: string;
};

export type PaymentReversalAudit = {
  paymentReversalStatus: PaymentReversalStatus;
  paymentReversalBreakdown: PaymentReversalLine[];
  paymentReversalTotal: number;
  refundedAmount: number;
  reversedAmount: number;
  refundPendingAmount: number;
  manualRefundRequiredAmount: number;
  netCollectionAmount: number;
};

export type PaymentCollectionAudit = {
  grossPaymentsReceived: number;
  voidedPaymentTotal: number;
  refundedOrReversedPayments: number;
  refundPendingPayments: number;
  manualRefundRequiredPayments: number;
  netCollections: number;
};

export const VOIDED_ITEM_STATUS_LABEL = 'VOIDED / CANCELLED';

function money(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizePaymentRows(order: Order, payments?: OrderPayment[]): PaymentReversalLine[] {
  const sourceRows = payments && payments.length > 0
    ? payments
    : Array.isArray(order.paymentBreakdown) && order.paymentBreakdown.length > 0
      ? order.paymentBreakdown
      : [{ method: order.paymentMethod, amount: order.grandTotal }];

  return sourceRows
    .map((payment) => {
      const method = String(payment.method || 'UNKNOWN');
      const amount = money(payment.amount);
      return {
        method,
        originalAmount: amount,
        amount,
        reversalStatus: 'NOT_REQUIRED' as PaymentReversalStatus,
        reason: '',
      };
    })
    .filter((payment) => payment.amount > 0 && payment.method !== 'PAY_AT_COUNTER');
}

function tenderReversalStatus(method: string): PaymentReversalStatus {
  if (method === 'CASH') return 'REFUNDED';
  if (method === 'CREDIT' || method === 'COMPLIMENTARY') return 'REVERSED';
  if (method === 'UPI' || method === 'CARD' || method === 'SWIGGY' || method === 'ZOMATO') {
    return 'MANUAL_REFUND_REQUIRED';
  }
  return 'REFUND_PENDING';
}

function statusReason(status: PaymentReversalStatus): string {
  if (status === 'REFUNDED') return 'Cash received for the voided order should be returned to the customer.';
  if (status === 'REVERSED') return 'Non-cash liability/complimentary tender reversed for the voided order.';
  if (status === 'MANUAL_REFUND_REQUIRED') return 'External payment must be refunded manually and verified outside POS.';
  if (status === 'REFUND_PENDING') return 'Refund is pending manual confirmation.';
  return 'No payment was collected for this order.';
}

function aggregateStatus(lines: PaymentReversalLine[]): PaymentReversalStatus {
  if (lines.length === 0) return 'NOT_REQUIRED';
  if (lines.some((line) => line.reversalStatus === 'MANUAL_REFUND_REQUIRED')) return 'MANUAL_REFUND_REQUIRED';
  if (lines.some((line) => line.reversalStatus === 'REFUND_PENDING')) return 'REFUND_PENDING';
  if (lines.some((line) => line.reversalStatus === 'REFUNDED')) return 'REFUNDED';
  return 'REVERSED';
}

export function buildPaymentReversalAudit(order: Order, payments?: OrderPayment[]): PaymentReversalAudit {
  const paidRows = normalizePaymentRows(order, payments);
  const lines = paidRows.map((line) => {
    const reversalStatus = tenderReversalStatus(line.method);
    return {
      ...line,
      reversalStatus,
      reason: statusReason(reversalStatus),
    };
  });
  const paymentReversalStatus = aggregateStatus(lines);
  const paymentReversalTotal = money(lines.reduce((sum, line) => sum + line.amount, 0));
  const refundedAmount = money(lines.filter((line) => line.reversalStatus === 'REFUNDED').reduce((sum, line) => sum + line.amount, 0));
  const reversedAmount = money(lines.filter((line) => line.reversalStatus === 'REVERSED').reduce((sum, line) => sum + line.amount, 0));
  const refundPendingAmount = money(lines.filter((line) => line.reversalStatus === 'REFUND_PENDING').reduce((sum, line) => sum + line.amount, 0));
  const manualRefundRequiredAmount = money(lines.filter((line) => line.reversalStatus === 'MANUAL_REFUND_REQUIRED').reduce((sum, line) => sum + line.amount, 0));

  return {
    paymentReversalStatus,
    paymentReversalBreakdown: lines,
    paymentReversalTotal,
    refundedAmount,
    reversedAmount,
    refundPendingAmount,
    manualRefundRequiredAmount,
    netCollectionAmount: money(paymentReversalTotal - refundedAmount - reversedAmount - refundPendingAmount - manualRefundRequiredAmount),
  };
}

export function orderPaymentReversalAudit(order: Order): PaymentReversalAudit {
  const record = order as Order & Partial<PaymentReversalAudit>;
  if (Array.isArray(record.paymentReversalBreakdown) && record.paymentReversalBreakdown.length > 0) {
    return {
      paymentReversalStatus: record.paymentReversalStatus || aggregateStatus(record.paymentReversalBreakdown),
      paymentReversalBreakdown: record.paymentReversalBreakdown,
      paymentReversalTotal: money(record.paymentReversalTotal ?? record.paymentReversalBreakdown.reduce((sum, line) => sum + money(line.amount), 0)),
      refundedAmount: money(record.refundedAmount),
      reversedAmount: money(record.reversedAmount),
      refundPendingAmount: money(record.refundPendingAmount),
      manualRefundRequiredAmount: money(record.manualRefundRequiredAmount),
      netCollectionAmount: money(record.netCollectionAmount),
    };
  }

  if (order.status === 'VOIDED') {
    return buildPaymentReversalAudit(order);
  }

  return {
    paymentReversalStatus: 'NOT_REQUIRED',
    paymentReversalBreakdown: [],
    paymentReversalTotal: 0,
    refundedAmount: 0,
    reversedAmount: 0,
    refundPendingAmount: 0,
    manualRefundRequiredAmount: 0,
    netCollectionAmount: 0,
  };
}

export function paymentOutcomeLabel(order: Order, payments?: OrderPayment[]): string {
  if (order.status !== 'VOIDED') return order.paymentStatus || 'UNPAID';
  const audit = payments ? buildPaymentReversalAudit(order, payments) : orderPaymentReversalAudit(order);
  if (audit.paymentReversalStatus === 'NOT_REQUIRED') return 'VOIDED / NO PAYMENT';
  if (audit.paymentReversalStatus === 'REFUNDED') return 'VOIDED / CASH REFUNDED';
  if (audit.paymentReversalStatus === 'REVERSED') return 'VOIDED / PAYMENT REVERSED';
  if (audit.paymentReversalStatus === 'REFUND_PENDING') return 'VOIDED / REFUND PENDING';
  return 'VOIDED / MANUAL REFUND REQUIRED';
}

export function orderItemDisplayStatus(order: Order, item?: Pick<OrderItem, 'status'> | null): string {
  if (order.status === 'VOIDED') return VOIDED_ITEM_STATUS_LABEL;
  return item?.status || 'PENDING';
}

export function summarizeCollections(orders: Order[]): PaymentCollectionAudit {
  return orders.reduce<PaymentCollectionAudit>((summary, order) => {
    const rows = normalizePaymentRows(order);
    const orderPayments = money(rows.reduce((sum, row) => sum + row.amount, 0));
    summary.grossPaymentsReceived += orderPayments;

    if (order.status === 'VOIDED') {
      const audit = orderPaymentReversalAudit(order);
      summary.voidedPaymentTotal += audit.paymentReversalTotal;
      summary.refundedOrReversedPayments += audit.refundedAmount + audit.reversedAmount;
      summary.refundPendingPayments += audit.refundPendingAmount;
      summary.manualRefundRequiredPayments += audit.manualRefundRequiredAmount;
    }

    summary.netCollections = summary.grossPaymentsReceived - summary.voidedPaymentTotal;
    return summary;
  }, {
    grossPaymentsReceived: 0,
    voidedPaymentTotal: 0,
    refundedOrReversedPayments: 0,
    refundPendingPayments: 0,
    manualRefundRequiredPayments: 0,
    netCollections: 0,
  });
}
