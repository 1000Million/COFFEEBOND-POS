'use strict';

const {
  FieldValue: ModularFieldValue,
  Timestamp: ModularTimestamp,
} = require('firebase-admin/firestore');
const { resolveLoyaltyFlags } = require('./bondLoyaltyPolicy');
const {
  BOND_REDEMPTION_POLICY,
  BondRedemptionPolicyError,
  applyBondRedemptionToCheckout,
  rupeesToPaise,
  validateBondRedemptionRequest,
} = require('./bondRedemptionPolicy');

const FLAGS_DOCUMENT = 'appSettings/loyalty';
const ACCOUNTS = 'loyaltyAccounts';
const RESERVATIONS = 'loyaltyRedemptionReservations';
const POINT_LEDGER = 'loyaltyPointLedger';
const CHECKOUT_SESSIONS = 'customerCheckoutSessions';

class BondRedemptionServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BondRedemptionServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function serviceError(code, message, details) {
  throw new BondRedemptionServiceError(code, message, details);
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function safeDocumentId(...parts) {
  return parts
    .map(part => cleanText(part, 500).replace(/[^A-Za-z0-9_-]/g, '_'))
    .filter(Boolean)
    .join('__')
    .slice(0, 1400);
}

function redemptionReservationId(sessionId) {
  return safeDocumentId('BOND_REDEMPTION', sessionId);
}

function redemptionLedgerId(sessionId) {
  return safeDocumentId(
    'POINT_REDEMPTION',
    sessionId,
    BOND_REDEMPTION_POLICY.policyVersion,
  );
}

function redemptionRestoreLedgerId(sessionId) {
  return safeDocumentId(
    'POINT_REDEMPTION_RESTORE',
    sessionId,
    BOND_REDEMPTION_POLICY.policyVersion,
  );
}

function finiteInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function signedInteger(value, field, fallback = 0) {
  const parsed = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    serviceError('INVALID_REDEMPTION_STATE', `${field} must be a safe integer.`, { field });
  }
  return parsed;
}

function nonNegativeInteger(value, field, fallback = 0) {
  const parsed = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    serviceError('INVALID_REDEMPTION_STATE', `${field} must be a non-negative integer.`, { field });
  }
  return parsed;
}

function requiredText(value, field, maxLength = 500) {
  const text = cleanText(value, maxLength);
  if (!text) serviceError('INVALID_REDEMPTION_REQUEST', `${field} is required.`, { field });
  return text;
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reservationIsExpired(reservation, now = Date.now()) {
  const expiryMillis = timestampMillis(reservation?.expiresAt);
  return expiryMillis > 0 && expiryMillis <= now;
}

function firestoreTypes(admin) {
  return {
    FieldValue: admin?.firestore?.FieldValue || ModularFieldValue,
    Timestamp: admin?.firestore?.Timestamp || ModularTimestamp,
  };
}

function asTimestamp(admin, value, field = 'timestamp', fallbackMillis = Date.now()) {
  if (typeof value?.toMillis === 'function') return value;
  const millis = timestampMillis(value) || fallbackMillis;
  if (!Number.isFinite(millis) || millis <= 0) {
    serviceError('INVALID_REDEMPTION_REQUEST', `${field} must be a valid timestamp.`, { field });
  }
  return firestoreTypes(admin).Timestamp.fromMillis(millis);
}

function canonicalRequestedPoints(canonical) {
  return nonNegativeInteger(
    canonical?.bondRedemptionPoints ?? canonical?.bondRedemption?.points ?? 0,
    'canonical.bondRedemptionPoints',
  );
}

function canonicalChannel(canonical) {
  const explicit = cleanText(
    canonical?.source || canonical?.channel || canonical?.orderSource || '',
    80,
  ).toUpperCase();
  return explicit || BOND_REDEMPTION_POLICY.eligibleChannel;
}

function canonicalMoneyPaise(canonical, fields, fallback = null) {
  for (const field of fields) {
    if (canonical?.[field] !== undefined && canonical?.[field] !== null) {
      return rupeesToPaise(canonical[field], `canonical.${field}`);
    }
  }
  return fallback;
}

function canonicalRedemptionDiscountPaise(canonical) {
  if (canonical?.bondRedemption?.discountPaise !== undefined) {
    return nonNegativeInteger(
      canonical.bondRedemption.discountPaise,
      'canonical.bondRedemption.discountPaise',
    );
  }
  return canonicalMoneyPaise(canonical, ['bondRedemptionDiscount'], 0);
}

function stripBondDiscount(canonical) {
  return {
    ...canonical,
    discount: 0,
    discountAmount: 0,
    discountTotal: 0,
    discountReason: null,
    discountSource: null,
    bondRedemptionPoints: 0,
    bondRedemptionDiscount: 0,
    pointFundedAmount: 0,
    bondRedemption: null,
  };
}

function assertCanonicalMatchesRedemption({ canonical, requestedPoints, availablePoints, flags }) {
  if (!canonical || typeof canonical !== 'object' || !Array.isArray(canonical.items)) {
    serviceError('INVALID_REDEMPTION_REQUEST', 'A server-canonical checkout is required.');
  }
  const channel = canonicalChannel(canonical);
  if (channel !== BOND_REDEMPTION_POLICY.eligibleChannel) {
    serviceError(
      'REDEMPTION_CHANNEL_INELIGIBLE',
      'BOND points redemption is available only for customer ordering.',
      { channel },
    );
  }
  if (flags.customerOrderingOnly !== true) {
    serviceError(
      'REDEMPTION_CHANNEL_INELIGIBLE',
      'BOND redemption is restricted to customer ordering.',
    );
  }

  const discountSource = cleanText(canonical.discountSource, 80).toUpperCase();
  const discountReason = cleanText(canonical.discountReason, 200);
  const canonicalDiscountPaise = canonicalMoneyPaise(
    canonical,
    ['discountAmount', 'discountTotal', 'discount'],
    0,
  );
  const expectedDiscountPaise = requestedPoints * BOND_REDEMPTION_POLICY.pointValuePaise;
  if (requestedPoints > 0) {
    if (discountSource !== 'BOND_REDEMPTION'
      || discountReason !== BOND_REDEMPTION_POLICY.label
      || canonicalDiscountPaise !== expectedDiscountPaise
      || canonicalRedemptionDiscountPaise(canonical) !== expectedDiscountPaise) {
      serviceError(
        'CANONICAL_REDEMPTION_MISMATCH',
        'The canonical BOND redemption fields do not match the requested points.',
      );
    }
  } else if (canonicalDiscountPaise > 0) {
    serviceError(
      'REDEMPTION_WITH_DISCOUNT_NOT_ALLOWED',
      'BOND points redemption cannot be combined with another discount.',
    );
  }

  const repriced = applyBondRedemptionToCheckout({
    checkout: stripBondDiscount(canonical),
    requestedPoints,
    pointsBalance: availablePoints,
    availablePoints,
    redemptionEnabled: flags.accountEnabled === true && flags.redemptionEnabled === true,
    channel,
  });
  const comparisons = [
    ['subtotal', repriced.subtotal],
    ['discountAmount', repriced.discountAmount],
    ['taxableAmount', repriced.taxableAmount],
    ['gstTotal', repriced.gstTotal],
    ['grandTotal', repriced.grandTotal],
  ];
  for (const [field, expected] of comparisons) {
    const actualPaise = canonicalMoneyPaise(canonical, [field], null);
    if (actualPaise === null || actualPaise !== rupeesToPaise(expected, `expected.${field}`)) {
      serviceError(
        'CANONICAL_REDEMPTION_MISMATCH',
        `The canonical ${field} does not match the server redemption calculation.`,
        { field },
      );
    }
  }
  return repriced;
}

function quoteResponse({
  canonical,
  flags,
  pointsBalance,
  reservedPoints,
  ownReservedPoints,
  availablePoints,
}) {
  const redemption = canonical.bondRedemption || {};
  const requestedPoints = finiteInteger(redemption.points, 0);
  return Object.freeze({
    enabled: flags.accountEnabled === true && flags.redemptionEnabled === true,
    customerOrderingOnly: flags.customerOrderingOnly === true,
    policyVersion: BOND_REDEMPTION_POLICY.policyVersion,
    discountLabel: BOND_REDEMPTION_POLICY.label,
    policy: Object.freeze({
      label: BOND_REDEMPTION_POLICY.label,
      minimumPoints: BOND_REDEMPTION_POLICY.minimumPoints,
      incrementPoints: BOND_REDEMPTION_POLICY.incrementPoints,
      pointValuePaise: BOND_REDEMPTION_POLICY.pointValuePaise,
      maximumPercent: BOND_REDEMPTION_POLICY.maximumEligibleSubtotalBasisPoints / 100,
    }),
    minimumPoints: BOND_REDEMPTION_POLICY.minimumPoints,
    incrementPoints: BOND_REDEMPTION_POLICY.incrementPoints,
    pointValuePaise: BOND_REDEMPTION_POLICY.pointValuePaise,
    pointsBalance,
    reservedPoints,
    ownReservedPoints,
    availablePoints,
    maximumUsablePoints: finiteInteger(redemption.maximumUsablePoints, 0),
    requestedPoints,
    selectedPoints: requestedPoints,
    discountPaise: finiteInteger(redemption.discountPaise, 0),
    discount: Number(redemption.discount || 0),
    subtotal: Number(canonical.subtotal || 0),
    taxableAmount: Number(canonical.taxableAmount || 0),
    gstTotal: Number(canonical.gstTotal || 0),
    grandTotal: Number(canonical.grandTotal || 0),
    canonical,
  });
}

function createBondRedemptionService({ admin, db, logger = console }) {
  if (!db) throw new Error('Firestore is required for BOND redemption.');
  const { FieldValue } = firestoreTypes(admin);
  const flagsRef = db.doc(FLAGS_DOCUMENT);

  async function getFlags() {
    const snapshot = await flagsRef.get();
    return resolveLoyaltyFlags(snapshot.exists ? snapshot.data() : {});
  }

  async function quote({ customerId, canonical, requestedPoints = 0, sessionId } = {}) {
    const normalizedCustomerId = requiredText(customerId, 'customerId', 128);
    const selectedPoints = nonNegativeInteger(requestedPoints, 'requestedPoints');
    const normalizedSessionId = cleanText(sessionId, 500);
    const ownReservationRef = normalizedSessionId
      ? db.collection(RESERVATIONS).doc(redemptionReservationId(normalizedSessionId))
      : null;
    const [flags, accountSnapshot, ownReservationSnapshot] = await Promise.all([
      getFlags(),
      db.collection(ACCOUNTS).doc(normalizedCustomerId).get(),
      ownReservationRef ? ownReservationRef.get() : Promise.resolve(null),
    ]);
    const account = accountSnapshot.exists ? accountSnapshot.data() : {};
    const pointsBalance = signedInteger(account.pointsBalance, 'account.pointsBalance');
    const reservedPoints = nonNegativeInteger(
      account.reservedRedemptionPoints,
      'account.reservedRedemptionPoints',
    );
    const ownReservation = ownReservationSnapshot?.exists ? ownReservationSnapshot.data() : null;
    const ownReservedPoints = ownReservation?.status === 'ACTIVE'
      && cleanText(ownReservation.customerId, 128) === normalizedCustomerId
      && cleanText(ownReservation.checkoutSessionId, 500) === normalizedSessionId
      ? nonNegativeInteger(ownReservation.points, 'reservation.points')
      : 0;
    const availablePoints = Math.max(0, pointsBalance - reservedPoints + ownReservedPoints);
    if (canonicalChannel(canonical) !== BOND_REDEMPTION_POLICY.eligibleChannel) {
      serviceError(
        'REDEMPTION_CHANNEL_INELIGIBLE',
        'BOND points redemption is available only for customer ordering.',
      );
    }
    const priced = applyBondRedemptionToCheckout({
      checkout: canonical,
      requestedPoints: selectedPoints,
      pointsBalance,
      availablePoints,
      redemptionEnabled: flags.accountEnabled === true && flags.redemptionEnabled === true
        && flags.customerOrderingOnly === true,
      channel: BOND_REDEMPTION_POLICY.eligibleChannel,
    });
    return quoteResponse({
      canonical: priced,
      flags,
      pointsBalance,
      reservedPoints,
      ownReservedPoints,
      availablePoints,
    });
  }

  async function reserveInTransaction({
    transaction,
    customerId,
    sessionId,
    canonical,
    expiresAt,
    requestChecksum,
  } = {}) {
    if (!transaction) serviceError('INVALID_REDEMPTION_REQUEST', 'A Firestore transaction is required.');
    const normalizedCustomerId = requiredText(customerId, 'customerId', 128);
    const normalizedSessionId = requiredText(sessionId, 'sessionId', 500);
    const checksum = requiredText(requestChecksum, 'requestChecksum', 256);
    const requestedPoints = canonicalRequestedPoints(canonical);
    if (requestedPoints === 0) {
      return { status: 'NO_REDEMPTION', writes: 0, reservationId: null, points: 0 };
    }
    const expiry = asTimestamp(admin, expiresAt, 'expiresAt');
    const accountRef = db.collection(ACCOUNTS).doc(normalizedCustomerId);
    const reservationRef = db.collection(RESERVATIONS).doc(redemptionReservationId(normalizedSessionId));
    const [flagsSnapshot, accountSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(flagsRef),
      transaction.get(accountRef),
      transaction.get(reservationRef),
    ]);
    const flags = resolveLoyaltyFlags(flagsSnapshot.exists ? flagsSnapshot.data() : {});
    if (!flags.accountEnabled || !flags.redemptionEnabled || !flags.customerOrderingOnly) {
      serviceError('REDEMPTION_DISABLED', 'BOND points redemption is not enabled.');
    }
    if (!accountSnapshot.exists) {
      serviceError('INSUFFICIENT_POINTS', 'The available BOND points balance is insufficient.');
    }
    const account = accountSnapshot.data();
    const pointsBalance = signedInteger(account.pointsBalance, 'account.pointsBalance');
    const reservedPoints = nonNegativeInteger(
      account.reservedRedemptionPoints,
      'account.reservedRedemptionPoints',
    );
    const existing = reservationSnapshot.exists ? reservationSnapshot.data() : null;
    const expiredActiveReservation = existing?.status === 'ACTIVE'
      && reservationIsExpired(existing);
    let effectiveReservedPoints = reservedPoints;
    if (expiredActiveReservation) {
      const expiredPoints = nonNegativeInteger(existing.points, 'reservation.points');
      if (effectiveReservedPoints < expiredPoints) {
        serviceError('INVALID_REDEMPTION_STATE', 'The expired BOND reservation projection is inconsistent.');
      }
      effectiveReservedPoints -= expiredPoints;
    }
    if (existing) {
      if (cleanText(existing.customerId, 128) !== normalizedCustomerId
        || cleanText(existing.checkoutSessionId, 500) !== normalizedSessionId) {
        serviceError('RESERVATION_CONFLICT', 'The checkout reservation belongs to another customer.');
      }
      if (existing.status === 'ACTIVE' && !expiredActiveReservation) {
        if (cleanText(existing.requestChecksum, 256) !== checksum
          || finiteInteger(existing.points, -1) !== requestedPoints) {
          serviceError('RESERVATION_CONFLICT', 'The checkout reservation payload has changed.');
        }
        const availableIncludingThisReservation = Math.max(
          0,
          pointsBalance - reservedPoints + requestedPoints,
        );
        assertCanonicalMatchesRedemption({
          canonical,
          requestedPoints,
          availablePoints: availableIncludingThisReservation,
          flags,
        });
        return {
          status: 'ALREADY_RESERVED',
          writes: 0,
          reservationId: reservationRef.id,
          points: requestedPoints,
          discountPaise: finiteInteger(existing.discountPaise, 0),
        };
      }
      if (['REDEEMED', 'RESTORED'].includes(existing.status)) {
        return {
          status: existing.status === 'RESTORED' ? 'ALREADY_RESTORED' : 'ALREADY_REDEEMED',
          writes: 0,
          reservationId: reservationRef.id,
          points: finiteInteger(existing.points, 0),
          discountPaise: finiteInteger(existing.discountPaise, 0),
        };
      }
      if (existing.status !== 'RELEASED' && !expiredActiveReservation) {
        serviceError('RESERVATION_CONFLICT', 'The checkout reservation has an invalid state.');
      }
    }

    const availablePoints = Math.max(0, pointsBalance - effectiveReservedPoints);
    const repriced = assertCanonicalMatchesRedemption({
      canonical,
      requestedPoints,
      availablePoints,
      flags,
    });
    const validation = validateBondRedemptionRequest({
      requestedPoints,
      availablePoints,
      eligibleSubtotalPaise: rupeesToPaise(canonical.subtotal, 'canonical.subtotal'),
      existingDiscountPaise: 0,
      redemptionEnabled: true,
      channel: BOND_REDEMPTION_POLICY.eligibleChannel,
    });

    transaction.set(accountRef, {
      reservedRedemptionPoints: effectiveReservedPoints + requestedPoints,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const reservationWrite = {
      reservationId: reservationRef.id,
      checkoutSessionId: normalizedSessionId,
      customerId: normalizedCustomerId,
      status: 'ACTIVE',
      points: requestedPoints,
      discountPaise: validation.discountPaise,
      eligibleSubtotalPaise: validation.eligibleSubtotalPaise,
      maximumUsablePointsAtReservation: validation.maximumUsablePoints,
      accountBalanceAtReservation: pointsBalance,
      availablePointsBeforeReservation: availablePoints,
      sourceChannel: 'CUSTOMER_ORDERING',
      requestChecksum: checksum,
      policyVersion: BOND_REDEMPTION_POLICY.policyVersion,
      label: BOND_REDEMPTION_POLICY.label,
      canonicalTaxableAmountPaise: rupeesToPaise(repriced.taxableAmount, 'canonical.taxableAmount'),
      canonicalGstTotalPaise: rupeesToPaise(repriced.gstTotal, 'canonical.gstTotal'),
      canonicalGrandTotalPaise: rupeesToPaise(repriced.grandTotal, 'canonical.grandTotal'),
      expiresAt: expiry,
      updatedAt: FieldValue.serverTimestamp(),
      reservationAttempt: (existing ? finiteInteger(existing.reservationAttempt, 0) : 0) + 1,
    };
    reservationWrite.createdAt = reservationSnapshot.exists
      ? existing.createdAt || FieldValue.serverTimestamp()
      : FieldValue.serverTimestamp();
    if (existing?.status === 'RELEASED' || expiredActiveReservation) {
      reservationWrite.previousReleaseReason = expiredActiveReservation
        ? 'RESERVATION_EXPIRED'
        : cleanText(existing.releaseReason, 200) || null;
      reservationWrite.reactivatedAt = FieldValue.serverTimestamp();
    }
    transaction.set(reservationRef, reservationWrite, { merge: false });
    return {
      status: 'RESERVED',
      writes: 2,
      reservationId: reservationRef.id,
      points: requestedPoints,
      discountPaise: validation.discountPaise,
      expiresAt: expiry,
    };
  }

  async function settleInTransaction({
    transaction,
    customerId,
    sessionId,
    onlineOrderId,
    canonical,
  } = {}) {
    if (!transaction) serviceError('INVALID_REDEMPTION_REQUEST', 'A Firestore transaction is required.');
    const normalizedCustomerId = requiredText(customerId, 'customerId', 128);
    const normalizedSessionId = requiredText(sessionId, 'sessionId', 500);
    const normalizedOnlineOrderId = requiredText(onlineOrderId, 'onlineOrderId', 500);
    const reservationRef = db.collection(RESERVATIONS).doc(redemptionReservationId(normalizedSessionId));
    const redemptionRef = db.collection(POINT_LEDGER).doc(redemptionLedgerId(normalizedSessionId));
    const [reservationSnapshot, redemptionSnapshot] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(redemptionRef),
    ]);
    if (!reservationSnapshot.exists) {
      if (canonicalRequestedPoints(canonical) === 0) {
        return { status: 'NO_REDEMPTION', writes: 0, points: 0, ledgerEntryId: null };
      }
      serviceError('REDEMPTION_RESERVATION_NOT_FOUND', 'The BOND reservation was not found.');
    }
    const reservation = reservationSnapshot.data();
    if (cleanText(reservation.customerId, 128) !== normalizedCustomerId) {
      serviceError('REDEMPTION_CUSTOMER_MISMATCH', 'The BOND reservation belongs to another customer.');
    }
    const points = nonNegativeInteger(reservation.points, 'reservation.points');
    const discountPaise = nonNegativeInteger(reservation.discountPaise, 'reservation.discountPaise');
    const reservationOnlineOrderId = cleanText(reservation.onlineOrderId, 500);
    const assertPaidCanonical = () => {
      if (!canonical) return;
      const comparisons = [
        [canonicalRequestedPoints(canonical), points],
        [canonicalRedemptionDiscountPaise(canonical), discountPaise],
        [canonicalMoneyPaise(canonical, ['subtotal'], -1), finiteInteger(reservation.eligibleSubtotalPaise, -2)],
        [canonicalMoneyPaise(canonical, ['taxableAmount'], -1), finiteInteger(reservation.canonicalTaxableAmountPaise, -2)],
        [canonicalMoneyPaise(canonical, ['gstTotal'], -1), finiteInteger(reservation.canonicalGstTotalPaise, -2)],
        [canonicalMoneyPaise(canonical, ['grandTotal'], -1), finiteInteger(reservation.canonicalGrandTotalPaise, -2)],
      ];
      if (comparisons.some(([actual, expected]) => actual !== expected)) {
        serviceError(
          'CANONICAL_REDEMPTION_MISMATCH',
          'The paid checkout does not match every BOND reservation total.',
        );
      }
    };
    if (redemptionSnapshot.exists) {
      const redemption = redemptionSnapshot.data();
      if (cleanText(redemption?.customerId, 128) !== normalizedCustomerId
        || cleanText(redemption?.sourceCheckoutSessionId, 500) !== normalizedSessionId
        || cleanText(redemption?.sourceOnlineOrderId, 500) !== normalizedOnlineOrderId
        || reservationOnlineOrderId !== normalizedOnlineOrderId
        || finiteInteger(redemption?.pointsDelta, 0) !== -points) {
        serviceError('REDEMPTION_LEDGER_CONFLICT', 'The BOND redemption ledger is inconsistent.');
      }
      assertPaidCanonical();
      return {
        status: reservation.status === 'RESTORED' ? 'ALREADY_RESTORED' : 'ALREADY_REDEEMED',
        writes: 0,
        points: finiteInteger(reservation.points, 0),
        ledgerEntryId: redemptionRef.id,
      };
    }
    if (reservation.status !== 'ACTIVE') {
      serviceError(
        'REDEMPTION_RESERVATION_NOT_ACTIVE',
        'The BOND reservation is no longer active.',
        { status: cleanText(reservation.status, 40) },
      );
    }
    if (points <= 0) serviceError('INVALID_REDEMPTION_STATE', 'The reservation has no points.');
    assertPaidCanonical();
    const accountRef = db.collection(ACCOUNTS).doc(normalizedCustomerId);
    const accountSnapshot = await transaction.get(accountRef);
    if (!accountSnapshot.exists) serviceError('INVALID_REDEMPTION_STATE', 'The BOND account was not found.');
    const account = accountSnapshot.data();
    const pointsBalance = signedInteger(account.pointsBalance, 'account.pointsBalance');
    const reservedPoints = nonNegativeInteger(
      account.reservedRedemptionPoints,
      'account.reservedRedemptionPoints',
    );
    if (reservedPoints < points) {
      serviceError('INVALID_REDEMPTION_STATE', 'The BOND account cannot settle this reservation.');
    }
    transaction.create(redemptionRef, {
      ledgerEntryId: redemptionRef.id,
      customerId: normalizedCustomerId,
      eventType: 'POINT_REDEMPTION',
      pointsDelta: -points,
      redemptionValuePaise: discountPaise,
      eligibleSpendPaise: nonNegativeInteger(
        reservation.eligibleSubtotalPaise,
        'reservation.eligibleSubtotalPaise',
      ),
      sourceCheckoutSessionId: normalizedSessionId,
      sourceOnlineOrderId: normalizedOnlineOrderId,
      sourceOrderId: null,
      orderChannel: 'CUSTOMER_ORDERING',
      policyVersion: BOND_REDEMPTION_POLICY.policyVersion,
      idempotencyKey: redemptionRef.id,
      occurredAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(accountRef, {
      pointsBalance: pointsBalance - points,
      reservedRedemptionPoints: reservedPoints - points,
      lifetimePointsRedeemed: nonNegativeInteger(
        account.lifetimePointsRedeemed,
        'account.lifetimePointsRedeemed',
      ) + points,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(reservationRef, {
      status: 'REDEEMED',
      onlineOrderId: normalizedOnlineOrderId,
      redemptionLedgerEntryId: redemptionRef.id,
      redeemedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      status: 'REDEEMED',
      writes: 3,
      points,
      discountPaise,
      ledgerEntryId: redemptionRef.id,
    };
  }

  async function releaseReservation({
    customerId,
    sessionId,
    reason,
    now,
    terminalSessionStatus,
    allowedSessionStatuses,
  } = {}) {
    const normalizedSessionId = requiredText(sessionId, 'sessionId', 500);
    const normalizedCustomerId = cleanText(customerId, 128);
    const releaseReason = requiredText(reason, 'reason', 200);
    const releasedAt = asTimestamp(admin, now, 'now');
    const reservationRef = db.collection(RESERVATIONS).doc(redemptionReservationId(normalizedSessionId));
    const checkoutRef = terminalSessionStatus
      ? db.collection(CHECKOUT_SESSIONS).doc(normalizedSessionId)
      : null;
    const allowedStatuses = Array.isArray(allowedSessionStatuses)
      ? new Set(allowedSessionStatuses.map(status => cleanText(status, 80)).filter(Boolean))
      : null;
    return db.runTransaction(async transaction => {
      const [reservationSnapshot, checkoutSnapshot] = await Promise.all([
        transaction.get(reservationRef),
        checkoutRef ? transaction.get(checkoutRef) : Promise.resolve(null),
      ]);
      if (!reservationSnapshot.exists) {
        const checkout = checkoutSnapshot?.exists ? checkoutSnapshot.data() : null;
        if (!checkout || !checkoutRef) {
          return { status: 'NO_RESERVATION', writes: 0, points: 0 };
        }
        if (normalizedCustomerId && cleanText(checkout.customerUid, 128) !== normalizedCustomerId) {
          serviceError('REDEMPTION_CUSTOMER_MISMATCH', 'The checkout belongs to another customer.');
        }
        const currentStatus = cleanText(checkout.status, 80);
        if (['PAYMENT_CAPTURED', 'ORDER_CREATED', 'REFUND_PENDING', 'REFUNDED'].includes(currentStatus)
          || (currentStatus === 'PAYMENT_REVIEW_REQUIRED' && checkout.paymentCapturedAt)) {
          return { status: 'PAYMENT_ALREADY_FINAL', writes: 0, points: 0 };
        }
        if (allowedStatuses && !allowedStatuses.has(currentStatus)) {
          return {
            status: 'SESSION_STATE_CHANGED',
            sessionStatus: currentStatus,
            writes: 0,
            points: 0,
          };
        }
        transaction.set(checkoutRef, {
          status: cleanText(terminalSessionStatus, 80),
          bondRedemptionStatus: 'NOT_REQUESTED',
          redemptionReleaseReason: releaseReason,
          redemptionReleasedAt: releasedAt,
          ...(terminalSessionStatus === 'CANCELLED' ? { cancelledAt: releasedAt } : {}),
          ...(terminalSessionStatus === 'EXPIRED' ? { expiredAt: releasedAt } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { status: 'NO_RESERVATION', writes: 1, points: 0 };
      }
      const reservation = reservationSnapshot.data();
      const reservationCustomerId = requiredText(reservation.customerId, 'reservation.customerId', 128);
      if (normalizedCustomerId && reservationCustomerId !== normalizedCustomerId) {
        serviceError('REDEMPTION_CUSTOMER_MISMATCH', 'The BOND reservation belongs to another customer.');
      }
      const checkout = checkoutSnapshot?.exists ? checkoutSnapshot.data() : null;
      if (checkout) {
        if (cleanText(checkout.customerUid, 128) !== reservationCustomerId) {
          serviceError('REDEMPTION_CUSTOMER_MISMATCH', 'The checkout belongs to another customer.');
        }
        const currentStatus = cleanText(checkout.status, 80);
        if (['PAYMENT_CAPTURED', 'ORDER_CREATED', 'REFUND_PENDING', 'REFUNDED'].includes(currentStatus)
          || (currentStatus === 'PAYMENT_REVIEW_REQUIRED' && checkout.paymentCapturedAt)) {
          return {
            status: 'PAYMENT_ALREADY_FINAL',
            writes: 0,
            points: finiteInteger(reservation.points, 0),
          };
        }
        if (allowedStatuses && !allowedStatuses.has(currentStatus)) {
          return {
            status: 'SESSION_STATE_CHANGED',
            sessionStatus: currentStatus,
            writes: 0,
            points: finiteInteger(reservation.points, 0),
          };
        }
      }
      if (reservation.status !== 'ACTIVE') {
        return {
          status: reservation.status === 'REDEEMED' || reservation.status === 'RESTORED'
            ? 'ALREADY_REDEEMED'
            : 'ALREADY_RELEASED',
          writes: 0,
          points: finiteInteger(reservation.points, 0),
        };
      }
      const accountRef = db.collection(ACCOUNTS).doc(reservationCustomerId);
      const accountSnapshot = await transaction.get(accountRef);
      if (!accountSnapshot.exists) serviceError('INVALID_REDEMPTION_STATE', 'The BOND account was not found.');
      const account = accountSnapshot.data();
      const points = nonNegativeInteger(reservation.points, 'reservation.points');
      const reservedPoints = nonNegativeInteger(
        account.reservedRedemptionPoints,
        'account.reservedRedemptionPoints',
      );
      if (reservedPoints < points) {
        serviceError('INVALID_REDEMPTION_STATE', 'The reserved BOND projection is inconsistent.');
      }
      transaction.set(accountRef, {
        reservedRedemptionPoints: reservedPoints - points,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(reservationRef, {
        status: 'RELEASED',
        releaseReason,
        releasedAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (checkoutRef && checkoutSnapshot?.exists) {
        transaction.set(checkoutRef, {
          status: cleanText(terminalSessionStatus, 80),
          bondRedemptionStatus: 'RELEASED',
          redemptionReleaseReason: releaseReason,
          redemptionReleasedAt: releasedAt,
          ...(terminalSessionStatus === 'CANCELLED' ? { cancelledAt: releasedAt } : {}),
          ...(terminalSessionStatus === 'EXPIRED' ? { expiredAt: releasedAt } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return {
        status: 'RELEASED',
        writes: checkoutRef && checkoutSnapshot?.exists ? 3 : 2,
        points,
      };
    });
  }

  async function restoreInTransaction({
    transaction,
    sessionId,
    onlineOrderId,
    sourceOrderId,
    reason,
  } = {}) {
    if (!transaction) serviceError('INVALID_REDEMPTION_REQUEST', 'A Firestore transaction is required.');
    const normalizedSessionId = requiredText(sessionId, 'sessionId', 500);
    const normalizedOnlineOrderId = cleanText(onlineOrderId, 500);
    const normalizedSourceOrderId = cleanText(sourceOrderId, 500) || null;
    const restoreReason = requiredText(reason, 'reason', 200);
    const reservationRef = db.collection(RESERVATIONS).doc(redemptionReservationId(normalizedSessionId));
    const restoreRef = db.collection(POINT_LEDGER).doc(redemptionRestoreLedgerId(normalizedSessionId));
    const redemptionRef = db.collection(POINT_LEDGER).doc(redemptionLedgerId(normalizedSessionId));
    const [reservationSnapshot, restoreSnapshot, redemptionSnapshot] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(restoreRef),
      transaction.get(redemptionRef),
    ]);
    if (!reservationSnapshot.exists) return { status: 'NO_REDEMPTION', writes: 0, points: 0 };
    const reservation = reservationSnapshot.data();
    if (restoreSnapshot.exists) {
      return {
        status: 'ALREADY_RESTORED',
        writes: 0,
        points: finiteInteger(reservation.points, 0),
        ledgerEntryId: restoreRef.id,
      };
    }
    if (!redemptionSnapshot.exists || reservation.status !== 'REDEEMED') {
      if (reservation.status === 'RESTORED') {
        serviceError('REDEMPTION_LEDGER_CONFLICT', 'The restored BOND ledger is missing.');
      }
      if (reservation.status === 'ACTIVE') {
        serviceError(
          'REDEMPTION_NOT_SETTLED',
          'An active reservation must be released rather than restored.',
        );
      }
      return { status: 'NOT_REDEEMED', writes: 0, points: 0 };
    }
    const reservationOnlineOrderId = cleanText(reservation.onlineOrderId, 500);
    if (normalizedOnlineOrderId && reservationOnlineOrderId !== normalizedOnlineOrderId) {
      serviceError('REDEMPTION_ORDER_MISMATCH', 'The BOND redemption belongs to another order.');
    }
    const customerId = requiredText(reservation.customerId, 'reservation.customerId', 128);
    const accountRef = db.collection(ACCOUNTS).doc(customerId);
    const accountSnapshot = await transaction.get(accountRef);
    if (!accountSnapshot.exists) serviceError('INVALID_REDEMPTION_STATE', 'The BOND account was not found.');
    const account = accountSnapshot.data();
    const points = nonNegativeInteger(reservation.points, 'reservation.points');
    transaction.create(restoreRef, {
      ledgerEntryId: restoreRef.id,
      customerId,
      eventType: 'POINT_REDEMPTION_RESTORE',
      pointsDelta: points,
      redemptionValuePaise: nonNegativeInteger(
        reservation.discountPaise,
        'reservation.discountPaise',
      ),
      sourceCheckoutSessionId: normalizedSessionId,
      sourceOnlineOrderId: reservationOnlineOrderId || normalizedOnlineOrderId || null,
      sourceOrderId: normalizedSourceOrderId,
      orderChannel: 'CUSTOMER_ORDERING',
      reason: restoreReason,
      originalLedgerEntryId: redemptionRef.id,
      policyVersion: BOND_REDEMPTION_POLICY.policyVersion,
      idempotencyKey: restoreRef.id,
      occurredAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(accountRef, {
      pointsBalance: signedInteger(account.pointsBalance, 'account.pointsBalance') + points,
      lifetimePointsRestored: nonNegativeInteger(
        account.lifetimePointsRestored,
        'account.lifetimePointsRestored',
      ) + points,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(reservationRef, {
      status: 'RESTORED',
      restorationReason: restoreReason,
      sourceOrderId: normalizedSourceOrderId,
      restorationLedgerEntryId: restoreRef.id,
      restoredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      status: 'RESTORED',
      writes: 3,
      points,
      ledgerEntryId: restoreRef.id,
    };
  }

  async function restoreForOnlineOrder({
    sessionId,
    onlineOrderId,
    sourceOrderId,
    reason,
  } = {}) {
    let normalizedSessionId = cleanText(sessionId, 500);
    const normalizedOnlineOrderId = cleanText(onlineOrderId, 500);
    if (!normalizedSessionId) {
      if (!normalizedOnlineOrderId) {
        serviceError('INVALID_REDEMPTION_REQUEST', 'sessionId or onlineOrderId is required.');
      }
      const reservations = await db.collection(RESERVATIONS)
        .where('onlineOrderId', '==', normalizedOnlineOrderId)
        .limit(2)
        .get();
      if (reservations.empty) return { status: 'NO_REDEMPTION', writes: 0, points: 0 };
      if (reservations.size > 1) {
        serviceError('REDEMPTION_ORDER_MISMATCH', 'Multiple BOND reservations reference this order.');
      }
      normalizedSessionId = requiredText(
        reservations.docs[0].data()?.checkoutSessionId,
        'reservation.checkoutSessionId',
        500,
      );
    }
    return db.runTransaction(transaction => restoreInTransaction({
      transaction,
      sessionId: normalizedSessionId,
      onlineOrderId: normalizedOnlineOrderId,
      sourceOrderId,
      reason,
    }));
  }

  async function releaseExpiredReservations({ now, limit = 100 } = {}) {
    const runAt = asTimestamp(admin, now, 'now');
    const batchLimit = Number(limit);
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) {
      serviceError('INVALID_REDEMPTION_REQUEST', 'limit must be between 1 and 500.');
    }
    const snapshot = await db.collection(RESERVATIONS)
      .where('status', '==', 'ACTIVE')
      .where('expiresAt', '<=', runAt)
      .orderBy('expiresAt', 'asc')
      .limit(batchLimit)
      .get();
    let released = 0;
    let unchanged = 0;
    const errors = [];
    for (const document of snapshot.docs) {
      try {
        const result = await releaseReservation({
          customerId: document.data()?.customerId,
          sessionId: document.data()?.checkoutSessionId,
          reason: 'RESERVATION_EXPIRED',
          now: runAt,
          terminalSessionStatus: 'EXPIRED',
          allowedSessionStatuses: [
            'CREATED',
            'PAYMENT_STARTED',
            'PAYMENT_FAILED',
            'CANCELLING',
            'PAYMENT_REVIEW_REQUIRED',
          ],
        });
        if (result.status === 'RELEASED') released += 1;
        else unchanged += 1;
      } catch (error) {
        errors.push({ reservationId: document.id, code: cleanText(error?.code || 'unknown', 100) });
        logger.error?.('Failed to release an expired BOND reservation.', {
          reservationId: document.id,
          code: cleanText(error?.code || 'unknown', 100),
        });
      }
    }
    return {
      status: errors.length ? 'PARTIAL' : 'COMPLETE',
      scanned: snapshot.size,
      released,
      unchanged,
      errors,
    };
  }

  return {
    getFlags,
    quote,
    releaseExpiredReservations,
    releaseReservation,
    reserveInTransaction,
    restoreForOnlineOrder,
    restoreInTransaction,
    settleInTransaction,
  };
}

module.exports = {
  ACCOUNTS,
  FLAGS_DOCUMENT,
  POINT_LEDGER,
  RESERVATIONS,
  BondRedemptionPolicyError,
  BondRedemptionServiceError,
  createBondRedemptionService,
  redemptionLedgerId,
  redemptionReservationId,
  redemptionRestoreLedgerId,
};
