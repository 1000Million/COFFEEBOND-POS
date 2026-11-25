import crypto from 'node:crypto';

export const PRODUCT_ADD_ON_PROJECT_ID = 'coffee-bond-pos';
export const PRODUCT_ADD_ON_CONFIRMATION_FLAG = '--confirm-product-addon-controls';

export function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter(entry => typeof entry === 'string' && entry.trim())
      .map(entry => entry.trim()),
  )].sort();
}

export function normalizeOptionIdsByGroup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([groupId, optionIds]) => [groupId.trim(), uniqueStrings(optionIds)])
      .filter(([groupId]) => groupId),
  );
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sameMap(left, right) {
  return stableStringify(normalizeOptionIdsByGroup(left)) === stableStringify(normalizeOptionIdsByGroup(right));
}

export function buildProductAddOnControlsPlan({ finishedGoodDocs, addOnGroupDocs }) {
  const groupsById = new Map(addOnGroupDocs.map(document => [
    document.id,
    { id: document.id, ...document.data },
  ]));
  const rows = [];
  const documentUpdates = [];
  const auditEntries = [];
  const blockers = [];

  const products = finishedGoodDocs
    .map(document => ({ id: document.id, ...document.data }))
    .filter(product => uniqueStrings(product.addOnGroupIds).length > 0)
    .sort((left, right) => String(left.code || left.id).localeCompare(String(right.code || right.id)));

  for (const product of products) {
    const beforeMap = normalizeOptionIdsByGroup(product.addOnOptionIdsByGroup);
    const afterMap = { ...beforeMap };
    const backfilledGroups = [];

    for (const groupId of uniqueStrings(product.addOnGroupIds)) {
      const group = groupsById.get(groupId);
      if (!group) {
        blockers.push({
          productPath: `finishedGoods/${product.id}`,
          productCode: product.code || product.id,
          groupId,
          reason: 'ASSIGNED_ADD_ON_GROUP_NOT_FOUND',
        });
        continue;
      }
      const activeOptionIds = group.isActive === false
        ? []
        : uniqueStrings((group.options || [])
          .filter(option => option && option.isActive !== false)
          .map(option => option.id || option.code));
      const hasExplicitAllowlist = Object.prototype.hasOwnProperty.call(beforeMap, groupId);
      const previousOptionIds = beforeMap[groupId] || [];
      const proposedOptionIds = hasExplicitAllowlist ? previousOptionIds : activeOptionIds;
      afterMap[groupId] = proposedOptionIds;
      if (!hasExplicitAllowlist) backfilledGroups.push(groupId);

      rows.push({
        productPath: `finishedGoods/${product.id}`,
        productId: product.id,
        productCode: product.code || product.id,
        productName: product.name || product.displayName || product.code || product.id,
        groupId,
        groupName: group.name || groupId,
        previousOptionIds,
        proposedOptionIds,
        action: hasExplicitAllowlist ? 'KEEP_EXPLICIT_ALLOWLIST' : 'BACKFILL_ACTIVE_OPTIONS',
        reason: hasExplicitAllowlist
          ? 'Existing product-specific allowlist is preserved.'
          : 'Backward-compatible migration enables every currently active option in the assigned group.',
      });
    }

    if (!sameMap(beforeMap, afterMap)) {
      documentUpdates.push({
        targetPath: `finishedGoods/${product.id}`,
        productId: product.id,
        productCode: product.code || product.id,
        beforeAddOnOptionIdsByGroup: beforeMap,
        afterAddOnOptionIdsByGroup: normalizeOptionIdsByGroup(afterMap),
      });
      backfilledGroups.forEach(groupId => {
        auditEntries.push({
          productId: product.id,
          productCode: product.code || product.id,
          groupId,
          previousOptionIds: beforeMap[groupId] || [],
          newOptionIds: afterMap[groupId] || [],
          reason: 'Backward-compatible product add-on option allowlist migration.',
        });
      });
    }
  }

  const checksumPayload = {
    projectId: PRODUCT_ADD_ON_PROJECT_ID,
    documentUpdates,
    auditEntries,
    blockers,
  };
  const dryRunChecksum = sha256(checksumPayload);

  return {
    projectId: PRODUCT_ADD_ON_PROJECT_ID,
    dryRunChecksum,
    applyReadiness: blockers.length === 0 ? 'READY' : 'BLOCKED',
    rows,
    documentUpdates,
    auditEntries,
    blockers,
    counts: {
      assignedProductsReviewed: products.length,
      assignedProductGroupsReviewed: rows.length,
      productsToUpdate: documentUpdates.length,
      allowlistsToBackfill: auditEntries.length,
      productDocumentsToWrite: documentUpdates.length,
      auditDocumentsToCreate: auditEntries.length,
      firstApplyFirestoreWrites: documentUpdates.length + auditEntries.length,
      blockers: blockers.length,
    },
  };
}

