'use strict';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function station(value) {
  const normalized = String(value || 'NONE').trim().toUpperCase();
  return ['BARISTA', 'KITCHEN', 'BOTH'].includes(normalized) ? normalized : 'NONE';
}

function componentLineKey(parentLineKey, sequence) {
  return `${parentLineKey}__COMP_${String(sequence).padStart(3, '0')}`;
}

function virtualFinishedGood(component, storeId) {
  return {
    id: component.componentFinishedGoodId,
    code: component.componentFinishedGoodCode,
    name: component.componentName,
    displayName: component.componentName,
    itemType: component.itemType,
    productionMode: component.productionMode,
    prepStation: component.prepStation,
    bom: Array.isArray(component.bom) ? component.bom : [],
    bomVersion: component.bomVersion,
    availableStoreIds: [storeId],
    isActive: true,
    isSellable: true,
    isAvailable: true,
  };
}

function expandCompositeInventoryLines(lines, storeId) {
  return lines.flatMap(line => {
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

function summarizeParentInventory({ parentLineKey, expandedLines, perLineCogs, perLineConsumptionStatus }) {
  const relevant = expandedLines.filter(line => line.parentLineKey === parentLineKey);
  const cogsAmount = relevant.reduce((sum, line) => sum + number(perLineCogs?.[line.lineKey]), 0);
  const statuses = relevant.map(line => perLineConsumptionStatus?.[line.lineKey]).filter(Boolean);
  const inventoryConsumptionStatus = statuses.includes('PENDING_BOM')
    ? 'PENDING_BOM'
    : statuses.includes('APPLIED')
      ? 'APPLIED'
      : 'NOT_REQUIRED';
  return { cogsAmount, inventoryConsumptionStatus };
}

function buildKotTasks(line) {
  const components = Array.isArray(line.components) ? line.components : [];
  if (components.length === 0) {
    const prepStation = station(line.finishedGood?.prepStation || line.prepStation);
    const stations = prepStation === 'BOTH' ? ['BARISTA', 'KITCHEN'] : prepStation === 'NONE' ? [] : [prepStation];
    return stations.map(kotStation => ({
      taskKey: kotStation,
      station: kotStation,
      itemName: line.finishedGood?.displayName || line.finishedGood?.name || line.itemName,
      itemCode: line.finishedGood?.code || line.itemCode,
      quantity: number(line.quantity),
      component: null,
    }));
  }

  return components.flatMap(component => {
    const prepStation = station(component.prepStation);
    const stations = prepStation === 'BOTH' ? ['BARISTA', 'KITCHEN'] : prepStation === 'NONE' ? [] : [prepStation];
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

module.exports = {
  buildKotTasks,
  componentLineKey,
  expandCompositeInventoryLines,
  summarizeParentInventory,
};
