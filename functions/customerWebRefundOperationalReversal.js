'use strict';

const SALE_MOVEMENT_TYPES = new Set(['SALE_DEDUCTION', 'ORDER_BOM_BACKFILL']);
const SYSTEM_ACTOR_ID = 'RAZORPAY_REFUND_WEBHOOK';
const SYSTEM_ACTOR_NAME = 'Razorpay refund reconciliation';

class CustomerWebRefundOperationalReversalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CustomerWebRefundOperationalReversalError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new CustomerWebRefundOperationalReversalError(code, message, details);
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function money(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function roundStock(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function sanitizeFirestoreId(value, maxLength = 480) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'ID').slice(0, maxLength);
}

function deterministicVoidReversalMovementId(originalMovementId) {
  return sanitizeFirestoreId(`${originalMovementId}_VOID_REVERSAL`, 480);
}

function isSaleMovement(movement) {
  return SALE_MOVEMENT_TYPES.has(cleanText(movement?.movementType, 80))
    && (!movement?.referenceType || movement.referenceType === 'ORDER')
    && Number(movement?.quantity) < 0;
}

function isVoidReversal(movement) {
  return movement?.movementType === 'ORDER_VOID_REVERSAL'
    && Boolean(cleanText(movement?.originalMovementId, 480));
}

function paymentReversalBreakdown(order, paymentDocuments) {
  const sourceRows = paymentDocuments.length > 0
    ? paymentDocuments.map(document => document.data())
    : Array.isArray(order.paymentBreakdown) && order.paymentBreakdown.length > 0
      ? order.paymentBreakdown
      : [{ method: order.paymentMethod, provider: order.paymentProvider, amount: order.grandTotal }];
  return sourceRows
    .map(payment => ({
      method: payment?.provider === 'RAZORPAY' || order.paymentProvider === 'RAZORPAY'
        ? 'RAZORPAY'
        : cleanText(payment?.method, 80) || 'UNKNOWN',
      originalAmount: money(payment?.amount),
      amount: money(payment?.amount),
      reversalStatus: 'REFUNDED',
      reason: 'Razorpay confirmed the full provider refund.',
    }))
    .filter(payment => payment.amount > 0 && payment.method !== 'PAY_AT_COUNTER');
}

function createCustomerWebRefundOperationalReversalService({ db, admin }) {
  if (!db) throw new Error('Firestore is required for customer refund operational reversal.');
  if (!admin?.firestore?.FieldValue) throw new Error('Firebase Admin FieldValue is required.');
  const FieldValue = admin.firestore.FieldValue;

  async function reverseConfirmedRefund({
    onlineOrderId,
    posOrderId,
    reason = 'Razorpay confirmed the full customer-order refund.',
  } = {}) {
    const normalizedOnlineOrderId = cleanText(onlineOrderId, 180);
    const normalizedPosOrderId = cleanText(posOrderId, 180);
    const reversalReason = cleanText(reason, 240)
      || 'Razorpay confirmed the full customer-order refund.';
    if (!normalizedOnlineOrderId || !normalizedPosOrderId) {
      fail('INVALID_REFUND_REVERSAL_REQUEST', 'Online and POS order IDs are required.');
    }

    const orderRef = db.collection('orders').doc(normalizedPosOrderId);
    const movementsQuery = db.collection('stockMovements')
      .where('referenceId', '==', normalizedPosOrderId);
    const kotQuery = db.collection('kotItems').where('orderId', '==', normalizedPosOrderId);
    const pendingQuery = db.collection('pendingInventoryConsumption')
      .where('orderId', '==', normalizedPosOrderId);
    const orderItemsQuery = orderRef.collection('items');
    const paymentsQuery = orderRef.collection('payments');

    return db.runTransaction(async transaction => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists) {
        fail('POS_ORDER_NOT_FOUND', 'The linked POS order was not found.');
      }
      const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
      if (
        order.source !== 'CUSTOMER_WEB'
        || cleanText(order.onlineOrderId, 180) !== normalizedOnlineOrderId
        || order.paymentProvider !== 'RAZORPAY'
        || order.paymentMethod !== 'ONLINE'
      ) {
        fail(
          'INELIGIBLE_REFUND_REVERSAL',
          'Only a linked customer-web Razorpay order can use this reversal workflow.',
        );
      }
      if (order.refundStatus !== 'REFUNDED' || order.paymentReversalStatus !== 'REFUNDED') {
        fail(
          'REFUND_NOT_CONFIRMED',
          'The full Razorpay refund must be confirmed before operational reversal.',
        );
      }

      const [movementSnapshot, kotSnapshot, pendingSnapshot, orderItemsSnapshot, paymentsSnapshot] = await Promise.all([
        transaction.get(movementsQuery),
        transaction.get(kotQuery),
        transaction.get(pendingQuery),
        transaction.get(orderItemsQuery),
        transaction.get(paymentsQuery),
      ]);
      if (kotSnapshot.docs.some(document => cleanText(document.data()?.storeId, 160) !== cleanText(order.storeId, 160))) {
        fail('KOT_STORE_MISMATCH', 'A KOT row does not belong to the refunded order store.');
      }
      if (pendingSnapshot.docs.some(document => cleanText(document.data()?.storeId, 160) !== cleanText(order.storeId, 160))) {
        fail('PENDING_STOCK_STORE_MISMATCH', 'A pending stock row does not belong to the refunded order store.');
      }
      const movements = movementSnapshot.docs.map(document => ({
        id: document.id,
        ref: document.ref,
        ...document.data(),
      }));
      const saleMovements = movements.filter(isSaleMovement);
      const existingReversalOriginalIds = new Set(
        movements.filter(isVoidReversal).map(movement => cleanText(movement.originalMovementId, 480)),
      );
      const unresolvedMovements = saleMovements.filter(movement => (
        !existingReversalOriginalIds.has(movement.id)
      ));
      const stockTargets = unresolvedMovements.map(movement => {
        const stockItemType = cleanText(movement.stockItemType || 'RAW_INGREDIENT', 80);
        const stockItemCode = cleanText(movement.stockItemCode || movement.inventoryItemId, 160);
        const storeId = cleanText(movement.storeId, 160);
        if (!storeId || !stockItemCode || storeId !== cleanText(order.storeId, 160)) {
          fail('INVALID_STOCK_MOVEMENT', 'A sale movement has missing or mismatched stock identity.', {
            movementId: movement.id,
          });
        }
        return {
          movement,
          stockItemType,
          stockItemCode,
          stockRef: db.collection('storeStock').doc(`${storeId}_${stockItemType}_${stockItemCode}`),
          reversalRef: db.collection('stockMovements')
            .doc(deterministicVoidReversalMovementId(movement.id)),
        };
      });
      const uniqueStockRefs = [...new Map(
        stockTargets.map(target => [target.stockRef.path, target.stockRef]),
      ).values()];
      const [stockSnapshots, reversalSnapshots] = await Promise.all([
        Promise.all(uniqueStockRefs.map(stockRef => transaction.get(stockRef))),
        Promise.all(stockTargets.map(target => transaction.get(target.reversalRef))),
      ]);
      const stockSnapshotByPath = new Map(
        uniqueStockRefs.map((stockRef, index) => [stockRef.path, stockSnapshots[index]]),
      );
      const runningStockByPath = new Map();

      const preparedReversals = [];
      stockTargets.forEach((target, index) => {
        const reversalSnapshot = reversalSnapshots[index];
        if (reversalSnapshot.exists) {
          const existing = reversalSnapshot.data();
          if (
            existing?.movementType !== 'ORDER_VOID_REVERSAL'
            || cleanText(existing?.originalMovementId, 480) !== target.movement.id
          ) {
            fail('REVERSAL_ID_CONFLICT', 'A deterministic stock reversal ID is already in use.', {
              movementId: target.movement.id,
            });
          }
          return;
        }
        const stockSnapshot = stockSnapshotByPath.get(target.stockRef.path);
        if (!stockSnapshot.exists) {
          fail('STOCK_ROW_NOT_FOUND', 'A stock row required for refund reversal is missing.', {
            movementId: target.movement.id,
            stockItemCode: target.stockItemCode,
          });
        }
        const stockBefore = runningStockByPath.has(target.stockRef.path)
          ? runningStockByPath.get(target.stockRef.path)
          : Number(stockSnapshot.data()?.currentStock);
        if (!Number.isFinite(stockBefore)) {
          fail('INVALID_STOCK_ROW', 'A stock row required for refund reversal has no valid balance.', {
            movementId: target.movement.id,
            stockItemCode: target.stockItemCode,
          });
        }
        const reversalQuantity = Math.abs(Number(target.movement.quantity) || 0);
        const stockAfter = roundStock(stockBefore + reversalQuantity);
        runningStockByPath.set(target.stockRef.path, stockAfter);
        preparedReversals.push({
          ...target,
          reversalQuantity,
          stockBefore,
          stockAfter,
        });
      });

      const pendingRowsToCancel = pendingSnapshot.docs.filter(document => (
        document.data()?.status === 'PENDING_BOM'
      ));
      const kotRowsToCancel = kotSnapshot.docs.filter(document => (
        document.data()?.status !== 'CANCELLED'
      ));
      const orderItemRowsToCancel = orderItemsSnapshot.docs.filter(document => (
        document.data()?.status !== 'CANCELLED'
      ));
      if (
        order.status === 'VOIDED'
        && order.refundOperationalReversalStatus === 'COMPLETED'
        && preparedReversals.length === 0
        && pendingRowsToCancel.length === 0
        && kotRowsToCancel.length === 0
        && orderItemRowsToCancel.length === 0
      ) {
        return {
          status: 'ALREADY_REVERSED',
          posOrderId: normalizedPosOrderId,
          stockMovementCount: 0,
          kotCount: 0,
          itemCount: 0,
        };
      }

      const finalStockByPath = new Map();
      preparedReversals.forEach(target => {
        finalStockByPath.set(target.stockRef.path, target);
      });
      finalStockByPath.forEach(target => {
        transaction.update(target.stockRef, {
          currentStock: target.stockAfter,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      preparedReversals.forEach(target => {
        transaction.create(target.reversalRef, {
          storeId: target.movement.storeId,
          storeCode: order.storeCode,
          storeName: target.movement.storeName || order.storeName,
          inventoryItemId: target.stockItemCode,
          inventoryItemName: target.movement.inventoryItemName || target.stockItemCode,
          movementType: 'ORDER_VOID_REVERSAL',
          reason: 'ORDER_VOID_REVERSAL',
          quantity: target.reversalQuantity,
          quantityDelta: target.reversalQuantity,
          unit: target.movement.unit || '',
          referenceType: 'ORDER',
          referenceId: normalizedPosOrderId,
          orderId: normalizedPosOrderId,
          orderNumber: order.orderNumber,
          sourceOrderId: normalizedPosOrderId,
          voidedOrderId: normalizedPosOrderId,
          originalMovementId: target.movement.id,
          originalMovementType: target.movement.movementType,
          notes: `Confirmed customer refund: ${reversalReason}`,
          createdByUserId: SYSTEM_ACTOR_ID,
          createdByName: SYSTEM_ACTOR_NAME,
          createdAt: FieldValue.serverTimestamp(),
          stockSystem: target.movement.stockSystem || 'MENU_MANAGEMENT',
          stockItemType: target.stockItemType,
          stockItemCode: target.stockItemCode,
          previousQty: target.stockBefore,
          newQty: target.stockAfter,
          stockBefore: target.stockBefore,
          stockAfter: target.stockAfter,
          balanceBefore: target.stockBefore,
          balanceAfter: target.stockAfter,
        });
      });

      pendingRowsToCancel.forEach(document => {
        transaction.update(document.ref, {
          status: 'CANCELLED',
          reason: `Order refunded before BOM backfill: ${reversalReason}`,
          resolvedAt: FieldValue.serverTimestamp(),
          resolvedBy: SYSTEM_ACTOR_ID,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      kotRowsToCancel.forEach(document => {
        transaction.update(document.ref, {
          status: 'CANCELLED',
          voidReason: reversalReason,
          handledByUserId: SYSTEM_ACTOR_ID,
          handledByName: SYSTEM_ACTOR_NAME,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      orderItemRowsToCancel.forEach(document => {
        transaction.update(document.ref, {
          status: 'CANCELLED',
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const reversalBreakdown = paymentReversalBreakdown(order, paymentsSnapshot.docs);
      const refundedAmount = money(order.grandTotal);
      transaction.set(orderRef, {
        status: 'VOIDED',
        refundStatus: 'REFUNDED',
        paymentReversalStatus: 'REFUNDED',
        paymentReversalBreakdown: reversalBreakdown,
        paymentReversalTotal: refundedAmount,
        refundedAmount,
        reversedAmount: 0,
        refundPendingAmount: 0,
        manualRefundRequiredAmount: 0,
        netCollectionAmount: 0,
        voidReason: reversalReason,
        voidedBy: order.voidedBy || SYSTEM_ACTOR_ID,
        voidedByName: order.voidedByName || SYSTEM_ACTOR_NAME,
        voidedByEmail: order.voidedByEmail || null,
        voidedAt: order.voidedAt || FieldValue.serverTimestamp(),
        refundOperationalReversalStatus: 'COMPLETED',
        refundOperationalReversalAt: FieldValue.serverTimestamp(),
        refundOperationalReversalStockCount: saleMovements.length,
        refundOperationalReversalKotCount: kotSnapshot.size,
        refundOperationalReversalItemCount: orderItemsSnapshot.size,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        status: order.status === 'VOIDED' && preparedReversals.length === 0
          ? 'ALREADY_REVERSED'
          : 'REVERSED',
        posOrderId: normalizedPosOrderId,
        stockMovementCount: preparedReversals.length,
        kotCount: kotSnapshot.size,
        itemCount: orderItemsSnapshot.size,
      };
    });
  }

  return { reverseConfirmedRefund };
}

module.exports = {
  CustomerWebRefundOperationalReversalError,
  createCustomerWebRefundOperationalReversalService,
  deterministicVoidReversalMovementId,
};
