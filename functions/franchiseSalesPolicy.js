'use strict';

const FRANCHISE_ROLE = 'FRANCHISE_VIEWER';
const FRANCHISE_AUTH_DOMAIN = 'franchise.pos.coffeebond.in';
const FRANCHISE_TIME_ZONE = 'Asia/Kolkata';
const USERNAME_PATTERN = /^[a-z0-9._-]{4,40}$/;
const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'cashier',
  'manager',
  'store_manager',
  'system',
]);
const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'PAY_AT_COUNTER'];

function money(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizeFranchiseUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateFranchiseUsername(value) {
  const username = normalizeFranchiseUsername(value);
  if (!USERNAME_PATTERN.test(username)) {
    return {
      valid: false,
      username,
      reason: 'Username must be 4-40 characters using lowercase letters, numbers, dots, dashes, or underscores.',
    };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { valid: false, username, reason: 'This username is reserved.' };
  }
  return { valid: true, username, reason: null };
}

function franchiseAuthEmail(username) {
  const validation = validateFranchiseUsername(username);
  if (!validation.valid) throw new Error(validation.reason);
  return `${validation.username}@${FRANCHISE_AUTH_DOMAIN}`;
}

function assignedStoreIds(profile) {
  const source = Array.isArray(profile?.assignedStoreIds)
    ? profile.assignedStoreIds
    : Array.isArray(profile?.storeIds)
      ? profile.storeIds
      : [];
  return [...new Set(source.filter((storeId) => typeof storeId === 'string' && storeId.trim()))];
}

function canAccessRequestedStores(profile, requestedStoreIds) {
  if (!profile || profile.role !== FRANCHISE_ROLE || profile.isActive !== true) return false;
  if (profile.permissions?.viewDailySales !== true) return false;
  const allowed = new Set(assignedStoreIds(profile));
  return Array.isArray(requestedStoreIds)
    && requestedStoreIds.length > 0
    && requestedStoreIds.every((storeId) => allowed.has(storeId));
}

function isComplimentaryOrder(order) {
  if (order?.commercialStatus === 'COMPLIMENTARY') return true;
  if (order?.paymentMethod === 'COMPLIMENTARY') return true;
  return Array.isArray(order?.paymentBreakdown)
    && order.paymentBreakdown.some((payment) => payment?.method === 'COMPLIMENTARY');
}

function effectiveOrderStatus(order) {
  if (order?.status === 'VOIDED') return 'VOIDED';
  if (order?.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

function orderDiscount(order) {
  const discountAmount = money(order?.discountAmount);
  if (discountAmount > 0) return discountAmount;
  const discountTotal = money(order?.discountTotal);
  if (discountTotal > 0) return discountTotal;
  return money(order?.discount);
}

function orderTax(order) {
  const gst = money(order?.gstTotal);
  return gst > 0 ? gst : money(order?.taxTotal);
}

function orderTaxable(order) {
  if (Number.isFinite(Number(order?.taxableAmount))) return money(order.taxableAmount);
  return money(money(order?.subtotal) - orderDiscount(order));
}

function normalizedPaymentRows(order, paymentDocuments = []) {
  if (isComplimentaryOrder(order) || order?.paymentStatus !== 'PAID') return [];
  const source = Array.isArray(paymentDocuments) && paymentDocuments.length > 0
    ? paymentDocuments
    : Array.isArray(order?.paymentBreakdown) && order.paymentBreakdown.length > 0
      ? order.paymentBreakdown
      : [{ method: order?.paymentMethod, amount: order?.grandTotal }];

  return source
    .map((payment) => ({
      method: String(payment?.method || 'UNKNOWN').toUpperCase(),
      amount: money(payment?.amount),
    }))
    .filter((payment) => payment.amount > 0 && payment.method !== 'COMPLIMENTARY' && payment.method !== 'PAY_AT_COUNTER');
}

function dateFromValue(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maskIndianMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const national = digits.length >= 10 ? digits.slice(-10) : digits;
  if (national.length !== 10) return null;
  return `${national.slice(0, 2)}******${national.slice(-2)}`;
}

function paymentOutcome(order) {
  if (isComplimentaryOrder(order)) return effectiveOrderStatus(order) === 'VOIDED'
    ? 'VOIDED / NO PAYMENT'
    : 'NOT REQUIRED';
  if (effectiveOrderStatus(order) !== 'VOIDED') return order?.paymentStatus || 'UNPAID';
  const status = order?.paymentReversalStatus;
  if (status === 'REFUNDED') return 'VOIDED / CASH REFUNDED';
  if (status === 'REVERSED') return 'VOIDED / PAYMENT REVERSED';
  if (status === 'REFUND_PENDING') return 'VOIDED / REFUND PENDING';
  if (status === 'MANUAL_REFUND_REQUIRED') return 'VOIDED / MANUAL REFUND REQUIRED';
  return 'VOIDED / PAYMENT REVIEW';
}

function sourceLabel(order) {
  if (order?.source === 'CUSTOMER_WEB' || order?.onlineOrderId || order?.onlineOrderReference) {
    return 'CUSTOMER_WEB';
  }
  return 'POS';
}

function emptyPaymentBreakdown() {
  return PAYMENT_METHODS.reduce((summary, method) => {
    summary[method] = 0;
    return summary;
  }, {});
}

function roundSummaryValues(value) {
  if (Array.isArray(value)) return value.map(roundSummaryValues);
  if (!value || typeof value !== 'object') return typeof value === 'number' ? money(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    typeof nested === 'number' && !key.toLowerCase().includes('count') && key !== 'hour'
      ? money(nested)
      : roundSummaryValues(nested),
  ]));
}

function summarizeFranchiseDailySales(orderRecords, timeZone = FRANCHISE_TIME_ZONE) {
  const records = Array.isArray(orderRecords) ? orderRecords : [];
  const completedCommercial = records.filter(({ order }) => (
    effectiveOrderStatus(order) === 'COMPLETED' && !isComplimentaryOrder(order)
  ));
  const completedComplimentary = records.filter(({ order }) => (
    effectiveOrderStatus(order) === 'COMPLETED' && isComplimentaryOrder(order)
  ));
  const voided = records.filter(({ order }) => effectiveOrderStatus(order) === 'VOIDED');
  const commercialVoided = voided.filter(({ order }) => !isComplimentaryOrder(order));

  const paymentBreakdown = emptyPaymentBreakdown();
  let totalCollected = 0;
  let splitOrderCount = 0;
  for (const record of completedCommercial) {
    const rows = normalizedPaymentRows(record.order, record.payments);
    if (rows.length > 1) splitOrderCount += 1;
    for (const payment of rows) {
      if (Object.prototype.hasOwnProperty.call(paymentBreakdown, payment.method)) {
        paymentBreakdown[payment.method] += payment.amount;
      }
      totalCollected += payment.amount;
    }
  }

  const hourlyMap = new Map();
  const categoryMap = new Map();
  for (const record of completedCommercial) {
    const createdAt = dateFromValue(record.order.createdAt);
    if (createdAt) {
      const hour = Number(new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(createdAt));
      const current = hourlyMap.get(hour) || { hour, orderCount: 0, netSales: 0 };
      current.orderCount += 1;
      current.netSales += money(record.order.grandTotal);
      hourlyMap.set(hour, current);
    }

    for (const item of record.items || []) {
      const categoryName = String(item.categoryName || 'Other');
      const current = categoryMap.get(categoryName) || {
        categoryName,
        quantity: 0,
        netSales: 0,
        gst: 0,
      };
      current.quantity += Number(item.quantity || 0);
      current.netSales += money(item.lineTotal);
      current.gst += money(item.lineTax);
      categoryMap.set(categoryName, current);
    }
  }

  const netSales = completedCommercial.reduce((sum, { order }) => sum + money(order.grandTotal), 0);
  const grossPaymentsReceived = records.reduce((sum, record) => (
    sum + normalizedPaymentRows(record.order, record.payments).reduce((paymentSum, row) => paymentSum + row.amount, 0)
  ), 0);
  const voidedPaymentTotal = commercialVoided.reduce((sum, record) => {
    const explicit = money(record.order.paymentReversalTotal);
    return sum + (explicit > 0
      ? explicit
      : normalizedPaymentRows({ ...record.order, paymentStatus: 'PAID' }, record.payments)
        .reduce((paymentSum, row) => paymentSum + row.amount, 0));
  }, 0);

  const metrics = {
    grossMenuValue: completedCommercial.reduce((sum, { order }) => sum + money(order.subtotal), 0),
    discounts: completedCommercial.reduce((sum, { order }) => sum + orderDiscount(order), 0),
    netSales,
    taxableSales: completedCommercial.reduce((sum, { order }) => sum + orderTaxable(order), 0),
    gstCollected: completedCommercial.reduce((sum, { order }) => sum + orderTax(order), 0),
    totalCollected,
    paymentBreakdown,
    splitOrderCount,
    paidTransactionCount: completedCommercial.filter(({ order }) => order.paymentStatus === 'PAID').length,
    averageOrderValue: completedCommercial.length > 0 ? netSales / completedCommercial.length : 0,
    complimentaryOrderCount: completedComplimentary.length,
    complimentaryMenuValue: completedComplimentary.reduce((sum, { order }) => (
      sum + money(order.menuValue || order.subtotal)
    ), 0),
    complimentaryCogs: completedComplimentary.reduce((sum, { order }) => sum + money(order.cogsTotal), 0),
    voidOrderCount: voided.length,
    voidedOrderValue: commercialVoided.reduce((sum, { order }) => sum + money(order.grandTotal), 0),
    onlineSales: completedCommercial
      .filter(({ order }) => sourceLabel(order) === 'CUSTOMER_WEB')
      .reduce((sum, { order }) => sum + money(order.grandTotal), 0),
    posSales: completedCommercial
      .filter(({ order }) => sourceLabel(order) === 'POS')
      .reduce((sum, { order }) => sum + money(order.grandTotal), 0),
    grossPaymentsReceived,
    voidedPaymentTotal,
    netCollections: Math.max(0, grossPaymentsReceived - voidedPaymentTotal),
  };

  const orders = records
    .map((record) => {
      const order = record.order || {};
      const paidMethods = normalizedPaymentRows(
        { ...order, paymentStatus: 'PAID' },
        record.payments,
      ).map((payment) => payment.method);
      const paymentMethods = isComplimentaryOrder(order)
        ? []
        : paidMethods.length > 0
          ? [...new Set(paidMethods)]
          : order.paymentMethod && order.paymentMethod !== 'COMPLIMENTARY'
            ? [String(order.paymentMethod)]
            : [];
      return {
        orderNumber: String(order.orderNumber || 'Unknown order'),
        storeId: String(order.storeId || ''),
        storeName: String(order.storeName || ''),
        createdAt: dateFromValue(order.createdAt)?.toISOString() || null,
        orderType: String(order.orderType || 'TAKEAWAY'),
        source: sourceLabel(order),
        status: effectiveOrderStatus(order),
        paymentStatus: paymentOutcome(order),
        paymentMethods,
        customerPhoneMasked: maskIndianMobile(order.customerPhone),
        grossMenuValue: money(order.subtotal),
        discount: isComplimentaryOrder(order)
          ? money(order.complimentaryDiscount || order.subtotal)
          : orderDiscount(order),
        taxableAmount: isComplimentaryOrder(order) ? 0 : orderTaxable(order),
        gst: isComplimentaryOrder(order) ? 0 : orderTax(order),
        total: isComplimentaryOrder(order) ? 0 : money(order.grandTotal),
        complimentary: isComplimentaryOrder(order),
        items: (record.items || []).map((item) => ({
          name: String(item.itemName || 'Item'),
          quantity: Number(item.quantity || 0),
          categoryName: String(item.categoryName || 'Other'),
        })),
      };
    })
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));

  return roundSummaryValues({
    metrics,
    hourlySales: [...hourlyMap.values()].sort((left, right) => left.hour - right.hour),
    categorySales: [...categoryMap.values()].sort((left, right) => right.netSales - left.netSales),
    orders,
  });
}

module.exports = {
  FRANCHISE_ROLE,
  FRANCHISE_AUTH_DOMAIN,
  FRANCHISE_TIME_ZONE,
  PAYMENT_METHODS,
  RESERVED_USERNAMES,
  assignedStoreIds,
  canAccessRequestedStores,
  franchiseAuthEmail,
  maskIndianMobile,
  normalizeFranchiseUsername,
  summarizeFranchiseDailySales,
  validateFranchiseUsername,
};
