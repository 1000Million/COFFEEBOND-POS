import assert from 'node:assert/strict';
import {
  isPackagingComponentApplicable,
  resolvePackagingApplicability,
} from '../frontend/lib/packagingApplicability';
import { BOMComponent } from '../frontend/types/menu-management';

function packagingLine(componentCode: string, componentName: string, overrides: Partial<BOMComponent> = {}): BOMComponent {
  return {
    componentType: 'PACKAGING',
    componentCode,
    componentName,
    quantity: 1,
    uom: 'PCS',
    costPerUnit: 0,
    lineCost: 0,
    ...overrides,
  };
}

const sandwichBox = packagingLine('SANDWICH_BOX', 'Sandwich Box');
assert.deepEqual(resolvePackagingApplicability(sandwichBox), ['TAKEAWAY', 'DELIVERY']);
assert.equal(isPackagingComponentApplicable(sandwichBox, 'DINE_IN'), false, 'DINE IN Pancakes must not deduct Sandwich Box');
assert.equal(isPackagingComponentApplicable(sandwichBox, 'TAKEAWAY'), true, 'TAKEAWAY Pancakes must deduct Sandwich Box');
assert.equal(isPackagingComponentApplicable(sandwichBox, 'DELIVERY'), true, 'DELIVERY Pancakes must deduct Sandwich Box');

const napkin = packagingLine('NAPKIN', 'Napkin');
assert.deepEqual(resolvePackagingApplicability(napkin), ['ALL']);
assert.equal(isPackagingComponentApplicable(napkin, 'DINE_IN'), true, 'Napkin should apply to dine in by default');
assert.equal(isPackagingComponentApplicable(napkin, 'TAKEAWAY'), true, 'Napkin should apply to takeaway by default');

const explicitDineInOnly = packagingLine('PLATE_LINER', 'Plate Liner', { applicableOrderTypes: ['DINE_IN'] });
assert.deepEqual(resolvePackagingApplicability(explicitDineInOnly), ['DINE_IN']);
assert.equal(isPackagingComponentApplicable(explicitDineInOnly, 'DINE_IN'), true);
assert.equal(isPackagingComponentApplicable(explicitDineInOnly, 'TAKEAWAY'), false);

console.log('Packaging applicability tests passed.');
