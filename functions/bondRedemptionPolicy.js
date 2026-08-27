'use strict';

const BOND_REDEMPTION_POLICY = Object.freeze({
  policyVersion: 'BOND_REDEMPTION_POLICY_V1_2026',
  label: 'BOND Points Redemption',
  pointValuePaise: 100,
  minimumPoints: 50,
  incrementPoints: 10,
  maximumEligibleSubtotalBasisPoints: 2000,
  eligibleChannel: 'CUSTOMER_WEB',
});

const BASIS_POINTS_DENOMINATOR = 10000n;
const TAX_RATE_SCALE = 10000;
const TAX_RATE_DENOMINATOR = 100n * BigInt(TAX_RATE_SCALE);

class BondRedemptionPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BondRedemptionPolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function policyError(code, message, details) {
  throw new BondRedemptionPolicyError(code, message, details);
}

function nonNegativeSafeInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    policyError('INVALID_REDEMPTION_INPUT', `${field} must be a non-negative safe integer.`, { field });
  }
  return parsed;
}

function positiveSafeInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    policyError('INVALID_REDEMPTION_INPUT', `${field} must be a positive safe integer.`, { field });
  }
  return parsed;
}

function rupeesToPaise(value, field = 'amount') {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    policyError('INVALID_MONEY', `${field} must be a non-negative monetary amount.`, { field });
  }
  const scaled = parsed * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    policyError('INVALID_MONEY', `${field} must have at most two decimal places.`, { field });
  }
  return rounded;
}

function paiseToRupees(value) {
  return nonNegativeSafeInteger(value, 'paise') / 100;
}

function scaledTaxRate(value, field) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    policyError('INVALID_TAX_RATE', `${field} must be between 0 and 100.`, { field });
  }
  const scaled = Math.round(parsed * TAX_RATE_SCALE);
  if (!Number.isSafeInteger(scaled) || Math.abs((parsed * TAX_RATE_SCALE) - scaled) > 1e-7) {
    policyError('INVALID_TAX_RATE', `${field} has unsupported precision.`, { field });
  }
  return scaled;
}

function roundPositiveFraction(numerator, denominator) {
  return (numerator + (denominator / 2n)) / denominator;
}

function taxPaiseFor(taxablePaise, taxRateScaled) {
  const taxable = nonNegativeSafeInteger(taxablePaise, 'taxablePaise');
  const numerator = BigInt(taxable) * BigInt(taxRateScaled);
  const rounded = roundPositiveFraction(numerator, TAX_RATE_DENOMINATOR);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    policyError('INVALID_MONEY', 'Calculated GST is outside the supported range.');
  }
  return result;
}

function calculateMaximumUsablePoints({
  eligibleSubtotalPaise,
  pointsBalance,
  availablePoints,
}) {
  const subtotalPaise = nonNegativeSafeInteger(eligibleSubtotalPaise, 'eligibleSubtotalPaise');
  const balancePoints = nonNegativeSafeInteger(
    availablePoints === undefined ? pointsBalance : availablePoints,
    availablePoints === undefined ? 'pointsBalance' : 'availablePoints',
  );
  const maximumValuePaise = Number(
    (BigInt(subtotalPaise) * BigInt(BOND_REDEMPTION_POLICY.maximumEligibleSubtotalBasisPoints))
      / BASIS_POINTS_DENOMINATOR,
  );
  const maximumBySubtotalPoints = Math.floor(
    maximumValuePaise / BOND_REDEMPTION_POLICY.pointValuePaise,
  );
  const boundedPoints = Math.min(balancePoints, maximumBySubtotalPoints);
  const incrementRoundedPoints = Math.floor(
    boundedPoints / BOND_REDEMPTION_POLICY.incrementPoints,
  ) * BOND_REDEMPTION_POLICY.incrementPoints;
  const maximumUsablePoints = incrementRoundedPoints >= BOND_REDEMPTION_POLICY.minimumPoints
    ? incrementRoundedPoints
    : 0;

  return Object.freeze({
    eligibleSubtotalPaise: subtotalPaise,
    pointsBalance: balancePoints,
    maximumBySubtotalPoints,
    maximumUsablePoints,
    maximumDiscountPaise: maximumUsablePoints * BOND_REDEMPTION_POLICY.pointValuePaise,
  });
}

function validateBondRedemptionRequest({
  requestedPoints = 0,
  pointsBalance = 0,
  availablePoints,
  eligibleSubtotalPaise = 0,
  existingDiscountPaise = 0,
  redemptionEnabled = false,
  channel,
}) {
  const selectedPoints = nonNegativeSafeInteger(requestedPoints, 'requestedPoints');
  const existingDiscount = nonNegativeSafeInteger(existingDiscountPaise, 'existingDiscountPaise');
  const balancePoints = nonNegativeSafeInteger(
    availablePoints === undefined ? pointsBalance : availablePoints,
    availablePoints === undefined ? 'pointsBalance' : 'availablePoints',
  );
  const eligibleSubtotal = nonNegativeSafeInteger(eligibleSubtotalPaise, 'eligibleSubtotalPaise');
  const eligibleChannel = String(channel || '').trim().toUpperCase()
    === BOND_REDEMPTION_POLICY.eligibleChannel;
  const limits = calculateMaximumUsablePoints({
    eligibleSubtotalPaise: eligibleSubtotal,
    pointsBalance: balancePoints,
  });

  if (selectedPoints === 0) {
    const maximumUsablePoints = redemptionEnabled === true && eligibleChannel
      ? limits.maximumUsablePoints
      : 0;
    return Object.freeze({
      ...limits,
      maximumUsablePoints,
      maximumDiscountPaise: maximumUsablePoints * BOND_REDEMPTION_POLICY.pointValuePaise,
      requestedPoints: 0,
      discountPaise: 0,
      eligible: true,
    });
  }
  if (redemptionEnabled !== true) {
    policyError('REDEMPTION_DISABLED', 'BOND points redemption is not enabled.');
  }
  if (!eligibleChannel) {
    policyError(
      'REDEMPTION_CHANNEL_INELIGIBLE',
      'BOND points redemption is available only for customer ordering.',
      { channel: String(channel || '') },
    );
  }
  if (existingDiscount > 0) {
    policyError(
      'REDEMPTION_WITH_DISCOUNT_NOT_ALLOWED',
      'BOND points redemption cannot be combined with another discount.',
      { existingDiscountPaise: existingDiscount },
    );
  }
  if (selectedPoints < BOND_REDEMPTION_POLICY.minimumPoints) {
    policyError(
      'REDEMPTION_BELOW_MINIMUM',
      `Redeem at least ${BOND_REDEMPTION_POLICY.minimumPoints} points.`,
      { minimumPoints: BOND_REDEMPTION_POLICY.minimumPoints },
    );
  }
  if (selectedPoints % BOND_REDEMPTION_POLICY.incrementPoints !== 0) {
    policyError(
      'REDEMPTION_INCREMENT_REQUIRED',
      `Redeem points in multiples of ${BOND_REDEMPTION_POLICY.incrementPoints}.`,
      { incrementPoints: BOND_REDEMPTION_POLICY.incrementPoints },
    );
  }
  if (selectedPoints > balancePoints) {
    policyError(
      'INSUFFICIENT_POINTS',
      'The available BOND points balance is insufficient.',
      { requestedPoints: selectedPoints, availablePoints: balancePoints },
    );
  }
  if (selectedPoints > limits.maximumUsablePoints) {
    policyError(
      'REDEMPTION_EXCEEDS_MAXIMUM',
      'The requested BOND points exceed the maximum for this basket.',
      { requestedPoints: selectedPoints, maximumUsablePoints: limits.maximumUsablePoints },
    );
  }

  return Object.freeze({
    ...limits,
    requestedPoints: selectedPoints,
    discountPaise: selectedPoints * BOND_REDEMPTION_POLICY.pointValuePaise,
    eligible: true,
  });
}

function allocateDiscountPaise(components, discountPaise) {
  if (!Array.isArray(components) || components.length === 0) {
    policyError('INVALID_REDEMPTION_COMPONENTS', 'At least one taxable component is required.');
  }
  const discount = nonNegativeSafeInteger(discountPaise, 'discountPaise');
  const seenKeys = new Set();
  const normalized = components.map((component, index) => {
    const key = String(component?.key || '').trim();
    if (!key || seenKeys.has(key)) {
      policyError('INVALID_REDEMPTION_COMPONENTS', 'Taxable component keys must be unique.', { index });
    }
    seenKeys.add(key);
    return {
      key,
      index,
      subtotalPaise: nonNegativeSafeInteger(component?.subtotalPaise, `components[${index}].subtotalPaise`),
    };
  });
  const subtotalPaise = normalized.reduce((sum, component) => sum + component.subtotalPaise, 0);
  if (!Number.isSafeInteger(subtotalPaise) || discount > subtotalPaise) {
    policyError(
      'INVALID_REDEMPTION_DISCOUNT',
      'The discount cannot exceed the eligible pre-GST subtotal.',
      { discountPaise: discount, subtotalPaise },
    );
  }
  if (subtotalPaise === 0) {
    if (discount !== 0) {
      policyError('INVALID_REDEMPTION_DISCOUNT', 'A zero-value basket cannot receive a discount.');
    }
    return normalized.map(component => Object.freeze({ ...component, discountPaise: 0 }));
  }

  const denominator = BigInt(subtotalPaise);
  const allocations = normalized.map((component) => {
    const numerator = BigInt(discount) * BigInt(component.subtotalPaise);
    return {
      ...component,
      discountPaise: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });
  const allocatedPaise = allocations.reduce((sum, component) => sum + component.discountPaise, 0);
  const remainingPaise = discount - allocatedPaise;
  const priority = [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.key.localeCompare(right.key);
  });
  for (let index = 0; index < remainingPaise; index += 1) {
    priority[index].discountPaise += 1;
  }

  return allocations
    .sort((left, right) => left.index - right.index)
    .map(({ remainder, ...component }) => Object.freeze(component));
}

function buildTaxComponents(items) {
  if (!Array.isArray(items) || items.length === 0) {
    policyError('INVALID_REDEMPTION_COMPONENTS', 'At least one checkout item is required.');
  }
  const lines = [];
  const components = [];
  items.forEach((item, itemIndex) => {
    const quantity = positiveSafeInteger(item?.quantity, `items[${itemIndex}].quantity`);
    const identity = String(
      item?.lineId || item?.finishedGoodId || item?.finishedGoodCode || `ITEM_${itemIndex + 1}`,
    ).trim();
    const prefix = `LINE_${String(itemIndex + 1).padStart(4, '0')}_${identity}`;
    const baseUnitPricePaise = rupeesToPaise(
      item?.baseUnitPrice,
      `items[${itemIndex}].baseUnitPrice`,
    );
    const baseTaxRateScaled = scaledTaxRate(
      item?.taxRate,
      `items[${itemIndex}].taxRate`,
    );
    const componentIndexes = [];
    componentIndexes.push(components.length);
    components.push({
      key: `${prefix}_BASE`,
      itemIndex,
      kind: 'BASE',
      addOnIndex: null,
      subtotalPaise: baseUnitPricePaise * quantity,
      taxRate: Number(item?.taxRate ?? 0),
      taxRateScaled: baseTaxRateScaled,
    });
    const addOns = Array.isArray(item?.addOns) ? item.addOns : [];
    addOns.forEach((addOn, addOnIndex) => {
      const addOnUnitTotalPaise = rupeesToPaise(
        addOn?.totalPrice,
        `items[${itemIndex}].addOns[${addOnIndex}].totalPrice`,
      );
      const addOnTaxRateScaled = scaledTaxRate(
        addOn?.taxRate,
        `items[${itemIndex}].addOns[${addOnIndex}].taxRate`,
      );
      const addOnIdentity = [
        addOn?.groupId,
        addOn?.optionId,
        String(addOnIndex + 1).padStart(4, '0'),
      ].map(value => String(value || '')).join('_');
      componentIndexes.push(components.length);
      components.push({
        key: `${prefix}_ADDON_${addOnIdentity}`,
        itemIndex,
        kind: 'ADD_ON',
        addOnIndex,
        subtotalPaise: addOnUnitTotalPaise * quantity,
        taxRate: Number(addOn?.taxRate ?? 0),
        taxRateScaled: addOnTaxRateScaled,
      });
    });
    lines.push({ item, itemIndex, componentIndexes });
  });
  for (const component of components) {
    if (!Number.isSafeInteger(component.subtotalPaise)) {
      policyError('INVALID_MONEY', 'A checkout component is outside the supported range.');
    }
  }
  return { lines, components };
}

function applyBondRedemptionToItems({
  items,
  requestedPoints = 0,
  pointsBalance = 0,
  availablePoints,
  existingDiscountPaise = 0,
  redemptionEnabled = false,
  channel,
}) {
  const { lines, components } = buildTaxComponents(items);
  const subtotalPaise = components.reduce((sum, component) => sum + component.subtotalPaise, 0);
  if (!Number.isSafeInteger(subtotalPaise)) {
    policyError('INVALID_MONEY', 'The checkout subtotal is outside the supported range.');
  }
  const validation = validateBondRedemptionRequest({
    requestedPoints,
    pointsBalance,
    availablePoints,
    eligibleSubtotalPaise: subtotalPaise,
    existingDiscountPaise,
    redemptionEnabled,
    channel,
  });
  const allocations = allocateDiscountPaise(components, validation.discountPaise);
  const pricedComponents = components.map((component, index) => {
    const componentDiscountPaise = allocations[index].discountPaise;
    const taxablePaise = component.subtotalPaise - componentDiscountPaise;
    const componentTaxPaise = taxPaiseFor(taxablePaise, component.taxRateScaled);
    return Object.freeze({
      key: component.key,
      itemIndex: component.itemIndex,
      kind: component.kind,
      addOnIndex: component.addOnIndex,
      taxRate: component.taxRate,
      subtotalPaise: component.subtotalPaise,
      discountPaise: componentDiscountPaise,
      taxablePaise,
      taxPaise: componentTaxPaise,
      totalPaise: taxablePaise + componentTaxPaise,
    });
  });

  const pricedItems = lines.map(({ item, componentIndexes }) => {
    const lineComponents = componentIndexes.map(index => pricedComponents[index]);
    const lineSubtotalPaise = lineComponents.reduce((sum, component) => sum + component.subtotalPaise, 0);
    const lineDiscountPaise = lineComponents.reduce((sum, component) => sum + component.discountPaise, 0);
    const lineTaxablePaise = lineComponents.reduce((sum, component) => sum + component.taxablePaise, 0);
    const lineTaxPaise = lineComponents.reduce((sum, component) => sum + component.taxPaise, 0);
    return Object.freeze({
      ...item,
      addOns: Array.isArray(item.addOns) ? item.addOns.map(addOn => ({ ...addOn })) : [],
      lineSubtotal: paiseToRupees(lineSubtotalPaise),
      lineDiscount: paiseToRupees(lineDiscountPaise),
      lineTaxable: paiseToRupees(lineTaxablePaise),
      lineTax: paiseToRupees(lineTaxPaise),
      lineTotal: paiseToRupees(lineTaxablePaise + lineTaxPaise),
    });
  });
  const discountPaise = pricedComponents.reduce((sum, component) => sum + component.discountPaise, 0);
  const taxableAmountPaise = pricedComponents.reduce((sum, component) => sum + component.taxablePaise, 0);
  const gstTotalPaise = pricedComponents.reduce((sum, component) => sum + component.taxPaise, 0);
  const grandTotalPaise = taxableAmountPaise + gstTotalPaise;

  return Object.freeze({
    items: pricedItems,
    components: pricedComponents,
    subtotalPaise,
    discountPaise,
    taxableAmountPaise,
    gstTotalPaise,
    grandTotalPaise,
    eligibleSpendPaise: taxableAmountPaise,
    subtotal: paiseToRupees(subtotalPaise),
    discount: paiseToRupees(discountPaise),
    taxableAmount: paiseToRupees(taxableAmountPaise),
    gstTotal: paiseToRupees(gstTotalPaise),
    grandTotal: paiseToRupees(grandTotalPaise),
    redemption: Object.freeze({
      policyVersion: BOND_REDEMPTION_POLICY.policyVersion,
      label: BOND_REDEMPTION_POLICY.label,
      points: validation.requestedPoints,
      discountPaise,
      discount: paiseToRupees(discountPaise),
      maximumUsablePoints: validation.maximumUsablePoints,
      pointsBalance: validation.pointsBalance,
    }),
  });
}

function existingCheckoutDiscountPaise(checkout) {
  const candidates = [
    checkout?.discountAmount,
    checkout?.discountTotal,
    checkout?.discount,
  ].filter(value => value !== undefined && value !== null);
  return candidates.reduce((maximum, value, index) => (
    Math.max(maximum, rupeesToPaise(value, `checkoutDiscount[${index}]`))
  ), 0);
}

function applyBondRedemptionToCheckout({
  checkout,
  requestedPoints = 0,
  pointsBalance = 0,
  availablePoints,
  redemptionEnabled = false,
  channel = BOND_REDEMPTION_POLICY.eligibleChannel,
}) {
  if (!checkout || typeof checkout !== 'object') {
    policyError('INVALID_REDEMPTION_INPUT', 'A canonical checkout is required.');
  }
  const priced = applyBondRedemptionToItems({
    items: checkout.items,
    requestedPoints,
    pointsBalance,
    availablePoints,
    existingDiscountPaise: existingCheckoutDiscountPaise(checkout),
    redemptionEnabled,
    channel,
  });
  const hasRedemption = priced.redemption.points > 0;
  return Object.freeze({
    ...checkout,
    items: priced.items,
    subtotal: priced.subtotal,
    discount: priced.discount,
    discountAmount: priced.discount,
    discountTotal: priced.discount,
    discountReason: hasRedemption ? BOND_REDEMPTION_POLICY.label : null,
    discountSource: hasRedemption ? 'BOND_REDEMPTION' : null,
    taxableAmount: priced.taxableAmount,
    gstTotal: priced.gstTotal,
    grandTotal: priced.grandTotal,
    bondRedemptionPoints: priced.redemption.points,
    bondRedemptionDiscount: priced.redemption.discount,
    pointFundedAmount: priced.redemption.discount,
    bondRedemption: priced.redemption,
    redemptionComponents: priced.components,
    eligibleSpendPaise: priced.eligibleSpendPaise,
  });
}

module.exports = {
  BOND_REDEMPTION_POLICY,
  BondRedemptionPolicyError,
  allocateDiscountPaise,
  applyBondRedemptionToCheckout,
  applyBondRedemptionToItems,
  calculateMaximumUsablePoints,
  paiseToRupees,
  rupeesToPaise,
  taxPaiseFor,
  validateBondRedemptionRequest,
};
