import type { AddOnSelection } from '../types';
import type {
  AddOnGroup,
  AddOnOption,
  FinishedGoodComponentReference,
} from '../types/menu-management';

export type AddOnQuantityByOption = Record<string, number>;

export type AddOnValidationResult = {
  ok: boolean;
  message: string | null;
  selectionCount: number;
};

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isCompositeChoiceGroup(group: AddOnGroup): boolean {
  return group.purpose === 'COMPOSITE_CHOICE';
}

export function isExactDistinctAddOnGroup(group: AddOnGroup): boolean {
  return group.selectionMode === 'EXACT_DISTINCT';
}

export function uniqueAddOnGroupIds(value: unknown): string[] {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(entry => entry.trim()),
  ));
}

export function normalizeAddOnOptionIdsByGroup(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([groupId, optionIds]) => [
        groupId.trim(),
        Array.from(new Set(
          (Array.isArray(optionIds) ? optionIds : [])
            .filter((optionId): optionId is string => typeof optionId === 'string' && optionId.trim().length > 0)
            .map(optionId => optionId.trim()),
        )),
      ] as const)
      .filter(([groupId]) => groupId.length > 0),
  );
}

export function activeAddOnGroupsForProduct(
  addOnGroupIds: unknown,
  addOnOptionIdsByGroup: unknown,
  groups: AddOnGroup[],
): AddOnGroup[] {
  const wanted = new Set(uniqueAddOnGroupIds(addOnGroupIds));
  const allowedOptions = normalizeAddOnOptionIdsByGroup(addOnOptionIdsByGroup);
  return groups
    .filter(group => group.id && wanted.has(group.id) && group.isActive !== false)
    .map(group => ({
      ...group,
      options: (group.options || [])
        .filter(option => option.isActive !== false && allowedOptions[group.id || '']?.includes(option.id))
        .sort((a, b) => number(a.sortOrder) - number(b.sortOrder) || a.name.localeCompare(b.name)),
    }))
    .filter(group => group.options.length > 0);
}

export function validateAddOnQuantities(
  group: AddOnGroup,
  quantities: AddOnQuantityByOption,
): AddOnValidationResult {
  const activeIds = new Set((group.options || []).filter(option => option.isActive !== false).map(option => option.id));
  const invalid = Object.entries(quantities).find(([optionId, quantity]) => (
    number(quantity) < 0
    || !Number.isInteger(number(quantity))
    || (number(quantity) > 0 && !activeIds.has(optionId))
  ));
  if (invalid) {
    return { ok: false, message: 'One or more selected add-ons are unavailable.', selectionCount: 0 };
  }

  if (isExactDistinctAddOnGroup(group)) {
    const minimum = number(group.minimumSelections);
    const maximum = number(group.maximumSelections);
    if (
      !Number.isInteger(minimum)
      || minimum <= 0
      || !Number.isInteger(maximum)
      || maximum !== minimum
    ) {
      return {
        ok: false,
        message: `${group.name} is not configured for an exact number of choices.`,
        selectionCount: 0,
      };
    }
    if (Object.values(quantities).some(quantity => number(quantity) > 1)) {
      return {
        ok: false,
        message: `Choose ${minimum} different options from ${group.name}.`,
        selectionCount: 0,
      };
    }
  }

  const selectionCount = Object.values(quantities).reduce((sum, quantity) => sum + Math.max(0, number(quantity)), 0);
  const minimum = Math.max(0, number(group.minimumSelections));
  const configuredMaximum = group.maximumSelections;
  const maximum = configuredMaximum === null || configuredMaximum === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(minimum, number(configuredMaximum));

  if (selectionCount < minimum) {
    return {
      ok: false,
      message: `Choose at least ${minimum} option${minimum === 1 ? '' : 's'} from ${group.name}.`,
      selectionCount,
    };
  }
  if (selectionCount > maximum) {
    return {
      ok: false,
      message: `Choose no more than ${maximum} option${maximum === 1 ? '' : 's'} from ${group.name}.`,
      selectionCount,
    };
  }
  return { ok: true, message: null, selectionCount };
}

function inventoryTrackingStatus(option: AddOnOption): AddOnSelection['inventoryTrackingStatus'] {
  return option.inventoryItemType
    && option.inventoryItemCode?.trim()
    && number(option.consumptionQuantity) > 0
    && option.consumptionUnit?.trim()
    ? 'CONFIGURED'
    : 'NOT_CONFIGURED';
}

export function buildAddOnSelections(
  groups: AddOnGroup[],
  quantitiesByGroup: Record<string, AddOnQuantityByOption>,
  fallbackTaxRate: number,
): AddOnSelection[] {
  return groups.flatMap(group => {
    const quantities = quantitiesByGroup[group.id || ''] || {};
    return (group.options || []).flatMap(option => {
      const quantity = number(quantities[option.id]);
      if (quantity <= 0 || option.isActive === false) return [];
      const unitPrice = Math.max(0, number(option.price));
      const taxRate = number(option.taxRate) > 0 ? number(option.taxRate) : Math.max(0, number(fallbackTaxRate));
      const status = inventoryTrackingStatus(option);
      return [{
        groupId: group.id || '',
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        quantity,
        unitPrice,
        totalPrice: unitPrice * quantity,
        taxRate,
        inventoryTrackingStatus: status,
        ...(status === 'CONFIGURED' ? {
          inventoryItemType: option.inventoryItemType,
          inventoryItemCode: option.inventoryItemCode!.trim(),
          consumptionQuantity: number(option.consumptionQuantity),
          consumptionUnit: option.consumptionUnit!.trim(),
        } : {}),
      } satisfies AddOnSelection];
    });
  });
}

export function canonicalAddOnSelections(
  addOnGroupIds: unknown,
  addOnOptionIdsByGroup: unknown,
  groups: AddOnGroup[],
  requestedSelections: AddOnSelection[] | undefined,
  fallbackTaxRate: number,
): AddOnSelection[] {
  const activeGroups = activeAddOnGroupsForProduct(addOnGroupIds, addOnOptionIdsByGroup, groups);
  const activeGroupIds = new Set(activeGroups.map(group => group.id));
  const requested = requestedSelections || [];
  if (requested.some(selection => !activeGroupIds.has(selection.groupId))) {
    throw new Error('One or more selected add-on groups are no longer available for this item.');
  }

  const quantities = requested.reduce<Record<string, AddOnQuantityByOption>>((acc, selection) => {
    if (!acc[selection.groupId]) acc[selection.groupId] = {};
    acc[selection.groupId][selection.optionId] = (acc[selection.groupId][selection.optionId] || 0) + number(selection.quantity);
    return acc;
  }, {});

  for (const group of activeGroups) {
    const result = validateAddOnQuantities(group, quantities[group.id || ''] || {});
    if (!result.ok) throw new Error(result.message || 'The selected add-ons are invalid.');
  }
  return buildAddOnSelections(activeGroups, quantities, fallbackTaxRate);
}

export function addOnTotal(addOns: AddOnSelection[] | undefined): number {
  return (addOns || []).reduce((sum, addOn) => sum + Math.max(0, number(addOn.totalPrice)), 0);
}

export function addOnSelectionKey(addOns: AddOnSelection[] | undefined): string {
  return (addOns || [])
    .filter(addOn => number(addOn.quantity) > 0)
    .map(addOn => `${addOn.groupId}:${addOn.optionId}:${number(addOn.quantity)}`)
    .sort()
    .join('|');
}

export function unitPriceWithAddOns(baseUnitPrice: number, addOns: AddOnSelection[] | undefined): number {
  return Math.max(0, number(baseUnitPrice)) + addOnTotal(addOns);
}

export function addOnTaxForLine(
  addOns: AddOnSelection[] | undefined,
  parentQuantity: number,
  discountRatio: number,
): number {
  const safeParentQuantity = Math.max(0, number(parentQuantity));
  const safeDiscountRatio = Math.min(1, Math.max(0, number(discountRatio)));
  return (addOns || []).reduce((sum, addOn) => {
    const taxable = Math.max(0, number(addOn.totalPrice) * safeParentQuantity * (1 - safeDiscountRatio));
    return sum + taxable * Math.max(0, number(addOn.taxRate)) / 100;
  }, 0);
}

export function sanitizeAddOnGroupsForPublic(groups: AddOnGroup[]): AddOnGroup[] {
  return groups
    .filter(group => group.id && group.isActive !== false)
    .map(group => {
      const compositeChoice = isCompositeChoiceGroup(group);
      const selectionMode = group.selectionMode === 'SINGLE'
        ? 'SINGLE'
        : group.selectionMode === 'EXACT_DISTINCT'
          ? 'EXACT_DISTINCT'
          : 'MULTIPLE';
      return {
        id: group.id,
        name: group.name,
        isActive: true,
        isRequired: group.isRequired === true,
        minimumSelections: Math.max(0, number(group.minimumSelections)),
        maximumSelections: group.maximumSelections === null || group.maximumSelections === undefined
          ? null
          : Math.max(0, number(group.maximumSelections)),
        selectionMode,
        ...(compositeChoice ? { purpose: 'COMPOSITE_CHOICE' as const } : {}),
        options: (group.options || [])
          .filter(option => option.isActive !== false)
          .map(option => {
            const taxRate = number(option.taxRate);
            const component = sanitizedFinishedGoodComponent(option.finishedGoodComponent);
            return {
              id: option.id,
              code: option.code || option.id,
              name: option.name,
              price: Math.max(0, number(option.price)),
              ...(option.attribute ? { attribute: option.attribute } : {}),
              ...(taxRate > 0 ? { taxRate } : {}),
              isActive: true,
              sortOrder: number(option.sortOrder),
              ...(compositeChoice && component ? { finishedGoodComponent: component } : {}),
            };
          }),
      };
    });
}

function sanitizedFinishedGoodComponent(value: unknown): FinishedGoodComponentReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<FinishedGoodComponentReference>;
  const finishedGoodId = typeof candidate.finishedGoodId === 'string'
    ? candidate.finishedGoodId.trim()
    : '';
  const finishedGoodCode = typeof candidate.finishedGoodCode === 'string'
    ? candidate.finishedGoodCode.trim()
    : '';
  const quantity = number(candidate.quantity);
  if (
    !finishedGoodId
    || !finishedGoodCode
    || !Number.isInteger(quantity)
    || quantity <= 0
    || quantity > 100
  ) return null;
  return { finishedGoodId, finishedGoodCode, quantity };
}

export function sanitizedAddOnSnapshot(addOns: AddOnSelection[] | undefined) {
  return (addOns || []).map(addOn => ({
    groupName: addOn.groupName,
    optionName: addOn.optionName,
    quantity: addOn.quantity,
    unitPrice: addOn.unitPrice,
    totalPrice: addOn.totalPrice,
  }));
}
