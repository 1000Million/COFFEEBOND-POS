'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');

const PROVIDER = 'RAZORPAY';
const CURRENCY = 'INR';
const MINIMUM_AMOUNT_PAISE = 100;
const MAX_PAYMENT_ATTEMPTS = 3;
const INTENT_TTL_MS = 30 * 60 * 1000;
const ACCEPTED_RAZORPAY_STATUS = 'ACCEPTED_AWAITING_PAYMENT';
const PAID_STATUS = 'PAID';
const REVIEW_STATUS = 'PAYMENT_REVIEW_REQUIRED';
const SAFE_PROVIDER_METHODS = new Set(['UPI', 'CARD', 'NETBANKING', 'WALLET']);
const RETRYABLE_INTENT_STATUSES = new Set(['FAILED']);

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function safeToken(value) {
  return cleanText(value, 200).replace(/[^A-Za-z0-9_-]/g, '');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function deterministicIntentId(onlineOrderId) {
  return `rzp_${sha256(onlineOrderId).slice(0, 40)}`;
}

function deterministicPosOrderId(onlineOrderId) {
  return `WEB_RZP_${safeToken(onlineOrderId).slice(0, 96)}`;
}

function deterministicLineId(onlineOrderId, index) {
  return `${deterministicPosOrderId(onlineOrderId)}_ITEM_${String(index + 1).padStart(2, '0')}`;
}

function deterministicReceipt(onlineOrderId) {
  return `CBRZP${sha256(onlineOrderId).slice(0, 24).toUpperCase()}`;
}

function rupeesToPaise(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('INVALID_PAYABLE_AMOUNT');
  }
  const scaled = value * 100;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-8) {
    throw new Error('INVALID_PAYABLE_PRECISION');
  }
  const paise = Math.round(scaled);
  if (paise < MINIMUM_AMOUNT_PAISE) throw new Error('PAYABLE_BELOW_PROVIDER_MINIMUM');
  return paise;
}

function isRazorpayOrderEligible(order, nowMs = Date.now()) {
  if (!order || order.source !== 'CUSTOMER_WEB') return false;
  if (order.paymentProvider !== PROVIDER || order.paymentMethod !== 'ONLINE') return false;
  if (order.status !== ACCEPTED_RAZORPAY_STATUS) return false;
  if (!['AWAITING_PAYMENT', 'NOT_STARTED', 'FAILED'].includes(order.paymentStatus)) return false;
  if (order.commercialStatus === 'COMPLIMENTARY' || order.paymentStatus === PAID_STATUS) return false;
  const expiresAtMs = typeof order.paymentExpiresAt?.toMillis === 'function'
    ? order.paymentExpiresAt.toMillis()
    : Date.parse(order.paymentExpiresAt || '');
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}

function intentCanBeReused(intent, expectedAmountPaise, nowMs = Date.now()) {
  if (!intent || intent.provider !== PROVIDER || intent.status !== 'CREATED') return false;
  if (intent.expectedAmountPaise !== expectedAmountPaise || intent.expectedCurrency !== CURRENCY) return false;
  const expiresAtMs = typeof intent.expiresAt?.toMillis === 'function'
    ? intent.expiresAt.toMillis()
    : Date.parse(intent.expiresAt || '');
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}

function intentCanRetry(intent) {
  return Boolean(
    intent
    && RETRYABLE_INTENT_STATUSES.has(intent.status)
    && Number(intent.attemptNumber || 0) < MAX_PAYMENT_ATTEMPTS,
  );
}

function verifyCheckoutSignature({ storedOrderId, paymentId, signature, keySecret }) {
  const safeStoredOrderId = cleanText(storedOrderId, 120);
  const safePaymentId = cleanText(paymentId, 120);
  const suppliedSignature = cleanText(signature, 256);
  if (!safeStoredOrderId || !safePaymentId || !suppliedSignature || !keySecret) return false;

  const expected = createHmac('sha256', keySecret)
    .update(`${safeStoredOrderId}|${safePaymentId}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(suppliedSignature, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!Buffer.isBuffer(rawBody) || !webhookSecret) return false;
  const suppliedSignature = cleanText(signature, 256);
  if (!suppliedSignature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(suppliedSignature, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function providerMethod(value) {
  const normalized = cleanText(value, 40).toUpperCase();
  return SAFE_PROVIDER_METHODS.has(normalized) ? normalized : 'OTHER';
}

function safeProviderError(error) {
  const statusCode = Number(error?.statusCode || error?.response?.status || 0);
  const providerCode = cleanText(error?.error?.code || error?.response?.data?.error?.code, 80);
  if (statusCode === 401 || statusCode === 403) {
    return { code: 'PROVIDER_AUTHENTICATION_FAILED', message: 'Online payment is temporarily unavailable.' };
  }
  if (statusCode === 429) {
    return { code: 'PROVIDER_RATE_LIMITED', message: 'Online payment is busy. Please try again shortly.' };
  }
  if (statusCode >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', message: 'Online payment is temporarily unavailable.' };
  }
  return {
    code: providerCode ? `PROVIDER_${providerCode}`.slice(0, 80) : 'PROVIDER_REQUEST_FAILED',
    message: 'Could not start online payment. Please try again.',
  };
}

function requestChecksum(order) {
  const items = Array.isArray(order?.items)
    ? order.items.map((item) => ({
      code: cleanText(item.finishedGoodCode, 80),
      quantity: Number(item.quantity || 0),
      lineTotal: Number(item.lineTotal || 0),
      addOns: (item.addOns || []).map((addOn) => ({
        groupId: cleanText(addOn.groupId, 80),
        optionId: cleanText(addOn.optionId, 80),
        quantity: Number(addOn.quantity || 0),
      })),
    }))
    : [];
  return sha256(JSON.stringify({
    storeId: cleanText(order?.storeId, 120),
    total: Number(order?.grandTotal),
    bondRedemptionPoints: Number(order?.bondRedemptionPoints || 0),
    bondRedemptionDiscount: Number(order?.bondRedemptionDiscount || 0),
    items,
  }));
}

function isFinalProviderState({ payment, providerOrder, expectedOrderId, expectedAmountPaise }) {
  if (!payment || !providerOrder) return { valid: false, code: 'PROVIDER_RECORD_MISSING' };
  if (payment.order_id !== expectedOrderId || providerOrder.id !== expectedOrderId) {
    return { valid: false, code: 'PROVIDER_ORDER_MISMATCH' };
  }
  if (Number(payment.amount) !== expectedAmountPaise || Number(providerOrder.amount) !== expectedAmountPaise) {
    return { valid: false, code: 'PROVIDER_AMOUNT_MISMATCH' };
  }
  if (String(payment.currency).toUpperCase() !== CURRENCY || String(providerOrder.currency).toUpperCase() !== CURRENCY) {
    return { valid: false, code: 'PROVIDER_CURRENCY_MISMATCH' };
  }
  if (payment.status !== 'captured') return { valid: false, code: 'PAYMENT_NOT_CAPTURED' };
  if (providerOrder.status !== 'paid') return { valid: false, code: 'PROVIDER_ORDER_NOT_PAID' };
  return { valid: true, code: null };
}

module.exports = {
  ACCEPTED_RAZORPAY_STATUS,
  CURRENCY,
  INTENT_TTL_MS,
  MAX_PAYMENT_ATTEMPTS,
  MINIMUM_AMOUNT_PAISE,
  PAID_STATUS,
  PROVIDER,
  REVIEW_STATUS,
  cleanText,
  deterministicIntentId,
  deterministicLineId,
  deterministicPosOrderId,
  deterministicReceipt,
  intentCanBeReused,
  intentCanRetry,
  isFinalProviderState,
  isRazorpayOrderEligible,
  providerMethod,
  requestChecksum,
  rupeesToPaise,
  safeProviderError,
  safeToken,
  sha256,
  verifyCheckoutSignature,
  verifyWebhookSignature,
};
