import React from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, Copy } from 'lucide-react';
import CustomerHeader from './CustomerHeader';
import CustomerBottomNav from './CustomerBottomNav';
import { CustomerProfile } from '../../lib/customerAuth';
import { PublicOrderStatus, PublicOrderTracking } from '../../types';
import { publicStatusMessage } from '../../lib/publicOrderTracking';
import { CUSTOMER_MY_ORDERS_PATH } from '../../lib/customerRoutes';

export function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

export function formatDate(value: any): string {
  const date = value?.toDate ? value.toDate() : null;
  return date ? date.toLocaleString() : 'Just now';
}

export function statusLabel(status: PublicOrderStatus): string {
  if (status === 'PAYMENT_PROCESSING') return 'Confirming payment';
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Paid, awaiting store';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment under review';
  if (status === 'REFUND_PENDING') return 'Refund in progress';
  if (status === 'REFUNDED') return 'Refunded';
  if (status === 'REFUND_FAILED') return 'Refund needs attention';
  if (status === 'CANCELLED_REFUNDED') return 'Cancelled and refunded';
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'Order confirmed';
  if (status === 'PREPARING') return 'Preparing';
  if (status === 'READY') return 'Ready for pickup';
  if (status === 'SERVED') return 'Completed';
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'NEEDS_ATTENTION') return 'Store reviewing';
  if (status === 'REJECTED') return 'Not accepted';
  return 'Request sent';
}

export function statusMessage(order: PublicOrderTracking): string {
  return order.customerStatusMessage || publicStatusMessage(order.publicStatus);
}

export function isEnded(status: PublicOrderStatus): boolean {
  return ['REJECTED', 'CANCELLED', 'CANCELLED_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(status);
}

export function isAttention(status: PublicOrderStatus): boolean {
  return ['NEEDS_ATTENTION', 'PAYMENT_REVIEW_REQUIRED', 'REFUND_PENDING', 'REFUND_FAILED'].includes(status);
}

/** Which tone the one filled surface on this screen takes. */
export function heroTone(order: PublicOrderTracking | null): string {
  if (!order) return 'is-progress';
  if (isEnded(order.publicStatus)) return 'is-ended';
  if (isAttention(order.publicStatus)) return 'is-attention';
  if (order.publicStatus === 'READY' || order.publicStatus === 'SERVED') return 'is-ready';
  return 'is-progress';
}

/**
 * Which of the three compact steps the order is on.
 *
 * The five-step list is collapsed to Confirmed -> Preparing -> Ready. Nothing about
 * the mapping is invented: every branch reads the same canonical statuses the previous
 * five-step version did, only grouped.
 */
export type StepKey = 'CONFIRMED' | 'PREPARING' | 'READY';
export const STEPS: Array<{ key: StepKey; label: string }> = [
  { key: 'CONFIRMED', label: 'Confirmed' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'READY', label: 'Ready' },
];

export function stepState(status: PublicOrderStatus, step: StepKey): 'done' | 'active' | 'pending' {
  if (status === 'SERVED') return 'done';
  if (status === 'READY') return step === 'READY' ? 'active' : 'done';
  if (status === 'PREPARING' || status === 'CONVERTED' || status === 'ACCEPTED') {
    if (step === 'CONFIRMED') return 'done';
    if (step === 'PREPARING') return 'active';
    return 'pending';
  }
  // Everything earlier — request sent, payment in flight, awaiting the store.
  return step === 'CONFIRMED' ? 'active' : 'pending';
}

export type TrackingScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; order: PublicOrderTracking };

export type Props = {
  state: TrackingScreenState;
  profile: CustomerProfile | null;
  authRestored: boolean;
  copyMessage: string;
  onCopyTrackingLink: () => void;
  onProfileUpdated: (profile: CustomerProfile) => void;
  onSignedOut: () => void;
  onOpenMyUsual: () => void;
};

/**
 * Order tracking.
 *
 * The screen answers one question — what is happening with my order — so the answer is
 * the largest thing on it and the only filled surface. Everything below is quieter than
 * it: the progression is a three-dot strip on the page rather than a panel, and the
 * summary is a flat list with one hairline above its totals. The previous version stacked
 * a status card, a reference card with two tinted boxes inside it, a progress card and a
 * summary card, all at the same weight, and ended in three buttons — two of which
 * repeated the permanent navigation.
 *
 * The store's order number used to sit inline beside the store name and collided with it
 * on narrow screens. It is now the hero's eyebrow and the store name has moved up beside
 * the back link, so neither can overlap the other.
 *
 * The live subscription is untouched: the container still runs the same onSnapshot on
 * the same public tracking document, keyed on the same token.
 */
export default function CustomerTrackingScreen({
  state,
  profile,
  authRestored,
  copyMessage,
  onCopyTrackingLink,
  onProfileUpdated,
  onSignedOut,
  onOpenMyUsual,
}: Props) {
  const order = state.kind === 'ready' ? state.order : null;
  const tone = heroTone(order);

  return (
    <div className="cb-app cb-customer-page-bottom min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#fbf7f1] font-sans text-[#271a16] [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      <CustomerHeader
        title="Track order"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={onProfileUpdated}
        onSignedOut={onSignedOut}
        onOpenMyUsual={onOpenMyUsual}
        rightSlot={(
          <button
            onClick={onCopyTrackingLink}
            className="cb-customer-icon-button inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-xs font-black"
            aria-label="Copy tracking link"
          >
            <Copy size={14} aria-hidden="true" />
            Copy
          </button>
        )}
      />

      <main className="mx-auto min-w-0 max-w-md px-4 pt-2 lg:max-w-2xl">
        {/* Back sits at the top as navigation chrome, with the store on the same line, so
            a customer who arrives from a shared link knows where they are and how to
            leave without either fact needing a block of its own. */}
        <div className="flex items-center justify-between gap-3">
          <Link
            to={CUSTOMER_MY_ORDERS_PATH}
            className="cb-customer-back inline-flex min-h-11 shrink-0 items-center gap-1.5"
            aria-label="Back to Orders"
          >
            <ArrowLeft size={17} aria-hidden="true" />
            Orders
          </Link>
          {order && <p className="cb-customer-eyebrow min-w-0 truncate text-right">{order.storeName}</p>}
        </div>

        {copyMessage && (
          <p role="status" className="cb-customer-checkout-notice tone-info mt-2 break-all px-3 py-2 text-xs font-bold">
            {copyMessage}
          </p>
        )}

        {state.kind === 'loading' ? (
          <>
            <p className="sr-only" role="status" aria-live="polite">Loading order status</p>
            <div aria-hidden="true" className="mt-2">
              <div className="cb-customer-skeleton h-[168px] animate-pulse rounded-[28px] motion-reduce:animate-none" />
              <div className="cb-customer-skeleton mt-6 h-3.5 w-1/3 animate-pulse rounded-full motion-reduce:animate-none" />
              <div className="cb-customer-skeleton mt-4 h-[120px] animate-pulse rounded-[20px] motion-reduce:animate-none" />
            </div>
          </>
        ) : state.kind === 'error' ? (
          <div role="alert" className="cb-customer-checkout-notice tone-error mt-3 flex items-start gap-2 px-3 py-2.5 text-[12.5px] font-bold">
            <AlertCircle size={15} className="mt-px shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{state.message}</span>
          </div>
        ) : order ? (
          <>
            {/* One dominant status. Everything else on this page is quieter than it. */}
            <section className={`cb-customer-hero ${tone} mt-2 p-5`} aria-labelledby="cb-track-status">
              <p className="cb-customer-hero-eyebrow">
                {order.publicOrderNumber && !isEnded(order.publicStatus)
                  ? `Order #${order.publicOrderNumber}`
                  : 'Your order'}
              </p>
              <h1 id="cb-track-status" className="cb-customer-hero-status mt-2">
                {statusLabel(order.publicStatus)}
              </h1>
              <p className="cb-customer-hero-line mt-2.5">{statusMessage(order)}</p>
            </section>

            {/*
              Payment safety notices.
              The old page carried these inside a full "Online payment" panel. The panel
              is gone — the status hero already names the payment state — but NOT these
              two sentences: they tell the customer not to pay twice, which is a payment
              instruction, not decoration. Kept verbatim, directly under the status where
              they cannot be missed, and given the only accent edge on the page.
            */}
            {order.paymentProvider === 'RAZORPAY' && order.paymentStatus === 'PAYMENT_PROCESSING' && (
              <p role="status" className="cb-customer-payment-notice tone-info mt-3 flex items-start gap-2 px-3.5 py-3 text-[13px] font-bold">
                <AlertCircle size={16} className="mt-px shrink-0" aria-hidden="true" />
                <span className="min-w-0">Payment confirmation is in progress. Please do not pay again.</span>
              </p>
            )}
            {order.paymentProvider === 'RAZORPAY' && order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED' && (
              <p role="status" className="cb-customer-payment-notice tone-warning mt-3 flex items-start gap-2 px-3.5 py-3 text-[13px] font-bold">
                <AlertCircle size={16} className="mt-px shrink-0" aria-hidden="true" />
                <span className="min-w-0">Payment was received. The store is reviewing fulfilment; no further payment is required.</span>
              </p>
            )}

            {/* One compact progression on the page, not a panel of five equal boxes.
                Ended orders show no strip at all — there is no progress to make. */}
            {!isEnded(order.publicStatus) && (
              <ol className="cb-customer-steps mt-6" aria-label="Order progress">
                {STEPS.map((step, index) => {
                  const stepStatus = stepState(order.publicStatus, step.key);
                  return (
                    <li key={step.key} className="cb-customer-step">
                      <span className="cb-customer-step-track">
                        <span className={`cb-customer-step-rail ${index === 0 ? 'is-hidden' : stepStatus === 'pending' ? '' : 'is-filled'}`} />
                        <span className={`cb-customer-step-dot is-${stepStatus}`}>
                          {stepStatus === 'done' ? <Check size={12} aria-hidden="true" /> : null}
                        </span>
                        <span className={`cb-customer-step-rail ${index === STEPS.length - 1 ? 'is-hidden' : stepState(order.publicStatus, STEPS[index + 1].key) === 'pending' ? '' : 'is-filled'}`} />
                      </span>
                      <span className={`cb-customer-step-label is-${stepStatus}`}>
                        {step.label}
                        {/* State in words, never colour alone. */}
                        <span className="sr-only">{stepStatus === 'active' ? ' — current step' : stepStatus === 'done' ? ' — done' : ' — not yet'}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            {/* Flat summary: items, one hairline, totals. No card inside a card. */}
            <section className="mt-7" aria-labelledby="cb-track-summary">
              {/* The gap is carried by the heading, not by `mt-2` on the list: this app's
                    `.cb-customer-rows` reset lives in customer.css, which is UNLAYERED,
                    and unlayered declarations beat Tailwind's `@layer utilities` at any
                    specificity — so a margin utility on the list is silently dropped. */}
                <h2 id="cb-track-summary" className="cb-customer-eyebrow mb-2">Order summary</h2>

              <ul className="cb-customer-rows">
                {order.items.map(item => (
                  <li key={`${order.id}-${item.itemName}`} className="cb-customer-summary-item py-3">
                    <span className="min-w-0">
                      <span className="cb-customer-summary-name block">{item.quantity} × {item.itemName}</span>
                      {(item.addOns || []).map(addOn => (
                        <span key={`${addOn.groupName}-${addOn.optionName}`} className="cb-customer-summary-addon block">
                          + {addOn.optionName}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''}
                        </span>
                      ))}
                    </span>
                    <span className="cb-customer-summary-amount shrink-0">{formatMoney(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>

              <dl className="cb-customer-totals mt-3 space-y-2 pt-3">
                <div className="cb-customer-total-row">
                  <dt className="cb-customer-total-label">Subtotal</dt>
                  <dd className="cb-customer-total-value">{formatMoney(order.subtotal)}</dd>
                </div>
                <div className="cb-customer-total-row">
                  <dt className="cb-customer-total-label">GST</dt>
                  <dd className="cb-customer-total-value">{formatMoney(order.gstTotal)}</dd>
                </div>
                <div className="cb-customer-total-row is-grand pt-1">
                  <dt className="cb-customer-total-label">Total</dt>
                  <dd className="cb-customer-total-value">{formatMoney(order.total)}</dd>
                </div>
              </dl>

              <p className="cb-customer-meta mt-4 break-words">
                {order.orderType === 'DINE_IN' ? 'Dine-in' : 'Pickup'} · Submitted {formatDate(order.submittedAt)} · {order.publicOrderReference}
              </p>
            </section>

            {/* One way onward. Menu and Orders both live in the permanent navigation
                on the pages that own them, so neither is repeated as a big button. */}
            <Link
              to={CUSTOMER_MY_ORDERS_PATH}
              className="cb-customer-accent-button mt-7 flex min-h-13 w-full items-center justify-center rounded-2xl px-4 text-sm font-black"
            >
              Back to Orders
            </Link>
          </>
        ) : null}
      </main>

      {/* Tracking is reached from Orders, so the customer keeps the same bar and Orders
          stays lit. Without it, a live order was a dead end with no way back into the
          app except the browser's own back button. Presentational only — no tracking,
          subscription or payment behaviour is touched. */}
      <CustomerBottomNav />
    </div>
  );
}
