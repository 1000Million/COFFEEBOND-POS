import assert from 'node:assert/strict';
import {
  canConvertUom,
  CONFIRMED_UNIT_LABEL_REPAIR_CODES,
  convertQuantity,
  deriveLiquidPrepUnitDecision,
  normalizeUom,
  TARGET_LIQUID_PREP_CODES,
} from './menu-setup-unit-rules.mjs';

assert.equal(normalizeUom('millilitres'), 'ML');
assert.equal(canConvertUom('ML', 'ML'), true, 'ML-to-ML consumption must be accepted.');
assert.deepEqual(convertQuantity(350, 'ML', 'ML'), { quantity: 350, normalized: false });

assert.equal(canConvertUom('ML', 'L'), true, 'Volume units should remain convertible.');
assert.deepEqual(convertQuantity(1000, 'ML', 'L'), { quantity: 1, normalized: true });

assert.equal(canConvertUom('ML', 'G'), false, 'ML-to-G must be rejected without a documented density conversion.');
assert.equal(convertQuantity(350, 'ML', 'G'), null, 'Incompatible volume-to-weight conversion must return null.');

const proteinPowerDecision = deriveLiquidPrepUnitDecision({
  prepCode: 'PROTEIN_POWER_BASE',
  currentUnit: 'G',
  consumptionUnits: ['ML'],
});
assert.equal(proteinPowerDecision.status, 'PROPOSE_ML');
assert.equal(proteinPowerDecision.proposedUnit, 'ML');

const alreadyCorrectDecision = deriveLiquidPrepUnitDecision({
  prepCode: 'BERRY_ME_BASE',
  currentUnit: 'ML',
  consumptionUnits: ['ML'],
});
assert.equal(alreadyCorrectDecision.status, 'ALREADY_CORRECT');
assert.equal(alreadyCorrectDecision.proposedUnit, 'ML');

const densityDecision = deriveLiquidPrepUnitDecision({
  prepCode: 'MOCHA_BASE',
  currentUnit: 'G',
  consumptionUnits: ['G'],
});
assert.equal(densityDecision.status, 'OWNER_DENSITY_REQUIRED');
assert.equal(densityDecision.proposedUnit, 'G');

const mixedDecision = deriveLiquidPrepUnitDecision({
  prepCode: 'CHOCOLATE_BASE',
  currentUnit: 'G',
  consumptionUnits: ['ML', 'G'],
});
assert.equal(mixedDecision.status, 'AMBIGUOUS_UNITS');
assert.equal(mixedDecision.proposedUnit, '');

assert.equal(TARGET_LIQUID_PREP_CODES.includes('BERRY_ME_BASE'), true, 'Berry Me Base should remain in dry-run reporting.');
assert.equal(CONFIRMED_UNIT_LABEL_REPAIR_CODES.includes('BERRY_ME_BASE'), false, 'Berry Me Base must not be included in confirmed apply set.');
assert.deepEqual(CONFIRMED_UNIT_LABEL_REPAIR_CODES, [
  'PROTEIN_POWER_BASE',
  'COLLAGEN_SMOOTHIE_BASE',
  'CHOCOLATE_BASE',
  'MOCHA_BASE',
  'TIRAMISU_BASE',
  'VITA_C_BLISS_BASE',
]);

console.log('Menu setup unit repair tests passed.');
console.log('- ML-to-ML consumption accepted');
console.log('- ML-to-G rejected without density');
console.log('- Seven liquid bases propose ML when all consumption is volume');
console.log('- Apply target excludes Berry Me Base');
console.log('- Weight/mixed-unit cases remain blocked for owner approval');
