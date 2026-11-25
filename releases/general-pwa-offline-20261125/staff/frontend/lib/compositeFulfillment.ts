import type { AddOnSelection, KotStatus } from '../types';
import type { CanonicalCompositeComponent, FinishedGood, PrepStation } from '../types/menu-management';

type FulfillmentLine = {
  lineKey: string;
  quantity: number;
  finishedGood: FinishedGood & { id?: string };
  addOns?: AddOnSelection[];
  components?: CanonicalCompositeComponent[];
};

export type ExpandedInventoryLine = FulfillmentLine & {
  parentLineKey: string;
  component?: CanonicalCompositeComponent;
};

export type CompositeKotTask = {
  taskKey: string;
  station: 'BARISTA' | 'KITCHEN';
  itemName: string;
  itemCode: string;
  quantity: number;
  component: CanonicalCompositeComponent | null;
};

export function aggregateKotTaskStatus(statuses: KotStatus[]): KotStatus {
  if (statuses.length === 0) return 'PENDING';
  if (statuses.some(status => ['CANCELLED', 'RETURNED', 'WASTAGE_RECORDED'].includes(status))) return 'CANCELLED';
  if (statuses.includes('REMAKE_REQUESTED')) return 'PENDING';
  if (statuses.includes('PENDING')) return 'PENDING';
  if (statuses.includes('PREPARING')) return 'PREPARING';
  if (statuses.includes('READY')) return 'READY';
  return 'SERVED';
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function station(value: unknown): PrepStation {
  const normalized = String(value || 'NONE').trim().toUpperCase();
  return ['BARISTA', 'KITCHEN', 'BOTH'].includes(normalized) ? normalized as PrepStation : 'NONE';
}

export function componentLineKey(parentLineKey: string, sequence: number): string {
  return `${parentLineKey}__COMP_${String(sequence).padStart(3, '0')}`;
}

function virtualFinishedGood(component: CanonicalCompositeComponent, storeId: string): FinishedGood {
  return {
    id: component.componentFinishedGoodId,
    code: component.componentFinishedGoodCode,
    name: component.componentName,
    displayName: component.componentName,
    itemType: component.itemType || 'MADE_TO_ORDER',
    productionMode: component.productionMode || 'MADE_TO_ORDER',
    prepStation: component.prepStation,
    bom: component.bom as FinishedGood['bom'],
    bomVersion: component.bomVersion || 0,
    posCategoryCode: 'COMPOSITE_COMPONENT',
    posCategoryName: 'Composite component',
    salePrice: 0,
    taxRate: 0,
    recipeCost: 0,
    grossMargin: 0,
    cogsPercent: 0,
    sortOrder: component.sequence,
    availableStoreIds: [storeId],
    isActive: true,
    isSellable: true,
    isAvailable: true,
  };
}

export function expandCompositeInventoryLines(lines: FulfillmentLine[], storeId: string): ExpandedInventoryLine[] {
  return lines.flatMap<ExpandedInventoryLine>(line => {
    const components = Array.isArray(line.components) ? line.components : [];
    if (components.length === 0) return [{ ...line, parentLineKey: line.lineKey }];
    return components.map(component => ({
      lineKey: componentLineKey(line.lineKey, component.sequence),
      parentLineKey: line.lineKey,
      component,
      quantity: number(line.quantity) * number(component.quantity),
      finishedGood: virtualFinishedGood(component, storeId),
      addOns: [],
    }));
  });
}

export function summarizeParentInventory(input: {
  parentLineKey: string;
  expandedLines: ExpandedInventoryLine[];
  perLineCogs: Record<string, number>;
  perLineConsumptionStatus: Record<string, 'APPLIED' | 'PENDING_BOM' | 'NOT_REQUIRED'>;
}) {
  const relevant = input.expandedLines.filter(line => line.parentLineKey === input.parentLineKey);
  const cogsAmount = relevant.reduce((sum, line) => sum + number(input.perLineCogs[line.lineKey]), 0);
  const statuses = relevant.map(line => input.perLineConsumptionStatus[line.lineKey]).filter(Boolean);
  const inventoryConsumptionStatus = statuses.includes('PENDING_BOM')
    ? 'PENDING_BOM'
    : statuses.includes('APPLIED')
      ? 'APPLIED'
      : 'NOT_REQUIRED';
  return { cogsAmount, inventoryConsumptionStatus } as const;
}

export function buildKotTasks(line: {
  quantity: number;
  finishedGood?: Pick<FinishedGood, 'code' | 'name' | 'displayName' | 'prepStation'>;
  prepStation?: PrepStation;
  itemName?: string;
  itemCode?: string;
  components?: CanonicalCompositeComponent[];
}): CompositeKotTask[] {
  const components = Array.isArray(line.components) ? line.components : [];
  if (components.length === 0) {
    const prepStation = station(line.finishedGood?.prepStation || line.prepStation);
    const stations: Array<'BARISTA' | 'KITCHEN'> = prepStation === 'BOTH'
      ? ['BARISTA', 'KITCHEN']
      : prepStation === 'NONE' ? [] : [prepStation];
    return stations.map(kotStation => ({
      taskKey: kotStation,
      station: kotStation,
      itemName: line.finishedGood?.displayName || line.finishedGood?.name || line.itemName || '',
      itemCode: line.finishedGood?.code || line.itemCode || '',
      quantity: number(line.quantity),
      component: null,
    }));
  }

  return components.flatMap(component => {
    const prepStation = station(component.prepStation);
    const stations: Array<'BARISTA' | 'KITCHEN'> = prepStation === 'BOTH'
      ? ['BARISTA', 'KITCHEN']
      : prepStation === 'NONE' ? [] : [prepStation];
    return stations.map(kotStation => ({
      taskKey: `COMP_${String(component.sequence).padStart(3, '0')}_${kotStation}`,
      station: kotStation,
      itemName: component.componentName,
      itemCode: component.componentFinishedGoodCode,
      quantity: number(line.quantity) * number(component.quantity),
      component,
    }));
  });
}
