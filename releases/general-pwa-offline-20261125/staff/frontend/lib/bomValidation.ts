import { BOMComponent } from '../types/menu-management';

export function validateBOM(bom: BOMComponent[], parentCode: string): string[] {
  const errors: string[] = [];
  const seenCodes = new Set<string>();

  for (const item of bom) {
    if (!item.componentCode) {
      errors.push(`Missing componentCode for a BOM item.`);
    }
    if (!item.uom) {
      errors.push(`Missing UOM for component: ${item.componentCode || 'unknown'}`);
    }
    if (item.quantity <= 0) {
      errors.push(`Quantity must be greater than zero for component: ${item.componentCode || 'unknown'}`);
    }
    if (item.componentCode === parentCode) {
      errors.push(`Self reference detected for component: ${item.componentCode}`);
    }
    if (!['RAW_INGREDIENT', 'PREP_ITEM', 'FINISHED_GOOD', 'PACKAGING'].includes(item.componentType)) {
       errors.push(`Invalid componentType for component: ${item.componentCode || 'unknown'}`);
    }
    if (item.componentCode) {
      if (seenCodes.has(item.componentCode)) {
        errors.push(`Duplicate componentCode in BOM: ${item.componentCode}`);
      }
      seenCodes.add(item.componentCode);
    }
  }

  // Note: Circular dependency validation across multiple PrepItems requires external full-graph checks.
  return errors;
}
