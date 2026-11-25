import type { PaymentMethod, Order } from '../../types';
import { toFiniteNumber } from './posTax';

type ReceiptPaymentSnapshot = { method: PaymentMethod; amount: number };
type SplitPaymentRow = { id: string; method: PaymentMethod; amountStr: string };

const PAYMENT_TOLERANCE = 0.01;

export function normalizePaymentAmount(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

export function paymentRowsAllocated(rows: SplitPaymentRow[]): number {
  return rows.reduce((sum, row) => sum + normalizePaymentAmount(row.amountStr), 0);
}

export function paymentRowsAreBalanced(totalDue: number, allocated: number): boolean {
  return Math.abs(totalDue - allocated) <= PAYMENT_TOLERANCE;
}

export function buildPaymentLabel(payments: ReceiptPaymentSnapshot[]): string {
  if (payments.length === 0) return 'UNKNOWN';
  if (payments.length === 1) return payments[0].method;
  return payments.map(payment => `${payment.method} ₹${payment.amount.toFixed(2)}`).join(' + ');
}

export function splitPaymentStatus(payments: ReceiptPaymentSnapshot[], totalDue: number): Order['paymentStatus'] {
  const creditAmount = payments
    .filter(payment => payment.method === 'CREDIT')
    .reduce((sum, payment) => sum + payment.amount, 0);

  if (creditAmount <= PAYMENT_TOLERANCE) return 'PAID';
  return creditAmount >= totalDue - PAYMENT_TOLERANCE ? 'UNPAID' : 'PARTIAL';
}

export function normalizedSplitPayments(splitPayments: SplitPaymentRow[], totalDue: number): ReceiptPaymentSnapshot[] {
  return splitPayments.map(payment => ({
    method: payment.method,
    amount: normalizePaymentAmount(payment.amountStr),
  })).filter(payment => payment.amount > 0 || totalDue === 0);
}

export function paymentTotal(payments: ReceiptPaymentSnapshot[]): number {
  return payments.reduce((sum, payment) => sum + payment.amount, 0);
}

export function paymentBalance(totalDue: number, allocated: number): number {
  return totalDue - allocated;
}

export function validateSplitPayments(paymentRows: ReceiptPaymentSnapshot[], trueGrandTotal: number, allocatedPaymentAmount: number): void {
  if (paymentRows.length === 0) {
    throw new Error('Split payment needs at least one payment row with an amount greater than zero.');
  }
  if (!paymentRowsAreBalanced(trueGrandTotal, allocatedPaymentAmount)) {
    throw new Error(`Split payment must equal the total due. Allocated ₹${allocatedPaymentAmount.toFixed(2)} against ₹${trueGrandTotal.toFixed(2)}.`);
  }
}
