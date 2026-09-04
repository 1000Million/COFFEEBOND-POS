'use strict';

const { isDeepStrictEqual } = require('node:util');

/**
 * Pure, persistence-agnostic policy for one-level Finished Good composites.
 *
 * A parent opts in with:
 *   composite: { schemaVersion: 1, staticComponents: [...], choiceGroupIds: [...] }
 *
 * Choice groups continue to use the existing add-on transport, but must declare
 * purpose=COMPOSITE_CHOICE. Their options reference child Finished Goods through
 * finishedGoodComponent. Clients submit only group/option/quantity; every child
 * identity, preparation station and BOM below is resolved on the server when the
 * customer order is created, then retained as the order's immutable snapshot.
 */

const COMPOSITE_SCHEMA_VERSION = 1;
const COMPOSITE_CHOICE_PURPOSE = 'COMPOSITE_CHOICE';
const EXACT_DISTINCT_SELECTION_MODE = 'EXACT_DISTINCT';
const MAX_COMPONENTS = 40;
const MAX_COMPONENT_QUANTITY = 100;
const PREP_STATIONS = new Set(['BARISTA', 'KITCHEN', 'BOTH', 'NONE']);
const FINISHED_GOOD_ITEM_TYPES = new Set(['MADE_TO_ORDER', 'DIRECT_STOCK', 'NO_STOCK']);
const PRODUCTION_MODES = new Set(['MADE_TO_ORDER', 'ASSEMBLED_TO_ORDER', 'BOUGHT_AND_SOLD', 'NO_STOCK']);
const BOM_COMPONENT_TYPES = new Set([
  'RAW_INGREDIENT',
  'PREP_ITEM',
  'BOUGHT_COMPONENT',
  'FINISHED_GOOD',
  'PACKAGING',
]);

class CompositeProductPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompositeProductPolicyError';
    this.code = 'failed-precondition';
  }
}

function policyError(message) {
  throw new CompositeProductPolicyError(message);
}

/**
 * A store opts in to deferred-BOM composites by setting inventoryPolicy explicitly.
 *
 * Deliberately NOT routed through onlineOrderInventory's inventoryPolicy(), which falls
 * back to Golden I by store identity: a component BOM bypass must never be inherited from
 * a name or code, only from the field an operator actually set. Everything else about the
 * child — identity, availability, prep station, item type, BOM shape when one exists —
 * is still validated exactly as before.
 */
function allowsDeferredComponentBom(store) {
  return String(store?.inventoryPolicy || '').trim().toUpperCase() === 'ALLOW_NEGATIVE_DEFER_BOM';
}

function snapshotUsesBom(itemType, productionMode, bom) {
  return itemType === 'MADE_TO_ORDER'
    || productionMode === 'MADE_TO_ORDER'
    || productionMode === 'ASSEMBLED_TO_ORDER'
    || (itemType === 'DIRECT_STOCK' && bom.length > 0);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(entry => cleanText(entry, 80))
      .filter(Boolean),
  )];
}

function optionIdsByGroup(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([groupId, optionIds]) => [cleanText(groupId, 80), uniqueStrings(optionIds)])
      .filter(([groupId]) => groupId),
  );
}

function isCompositeProduct(product) {
  return isRecord(product?.composite);
}

function isCompositeChoiceGroup(group) {
  return group?.purpose === COMPOSITE_CHOICE_PURPOSE;
}

function componentReference(value, context) {
  if (!isRecord(value)) policyError(`${context} is missing its Finished Good reference.`);
  const finishedGoodId = cleanText(value.finishedGoodId, 120);
  const finishedGoodCode = cleanText(value.finishedGoodCode, 80);
  const quantity = finiteNumber(value.quantity);
  if (
    !finishedGoodId
    || !finishedGoodCode
    || !Number.isInteger(quantity)
    || quantity <= 0
    || quantity > MAX_COMPONENT_QUANTITY
  ) {
    policyError(`${context} has an invalid Finished Good reference.`);
  }
  return { finishedGoodId, finishedGoodCode, quantity };
}

function compositeDefinition(product, groupsById) {
  const configuredProductGroupIds = uniqueStrings(product?.addOnGroupIds);
  const assignedCompositeGroupIds = configuredProductGroupIds.filter(groupId => (
    isCompositeChoiceGroup(groupsById?.[groupId])
  ));
  if (!isCompositeProduct(product)) {
    if (assignedCompositeGroupIds.length > 0) {
      policyError('A product with component choices must declare a composite definition.');
    }
    return null;
  }
  const definition = product.composite;
  if (
    Array.isArray(product.unresolvedCompositeRequirements)
    && product.unresolvedCompositeRequirements.length > 0
  ) {
    policyError('This composite product still has unresolved component requirements.');
  }
  if (Number(definition.schemaVersion) !== COMPOSITE_SCHEMA_VERSION) {
    policyError('This composite product uses an unsupported component schema.');
  }
  if (!Array.isArray(definition.staticComponents) || !Array.isArray(definition.choiceGroupIds)) {
    policyError('This composite product has an incomplete component definition.');
  }

  const parentId = cleanText(product.id, 120);
  const parentCode = cleanText(product.code, 80);
  const staticComponents = definition.staticComponents.map((entry, index) => (
    componentReference(entry, `Static component ${index + 1}`)
  ));
  const staticIds = new Set();
  for (const component of staticComponents) {
    if (component.finishedGoodId === parentId || component.finishedGoodCode === parentCode) {
      policyError('A composite product cannot contain itself.');
    }
    if (staticIds.has(component.finishedGoodId)) {
      policyError('Repeated static components must use one reference with the required quantity.');
    }
    staticIds.add(component.finishedGoodId);
  }

  const rawChoiceGroupIds = definition.choiceGroupIds
    .map(groupId => cleanText(groupId, 80))
    .filter(Boolean);
  const choiceGroupIds = uniqueStrings(rawChoiceGroupIds);
  if (choiceGroupIds.length !== rawChoiceGroupIds.length) {
    policyError('A composite product cannot repeat a choice group.');
  }
  const configuredProductGroupIdSet = new Set(configuredProductGroupIds);
  const allowedOptionIdsByGroup = optionIdsByGroup(product.addOnOptionIdsByGroup);
  if (
    assignedCompositeGroupIds.length !== choiceGroupIds.length
    || assignedCompositeGroupIds.some(groupId => !choiceGroupIds.includes(groupId))
  ) {
    policyError('Composite choice groups must exactly match the parent component definition.');
  }
  if (configuredProductGroupIds.length !== assignedCompositeGroupIds.length) {
    policyError('Composite products cannot mix component choices with ordinary add-ons.');
  }
  const choiceGroups = choiceGroupIds.map(groupId => {
    if (!configuredProductGroupIdSet.has(groupId)) {
      policyError('A composite choice group is not assigned to its parent product.');
    }
    const group = groupsById?.[groupId];
    if (!group || group.isActive !== true || !isCompositeChoiceGroup(group)) {
      policyError('A composite choice group is inactive, missing, or has the wrong purpose.');
    }
    const allowedOptionIds = allowedOptionIdsByGroup[groupId] || [];
    if (allowedOptionIds.length === 0) {
      policyError('A composite choice group has no enabled options for this product.');
    }
    const optionsById = new Map(
      (Array.isArray(group.options) ? group.options : [])
        .map(option => [cleanText(option?.id, 80), option])
        .filter(([optionId]) => optionId),
    );
    const allowedOptions = allowedOptionIds.map(optionId => {
      const option = optionsById.get(optionId);
      if (!option || option.isActive !== true) {
        policyError('A composite choice option is inactive or missing.');
      }
      return {
        option,
        reference: componentReference(
          option.finishedGoodComponent,
          `Choice ${cleanText(option.name, 120) || optionId}`,
        ),
      };
    });
    if (group.selectionMode === EXACT_DISTINCT_SELECTION_MODE) {
      const componentIds = allowedOptions.map(entry => entry.reference.finishedGoodId);
      if (new Set(componentIds).size !== componentIds.length) {
        policyError('Exact-distinct options must reference different Finished Goods.');
      }
    }
    return { groupId, group, allowedOptionIds, allowedOptions };
  });

  if (staticComponents.length + choiceGroups.length === 0) {
    policyError('A composite product must define at least one component or choice group.');
  }
  if (staticComponents.length + choiceGroups.reduce((sum, entry) => sum + entry.allowedOptions.length, 0) > MAX_COMPONENTS) {
    policyError('This composite product has too many configured components.');
  }
  return { staticComponents, choiceGroups };
}

/**
 * Returns every possible child doc ID needed to canonicalize the supplied parents.
 * Callers can transaction-read these documents and pass the resulting map to the
 * resolver. Ordinary products return no IDs and retain their previous read set.
 */
function collectRequiredComponentFinishedGoodIds({ products, groupsById }) {
  const values = Array.isArray(products)
    ? products
    : Object.values(products || {});
  const ids = [];
  const seen = new Set();
  for (const product of values) {
    const definition = compositeDefinition(product, groupsById);
    if (!definition) continue;
    const references = [
      ...definition.staticComponents,
      ...definition.choiceGroups.flatMap(entry => entry.allowedOptions.map(option => option.reference)),
    ];
    for (const reference of references) {
      if (seen.has(reference.finishedGoodId)) continue;
      seen.add(reference.finishedGoodId);
      ids.push(reference.finishedGoodId);
    }
  }
  return ids;
}

function sanitizeBomLine(line, index, childName) {
  if (!isRecord(line)) policyError(`${childName} has an invalid BOM line ${index + 1}.`);
  const componentType = cleanText(line.componentType, 40);
  const componentStockType = cleanText(line.componentStockType, 40);
  const componentCode = cleanText(line.componentCode, 80);
  const componentName = cleanText(line.componentName, 160);
  const quantity = finiteNumber(line.quantity);
  const uom = cleanText(line.uom, 20);
  if (!BOM_COMPONENT_TYPES.has(componentType) || !componentCode || quantity <= 0 || !uom) {
    policyError(`${childName} has an incomplete BOM line ${index + 1}.`);
  }
  const copyStringArray = value => (Array.isArray(value)
    ? value.map(entry => cleanText(entry, 30)).filter(Boolean)
    : undefined);
  const packagingApplicability = Array.isArray(line.packagingApplicability)
    ? copyStringArray(line.packagingApplicability)
    : cleanText(line.packagingApplicability, 30) || undefined;
  return {
    componentType,
    ...(componentStockType ? { componentStockType } : {}),
    componentCode,
    componentName,
    quantity,
    uom,
    ...(copyStringArray(line.applicableOrderTypes)?.length
      ? { applicableOrderTypes: copyStringArray(line.applicableOrderTypes) }
      : {}),
    ...(packagingApplicability
      ? { packagingApplicability }
      : {}),
    ...(copyStringArray(line.orderTypes)?.length
      ? { orderTypes: copyStringArray(line.orderTypes) }
      : {}),
    ...(copyStringArray(line.serviceTypes)?.length
      ? { serviceTypes: copyStringArray(line.serviceTypes) }
      : {}),
  };
}

function canonicalChildSnapshot({
  reference,
  componentProductsById,
  storeId,
  source,
  provenance,
  sequence,
  allowDeferredComponentBom = false,
}) {
  const child = componentProductsById?.[reference.finishedGoodId];
  if (!child) policyError('A composite component Finished Good is missing.');
  const childId = cleanText(child.id || reference.finishedGoodId, 120);
  const childCode = cleanText(child.code, 80);
  const childName = cleanText(child.displayName || child.name || childCode, 160);
  if (childId !== reference.finishedGoodId || childCode !== reference.finishedGoodCode) {
    policyError('A composite component Finished Good reference changed.');
  }
  if (
    child.isActive !== true
    || child.isAvailable === false
    || !Array.isArray(child.availableStoreIds)
    || !child.availableStoreIds.includes(storeId)
  ) {
    policyError(`${childName || 'A composite component'} is unavailable at this store.`);
  }
  if (isCompositeProduct(child)) {
    policyError('Nested composite products are not supported.');
  }
  const prepStation = cleanText(child.prepStation, 20).toUpperCase();
  if (!PREP_STATIONS.has(prepStation)) {
    policyError(`${childName || 'A composite component'} has no valid preparation station.`);
  }
  const itemType = cleanText(child.itemType, 40).toUpperCase();
  const productionMode = cleanText(child.productionMode, 40).toUpperCase();
  if (!FINISHED_GOOD_ITEM_TYPES.has(itemType)) {
    policyError(`${childName || 'A composite component'} has no valid item type.`);
  }
  if (productionMode && !PRODUCTION_MODES.has(productionMode)) {
    policyError(`${childName || 'A composite component'} has no valid production mode.`);
  }
  if (child.bom !== undefined && child.bom !== null && !Array.isArray(child.bom)) {
    policyError(`${childName || 'A composite component'} has an invalid BOM.`);
  }
  const bom = (Array.isArray(child.bom) ? child.bom : [])
    .map((line, index) => sanitizeBomLine(line, index, childName || childCode));
  const usesBom = snapshotUsesBom(itemType, productionMode, bom);
  /* An empty BOM is a missing recipe, not a malformed one. For a store that has explicitly
     opted in to ALLOW_NEGATIVE_DEFER_BOM the sale is commercially valid and inventory is
     reconciled later, so the component resolves carrying a deferral marker and
     onlineOrderInventory turns it into a PENDING_BOM record. Every other store still
     fails closed here. A BOM that EXISTS but is malformed has already thrown in
     sanitizeBomLine above and can never reach this branch. */
  const bomDeferred = usesBom && bom.length === 0;
  if (bomDeferred && !allowDeferredComponentBom) {
    policyError(`${childName || 'A composite component'} has no authoritative BOM.`);
  }
  const bomVersion = Number.isInteger(Number(child.bomVersion))
    ? Number(child.bomVersion)
    : null;
  return {
    sequence,
    source,
    ...provenance,
    componentFinishedGoodId: childId,
    componentFinishedGoodCode: childCode,
    componentName: childName,
    quantity: reference.quantity,
    prepStation,
    itemType,
    productionMode: productionMode || null,
    bom,
    bomVersion,
    // Only a genuinely missing/empty recipe can carry this marker.
    ...(bomDeferred ? { bomStatus: 'PENDING_BOM' } : {}),
  };
}

/**
 * Collects child ids from an already-created server snapshot. This deliberately does
 * not inspect the current parent composite definition: historical orders must keep the
 * component meaning that was frozen when the order was created.
 */
function collectFrozenComponentFinishedGoodIds(items) {
  const ids = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.components === undefined) continue;
    if (!Array.isArray(item.components) || item.components.length === 0 || item.components.length > MAX_COMPONENTS) {
      policyError('A stored composite component snapshot is malformed.');
    }
    for (const component of item.components) {
      if (!isRecord(component)) policyError('A stored composite component snapshot is malformed.');
      const childId = cleanText(component.componentFinishedGoodId, 120);
      if (!childId) policyError('A stored composite component identity is missing.');
      if (seen.has(childId)) continue;
      seen.add(childId);
      ids.push(childId);
    }
  }
  return ids;
}

/**
 * Validates a frozen component snapshot without rebuilding it from today's menu.
 * Only operational compatibility is checked against current child documents: the child
 * must still exist, retain its identity, and remain manually available at the store.
 * Preparation, production and BOM data continue to come from the immutable snapshot.
 */
function validateFrozenCanonicalCompositeComponents({
  components,
  componentProductsById,
  store,
  storeId,
}) {
  if (!Array.isArray(components) || components.length === 0 || components.length > MAX_COMPONENTS) {
    policyError('A stored composite component snapshot is malformed.');
  }

  return components.map((component, index) => {
    if (!isRecord(component)) policyError('A stored composite component snapshot is malformed.');
    const sequence = Number(component.sequence);
    const source = cleanText(component.source, 20).toUpperCase();
    const componentFinishedGoodId = cleanText(component.componentFinishedGoodId, 120);
    const componentFinishedGoodCode = cleanText(component.componentFinishedGoodCode, 80);
    const componentName = cleanText(component.componentName, 160);
    const quantity = Number(component.quantity);
    const prepStation = cleanText(component.prepStation, 20).toUpperCase();
    const itemType = cleanText(component.itemType, 40).toUpperCase();
    const productionMode = cleanText(component.productionMode, 40).toUpperCase();

    if (
      sequence !== index + 1
      || !['STATIC', 'CHOICE'].includes(source)
      || !componentFinishedGoodId
      || !componentFinishedGoodCode
      || !componentName
      || !Number.isInteger(quantity)
      || quantity <= 0
      || quantity > MAX_COMPONENT_QUANTITY
      || !PREP_STATIONS.has(prepStation)
      || !FINISHED_GOOD_ITEM_TYPES.has(itemType)
      || (productionMode && !PRODUCTION_MODES.has(productionMode))
      || !Array.isArray(component.bom)
    ) {
      policyError('A stored composite component snapshot is malformed.');
    }

    const currentChild = componentProductsById?.[componentFinishedGoodId];
    const currentChildId = cleanText(currentChild?.id || componentFinishedGoodId, 120);
    const currentChildCode = cleanText(currentChild?.code, 80);
    if (!currentChild || currentChildId !== componentFinishedGoodId || currentChildCode !== componentFinishedGoodCode) {
      policyError('A composite component Finished Good is missing or changed.');
    }
    if (
      currentChild.isActive !== true
      || currentChild.isAvailable === false
      || !Array.isArray(currentChild.availableStoreIds)
      || !currentChild.availableStoreIds.includes(storeId)
    ) {
      policyError(`${componentName} is unavailable at this store.`);
    }

    const bom = component.bom.map((line, bomIndex) => (
      sanitizeBomLine(line, bomIndex, componentName)
    ));
    const bomVersion = component.bomVersion === null
      ? null
      : Number.isInteger(Number(component.bomVersion)) ? Number(component.bomVersion) : NaN;
    if (Number.isNaN(bomVersion)) policyError('A stored composite BOM version is malformed.');
    const bomStatus = cleanText(component.bomStatus, 40).toUpperCase();
    const bomDeferred = snapshotUsesBom(itemType, productionMode, bom) && bom.length === 0;
    if (bomDeferred && (!allowsDeferredComponentBom(store) || bomStatus !== 'PENDING_BOM')) {
      policyError(`${componentName} has no authoritative BOM.`);
    }
    if (!bomDeferred && bomStatus) {
      policyError('A stored composite BOM status is malformed.');
    }

    const provenance = source === 'CHOICE' ? {
      groupId: cleanText(component.groupId, 80),
      groupName: cleanText(component.groupName, 120),
      optionId: cleanText(component.optionId, 80),
      optionName: cleanText(component.optionName, 120),
    } : {};
    if (source === 'CHOICE' && (!provenance.groupId || !provenance.optionId)) {
      policyError('A stored composite choice provenance is malformed.');
    }

    const canonical = {
      sequence,
      source,
      ...provenance,
      componentFinishedGoodId,
      componentFinishedGoodCode,
      componentName,
      quantity,
      prepStation,
      itemType,
      productionMode: productionMode || null,
      bom,
      bomVersion,
      ...(bomDeferred ? { bomStatus: 'PENDING_BOM' } : {}),
    };
    if (!isDeepStrictEqual(component, canonical)) {
      policyError('A stored composite component snapshot is malformed.');
    }
    return canonical;
  });
}

function selectionBounds(group) {
  const minimum = Math.max(0, finiteNumber(group.minimumSelections));
  const maximum = group.maximumSelections === null || group.maximumSelections === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(minimum, finiteNumber(group.maximumSelections));
  return { minimum, maximum };
}

/**
 * Builds the immutable order-line component snapshot. `requestedSelections` is
 * identifier-only client input that has already passed general add-on sanitation;
 * this function still enforces every composite-specific rule independently.
 */
function resolveCanonicalCompositeComponents({
  parentProduct,
  requestedSelections,
  groupsById,
  componentProductsById,
  storeId,
  /* Defaults to false so every existing caller — including the direct callers in the test
     suite — keeps the strict behaviour unless a store has explicitly opted in. */
  allowDeferredComponentBom = false,
}) {
  const definition = compositeDefinition(parentProduct, groupsById);
  if (!definition) return [];
  const requested = Array.isArray(requestedSelections) ? requestedSelections : [];
  const selectionsByGroup = new Map();
  for (const selection of requested) {
    const groupId = cleanText(selection?.groupId, 80);
    if (!definition.choiceGroups.some(entry => entry.groupId === groupId)) continue;
    const optionId = cleanText(selection?.optionId, 80);
    const quantity = Number(selection?.quantity);
    if (!optionId || !Number.isInteger(quantity) || quantity <= 0) {
      policyError('A composite choice is invalid.');
    }
    if (!selectionsByGroup.has(groupId)) selectionsByGroup.set(groupId, []);
    selectionsByGroup.get(groupId).push({ optionId, quantity });
  }

  const snapshots = [];
  let sequence = 1;
  for (const reference of definition.staticComponents) {
    snapshots.push(canonicalChildSnapshot({
      reference,
      componentProductsById,
      storeId,
      source: 'STATIC',
      provenance: {},
      sequence: sequence++,
      allowDeferredComponentBom,
    }));
  }

  for (const { groupId, group, allowedOptionIds, allowedOptions } of definition.choiceGroups) {
    const selected = selectionsByGroup.get(groupId) || [];
    const { minimum, maximum } = selectionBounds(group);
    const selectionMode = cleanText(group.selectionMode, 40).toUpperCase();
    if (![EXACT_DISTINCT_SELECTION_MODE, 'SINGLE'].includes(selectionMode)) {
      policyError('Composite choice groups must be SINGLE or EXACT_DISTINCT.');
    }
    if (
      selectionMode === EXACT_DISTINCT_SELECTION_MODE
      && (!Number.isInteger(minimum) || minimum <= 0 || maximum !== minimum)
    ) {
      policyError('An exact-distinct choice group must declare one exact positive selection count.');
    }
    if (selected.some(selection => selection.quantity !== 1)) {
      policyError('Composite choices cannot repeat one option as a quantity.');
    }
    const selectedIds = selected.map(selection => selection.optionId);
    if (new Set(selectedIds).size !== selectedIds.length) {
      policyError('Composite choices must be distinct.');
    }
    if (selectionMode === 'SINGLE' && selected.length > 1) {
      policyError('Choose only one option from this composite choice group.');
    }
    if (selected.length < minimum || selected.length > maximum) {
      policyError(`Selected components for ${cleanText(group.name, 120) || 'this item'} are invalid.`);
    }
    if (selected.some(selection => !allowedOptionIds.includes(selection.optionId))) {
      policyError('A selected composite component is not enabled for this product.');
    }

    const selectedSet = new Set(selectedIds);
    for (const { option, reference } of allowedOptions) {
      if (!selectedSet.has(cleanText(option.id, 80))) continue;
      snapshots.push(canonicalChildSnapshot({
        reference,
        componentProductsById,
        storeId,
        source: 'CHOICE',
        provenance: {
          groupId,
          groupName: cleanText(group.name, 120),
          optionId: cleanText(option.id, 80),
          optionName: cleanText(option.name, 120),
        },
        sequence: sequence++,
        allowDeferredComponentBom,
      }));
    }
  }

  if (snapshots.length === 0) policyError('This composite product resolved no components.');
  return snapshots;
}

module.exports = {
  COMPOSITE_CHOICE_PURPOSE,
  COMPOSITE_SCHEMA_VERSION,
  CompositeProductPolicyError,
  EXACT_DISTINCT_SELECTION_MODE,
  allowsDeferredComponentBom,
  collectFrozenComponentFinishedGoodIds,
  collectRequiredComponentFinishedGoodIds,
  isCompositeChoiceGroup,
  isCompositeProduct,
  resolveCanonicalCompositeComponents,
  validateFrozenCanonicalCompositeComponents,
};
