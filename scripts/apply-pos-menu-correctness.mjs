#!/usr/bin/env node
/**
 * Checksum-gated, precondition-verified apply tool for the approved Golden I
 * menu corrections (Batch 1).
 *
 * This tool is dry-run unless ALL THREE gates are supplied:
 *   --apply
 *   --checksum <exact dry-run checksum>
 *   --confirm "APPLY GOLDEN I MENU CORRECTIONS"
 *
 * It writes to exactly three documents, only on the approved field paths, inside
 * a single Firestore transaction whose reads double as preconditions. It touches
 * no order, payment, KOT, stock, store or category-master path.
 */
import process from 'node:process';
import {
  AUTHORITATIVE_PROTEIN_CODE,
  GOLDEN_I_STORE_ID,
  LEGACY_PROTEIN_CODE,
  MEZZE_CODE,
  PROJECT_ID,
  TEMPORARY_PROTEIN_CODE,
  buildPosMenuCorrectnessPlan,
  readPosMenuCorrectnessInput,
} from './pos-menu-correctness-plan.mjs';

export const CONFIRM_PHRASE = 'APPLY GOLDEN I MENU CORRECTIONS';

/**
 * The only document paths this tool may ever write.
 *
 * finishedGoods/36_GM_PROTEIN_POWER is on this list under the owner's revised
 * approval, and only for the narrow removal of GOLDEN_I from availableStoreIds.
 * The document is never deleted and never globally deactivated.
 */
export const ALLOWED_WRITE_PATHS = [
  `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`,
  `finishedGoods/${TEMPORARY_PROTEIN_CODE}`,
  `finishedGoods/${MEZZE_CODE}`,
  `publicMenuAvailability/${GOLDEN_I_STORE_ID}`,
];

/** Documents that are explicitly out of scope and must never be written. */
export const FORBIDDEN_WRITE_PATHS = [
  `menuItems/${LEGACY_PROTEIN_CODE}`,
];

/** The duplicate may only ever have this one field touched. */
export const TEMPORARY_PROTEIN_ALLOWED_FIELDS = ['availableStoreIds'];

export const EXPECTED_OPERATION_COUNT = 4;

/** Collections this batch must never touch. */
export const FORBIDDEN_COLLECTIONS = [
  'orders',
  'payments',
  'kots',
  'kitchenOrderTickets',
  'stockMovements',
  'storeStock',
  'stores',
  'posCategories',
  'addOnGroups',
  'menuItems',
];

export function parseApplyArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const valueFor = (name) => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('--')) {
      return args[index + 1];
    }
    return null;
  };

  const apply = args.includes('--apply');
  const checksum = valueFor('--checksum');
  const confirm = valueFor('--confirm');

  const reasons = [];
  if (!apply) reasons.push('--apply flag is absent.');
  if (!checksum) reasons.push('--checksum <expected checksum> is required.');
  if (confirm === null) reasons.push(`--confirm "${CONFIRM_PHRASE}" is required.`);
  else if (confirm !== CONFIRM_PHRASE) reasons.push('Confirmation phrase does not match exactly.');

  return {
    apply,
    checksum,
    confirm,
    gatesSatisfied: reasons.length === 0,
    reasons,
  };
}

function getByPath(data, fieldPath) {
  const segments = String(fieldPath).split('.');
  let cursor = data;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function normalize(value) {
  return value === undefined ? null : value;
}

function deepEqual(a, b) {
  return JSON.stringify(normalize(a) ?? null) === JSON.stringify(normalize(b) ?? null);
}

/**
 * Confirms that every operation targets an approved document and that nothing
 * out of scope crept into the plan.
 */
export function verifyPlanScope(plan) {
  const failures = [];

  if (plan.status !== 'READY_FOR_OWNER_APPROVAL') {
    failures.push(`Plan status is ${plan.status}; only READY_FOR_OWNER_APPROVAL may be applied.`);
  }
  if (plan.projectId !== PROJECT_ID) {
    failures.push(`Plan targets project ${plan.projectId}, expected ${PROJECT_ID}.`);
  }
  if (plan.operations.length !== EXPECTED_OPERATION_COUNT) {
    failures.push(`Plan must contain exactly ${EXPECTED_OPERATION_COUNT} operations, found ${plan.operations.length}.`);
  }
  if (plan.proposedWriteCount !== plan.operations.length) {
    failures.push('proposedWriteCount does not match the operation list.');
  }

  const seen = new Set();
  for (const operation of plan.operations) {
    if (!ALLOWED_WRITE_PATHS.includes(operation.path)) {
      failures.push(`Operation targets a non-approved document: ${operation.path}`);
    }
    if (FORBIDDEN_WRITE_PATHS.includes(operation.path)) {
      failures.push(`Operation targets an explicitly forbidden document: ${operation.path}`);
    }
    const collection = String(operation.path).split('/')[0];
    if (FORBIDDEN_COLLECTIONS.includes(collection)) {
      failures.push(`Operation targets a forbidden collection: ${collection}`);
    }
    if (seen.has(operation.path)) {
      failures.push(`Duplicate operation for ${operation.path}.`);
    }
    seen.add(operation.path);
    if (operation.type !== 'update') {
      failures.push(`Only update operations are permitted, found ${operation.type}.`);
    }
    if (!Array.isArray(operation.fieldPaths) || operation.fieldPaths.length === 0) {
      failures.push(`Operation for ${operation.path} declares no field paths.`);
    }
    if (operation.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`) {
      const illegal = (operation.fieldPaths || []).filter((field) => !TEMPORARY_PROTEIN_ALLOWED_FIELDS.includes(field));
      if (illegal.length > 0) {
        failures.push(`The temporary duplicate may only have ${TEMPORARY_PROTEIN_ALLOWED_FIELDS.join(', ')} changed; found ${illegal.join(', ')}.`);
      }
      const after = operation.after.availableStoreIds;
      const before = operation.before.availableStoreIds;
      if (!Array.isArray(after) || !Array.isArray(before)) {
        failures.push('The temporary duplicate operation must carry availableStoreIds arrays.');
      } else {
        const removed = before.filter((storeId) => !after.includes(storeId));
        if (removed.length !== 1 || removed[0] !== GOLDEN_I_STORE_ID) {
          failures.push(`Only GOLDEN_I may be removed from the duplicate; this plan removes ${removed.join(', ') || 'nothing'}.`);
        }
        if (after.some((storeId) => !before.includes(storeId))) {
          failures.push('The duplicate operation must not add any store assignment.');
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Compares the plan's recorded before-state against documents read inside the
 * transaction. Any drift aborts the whole apply.
 */
export function verifyPreconditions(plan, currentDocuments) {
  const failures = [];

  for (const operation of plan.operations) {
    const current = currentDocuments[operation.path];
    if (current === undefined || current === null) {
      failures.push(`${operation.path} was not found at apply time.`);
      continue;
    }
    for (const [fieldPath, expected] of Object.entries(operation.before)) {
      const actual = getByPath(current, fieldPath);
      if (!deepEqual(actual, expected)) {
        failures.push(
          `${operation.path} precondition drift on ${fieldPath}: expected ${JSON.stringify(normalize(expected))}, found ${JSON.stringify(normalize(actual))}.`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

export function verifyChecksum(plan, expectedChecksum) {
  const failures = [];
  if (!expectedChecksum) {
    failures.push('No expected checksum supplied.');
  } else if (plan.checksum !== expectedChecksum) {
    failures.push(`Checksum mismatch. Plan is ${plan.checksum}, operator supplied ${expectedChecksum}. The live data changed since the dry run; re-run the dry run and re-approve.`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Flattens the plan into per-document dotted-field updates. Only field paths
 * declared by the operation are emitted, so unrelated fields are preserved.
 */
export function isDeleteSentinel(value) {
  return Boolean(value) && typeof value === 'object' && value.$delete === true;
}

export function buildTransactionWrites(plan, deleteValue = '__DELETE__') {
  return plan.operations.map((operation) => {
    const updates = {};
    for (const fieldPath of operation.fieldPaths) {
      if (!(fieldPath in operation.after)) {
        throw new Error(`Operation for ${operation.path} declares field path ${fieldPath} with no after-value.`);
      }
      const value = operation.after[fieldPath];
      updates[fieldPath] = isDeleteSentinel(value) ? deleteValue : value;
    }
    return { path: operation.path, updates };
  });
}

/**
 * Post-apply verification. Given the documents as they stand after a future
 * approved run, plus the plan that was applied, this confirms every acceptance
 * criterion for Batch 1 and that nothing out of scope moved.
 *
 * `beforeDocuments` is the pre-apply state, used to prove unrelated fields and
 * unrelated snapshot entries are unchanged field-for-field.
 */
export function verifyPostApply(plan, afterDocuments, beforeDocuments) {
  const checks = [];
  const record = (name, passed, detail) => checks.push({ name, passed, detail });

  const proteinPath = `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`;
  const mezzePath = `finishedGoods/${MEZZE_CODE}`;
  const snapshotPath = `publicMenuAvailability/${GOLDEN_I_STORE_ID}`;

  const proteinAfter = afterDocuments[proteinPath] || {};
  const proteinBefore = beforeDocuments[proteinPath] || {};
  const mezzeAfter = afterDocuments[mezzePath] || {};
  const snapshotAfter = afterDocuments[snapshotPath] || {};
  const snapshotBefore = beforeDocuments[snapshotPath] || {};

  const storeIdsAfter = Array.isArray(proteinAfter.availableStoreIds) ? proteinAfter.availableStoreIds : [];
  const storeIdsBefore = Array.isArray(proteinBefore.availableStoreIds) ? proteinBefore.availableStoreIds : [];

  record(
    'GOLDEN_I added to authoritative Protein availableStoreIds',
    storeIdsAfter.includes(GOLDEN_I_STORE_ID),
    storeIdsAfter.join(', '),
  );
  record(
    'all previous store assignments preserved',
    storeIdsBefore.every((storeId) => storeIdsAfter.includes(storeId)),
    `before=${storeIdsBefore.length} after=${storeIdsAfter.length}`,
  );
  record(
    'no store assignment other than GOLDEN_I was added',
    storeIdsAfter.every((storeId) => storeIdsBefore.includes(storeId) || storeId === GOLDEN_I_STORE_ID),
    storeIdsAfter.join(', '),
  );
  record(
    'authoritative Protein is POS-visible at Golden I',
    proteinAfter.isActive !== false && proteinAfter.isSellable !== false
      && proteinAfter.isAvailable !== false && storeIdsAfter.includes(GOLDEN_I_STORE_ID),
    `isActive=${proteinAfter.isActive} isSellable=${proteinAfter.isSellable} isAvailable=${proteinAfter.isAvailable}`,
  );

  // Every field of the Finished Good other than availableStoreIds must be identical.
  const proteinDrift = [...new Set([...Object.keys(proteinBefore), ...Object.keys(proteinAfter)])]
    .filter((key) => key !== 'availableStoreIds')
    .filter((key) => !deepEqual(proteinBefore[key], proteinAfter[key]));
  record(
    'no other field changed on the authoritative Protein',
    proteinDrift.length === 0,
    proteinDrift.length ? `drifted: ${proteinDrift.join(', ')}` : 'none',
  );

  record(
    'no new duplicate product was created',
    Object.keys(afterDocuments)
      .filter((path) => path.startsWith('finishedGoods/'))
      .length === Object.keys(beforeDocuments).filter((path) => path.startsWith('finishedGoods/')).length,
    'finishedGoods document count unchanged',
  );

  // --- The temporary duplicate is withdrawn from Golden I, never destroyed ---
  const duplicatePath = `finishedGoods/${TEMPORARY_PROTEIN_CODE}`;
  const duplicateAfter = afterDocuments[duplicatePath];
  const duplicateBefore = beforeDocuments[duplicatePath] || {};
  const duplicateStoresAfter = Array.isArray(duplicateAfter?.availableStoreIds) ? duplicateAfter.availableStoreIds : [];
  const duplicateStoresBefore = Array.isArray(duplicateBefore.availableStoreIds) ? duplicateBefore.availableStoreIds : [];

  record(
    'duplicate document preserved, not deleted',
    Boolean(duplicateAfter),
    duplicateAfter ? 'document present' : 'MISSING',
  );
  record(
    'duplicate not globally deactivated',
    duplicateAfter?.isActive === duplicateBefore.isActive
      && duplicateAfter?.isSellable === duplicateBefore.isSellable
      && duplicateAfter?.isAvailable === duplicateBefore.isAvailable,
    `isActive=${duplicateAfter?.isActive} isSellable=${duplicateAfter?.isSellable}`,
  );
  record(
    'duplicate withdrawn from Golden I only',
    !duplicateStoresAfter.includes(GOLDEN_I_STORE_ID)
      && duplicateStoresBefore
        .filter((storeId) => storeId !== GOLDEN_I_STORE_ID)
        .every((storeId) => duplicateStoresAfter.includes(storeId)),
    duplicateStoresAfter.join(', '),
  );
  const duplicateFieldDrift = [...new Set([...Object.keys(duplicateBefore), ...Object.keys(duplicateAfter || {})])]
    .filter((key) => key !== 'availableStoreIds')
    .filter((key) => !deepEqual(duplicateBefore[key], duplicateAfter?.[key]));
  record(
    'no other field changed on the duplicate, so historical references remain resolvable',
    duplicateFieldDrift.length === 0,
    duplicateFieldDrift.length ? `drifted: ${duplicateFieldDrift.join(', ')}` : 'none',
  );

  // --- Exactly one 36 g Protein product visible in the Golden I POS ---------
  const posVisible = [AUTHORITATIVE_PROTEIN_CODE, TEMPORARY_PROTEIN_CODE, LEGACY_PROTEIN_CODE]
    .filter((code) => {
      const document = afterDocuments[`finishedGoods/${code}`];
      return document?.isActive === true
        && (Array.isArray(document.availableStoreIds) ? document.availableStoreIds : []).includes(GOLDEN_I_STORE_ID);
    });
  record(
    'exactly one 36 g Protein product is visible in the Golden I POS',
    posVisible.length === 1 && posVisible[0] === AUTHORITATIVE_PROTEIN_CODE,
    posVisible.join(', ') || 'none',
  );

  for (const forbidden of FORBIDDEN_WRITE_PATHS) {
    record(
      `${forbidden} unchanged`,
      deepEqual(beforeDocuments[forbidden], afterDocuments[forbidden]),
      'field-for-field comparison',
    );
  }

  record(
    'Mediterranean Mezze category is Always at Bond',
    mezzeAfter.posCategoryCode === 'ALWAYS_AT_BOND' && mezzeAfter.posCategoryName === 'Always at Bond',
    `${mezzeAfter.posCategoryCode} / ${mezzeAfter.posCategoryName}`,
  );

  const snapshotOperation = plan.operations.find((operation) => operation.path === snapshotPath);
  const plannedProtein = snapshotOperation?.after?.[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`];
  const snapshotProtein = snapshotAfter.menuItems?.[AUTHORITATIVE_PROTEIN_CODE];

  if (plannedProtein && !isDeleteSentinel(plannedProtein)) {
    // Replacement case: the duplicate was published, so the authoritative entry
    // takes its place and the duplicate's entries must be gone.
    record(
      'public snapshot contains the complete authoritative Protein entry',
      Boolean(snapshotProtein) && deepEqual(snapshotProtein, plannedProtein),
      snapshotProtein ? 'matches planned entry' : 'missing',
    );
    record(
      'public snapshot Protein availability entry published',
      snapshotAfter.items?.[AUTHORITATIVE_PROTEIN_CODE]?.available === true,
      JSON.stringify(snapshotAfter.items?.[AUTHORITATIVE_PROTEIN_CODE] ?? null),
    );
    record(
      'duplicate removed from the public snapshot',
      !(TEMPORARY_PROTEIN_CODE in (snapshotAfter.menuItems || {}))
        && !(TEMPORARY_PROTEIN_CODE in (snapshotAfter.items || {})),
      'menuItems and items both cleared',
    );
  } else {
    // Non-replacement case: the catalogue never carried a 36 g Protein entry, so
    // none is introduced and neither code may appear.
    record(
      'public catalogue membership unchanged for the Protein family',
      !(AUTHORITATIVE_PROTEIN_CODE in (snapshotAfter.menuItems || {}))
        && !(TEMPORARY_PROTEIN_CODE in (snapshotAfter.menuItems || {})),
      'no Protein entry added to the public catalogue',
    );
  }
  record(
    'public snapshot Mezze category is Always at Bond',
    snapshotAfter.menuItems?.[MEZZE_CODE]?.posCategoryCode === 'ALWAYS_AT_BOND'
      && snapshotAfter.menuItems?.[MEZZE_CODE]?.posCategoryName === 'Always at Bond',
    `${snapshotAfter.menuItems?.[MEZZE_CODE]?.posCategoryCode} / ${snapshotAfter.menuItems?.[MEZZE_CODE]?.posCategoryName}`,
  );

  // Every snapshot entry except the two approved ones must be untouched.
  const touchedCodes = new Set([AUTHORITATIVE_PROTEIN_CODE, TEMPORARY_PROTEIN_CODE, MEZZE_CODE]);
  const unrelatedDrift = [...new Set([
    ...Object.keys(snapshotBefore.menuItems || {}),
    ...Object.keys(snapshotAfter.menuItems || {}),
  ])]
    .filter((code) => !touchedCodes.has(code))
    .filter((code) => !deepEqual(snapshotBefore.menuItems?.[code], snapshotAfter.menuItems?.[code]));
  record(
    'unrelated snapshot menu entries unchanged field-for-field',
    unrelatedDrift.length === 0,
    unrelatedDrift.length ? `drifted: ${unrelatedDrift.join(', ')}` : 'none',
  );

  const unrelatedMezzeFieldDrift = [...new Set([
    ...Object.keys(snapshotBefore.menuItems?.[MEZZE_CODE] || {}),
    ...Object.keys(snapshotAfter.menuItems?.[MEZZE_CODE] || {}),
  ])]
    .filter((field) => field !== 'posCategoryCode' && field !== 'posCategoryName')
    .filter((field) => !deepEqual(
      snapshotBefore.menuItems?.[MEZZE_CODE]?.[field],
      snapshotAfter.menuItems?.[MEZZE_CODE]?.[field],
    ));
  record(
    'only category fields changed on the Mezze snapshot entry',
    unrelatedMezzeFieldDrift.length === 0,
    unrelatedMezzeFieldDrift.length ? `drifted: ${unrelatedMezzeFieldDrift.join(', ')}` : 'none',
  );

  record(
    'catalogue size and stored counts are unchanged',
    Object.keys(snapshotAfter.menuItems || {}).length === Object.keys(snapshotBefore.menuItems || {}).length
      && Object.keys(snapshotAfter.items || {}).length === Object.keys(snapshotBefore.items || {}).length
      && snapshotAfter.itemCount === snapshotBefore.itemCount
      && snapshotAfter.availableCount === snapshotBefore.availableCount
      && snapshotAfter.unavailableCount === snapshotBefore.unavailableCount,
    `itemCount=${snapshotAfter.itemCount} availableCount=${snapshotAfter.availableCount} entries=${Object.keys(snapshotAfter.menuItems || {}).length}`,
  );

  const outOfScope = Object.keys(afterDocuments)
    .filter((path) => !deepEqual(beforeDocuments[path], afterDocuments[path]))
    .filter((path) => !ALLOWED_WRITE_PATHS.includes(path));
  record(
    'no order, payment, KOT, movement, store or stock record changed',
    outOfScope.length === 0,
    outOfScope.length ? `changed: ${outOfScope.join(', ')}` : 'none',
  );

  return {
    ok: checks.every((check) => check.passed),
    checks,
  };
}

function documentsFromPlanInput(input) {
  const byPath = {};
  for (const document of input.finishedGoods || []) {
    byPath[`finishedGoods/${document.id}`] = document.data;
  }
  for (const document of input.publicMenuAvailability || []) {
    byPath[`publicMenuAvailability/${document.id}`] = document.data;
  }
  return byPath;
}

function reportPlan(plan) {
  console.log(`Project:            ${plan.projectId}`);
  console.log(`Schema version:     ${plan.schemaVersion}`);
  console.log(`Target store:       ${plan.targetStore}`);
  console.log(`Status:             ${plan.status}`);
  console.log(`Proposed writes:    ${plan.proposedWriteCount}`);
  console.log(`Checksum:           ${plan.checksum}`);
  console.log('');
  for (const operation of plan.operations) {
    console.log(`- ${operation.path}`);
    console.log(`  fields: ${operation.fieldPaths.join(', ')}`);
  }
  console.log('');
}

async function main() {
  const gates = parseApplyArgs(process.argv.slice(2));
  const input = await readPosMenuCorrectnessInput();
  const plan = buildPosMenuCorrectnessPlan(input);

  reportPlan(plan);

  const scope = verifyPlanScope(plan);
  if (!scope.ok) {
    console.error('BLOCKED: plan scope verification failed.');
    scope.failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }

  if (!gates.gatesSatisfied) {
    console.log('DRY RUN ONLY. No Firestore write was performed.');
    gates.reasons.forEach((reason) => console.log(`  - ${reason}`));
    console.log('');
    console.log('To apply, re-run with all three gates:');
    console.log(`  node scripts/apply-pos-menu-correctness.mjs --apply --checksum ${plan.checksum} --confirm "${CONFIRM_PHRASE}"`);
    return;
  }

  const checksumCheck = verifyChecksum(plan, gates.checksum);
  if (!checksumCheck.ok) {
    console.error('BLOCKED: checksum verification failed. No write was performed.');
    checksumCheck.failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }

  const preflightPreconditions = verifyPreconditions(plan, documentsFromPlanInput(input));
  if (!preflightPreconditions.ok) {
    console.error('BLOCKED: precondition verification failed. No write was performed.');
    preflightPreconditions.failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exitCode = 1;
    return;
  }

  const { applicationDefault, getApp, getApps, initializeApp } = await import('firebase-admin/app');
  const { FieldValue, getFirestore } = await import('firebase-admin/firestore');

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    console.error('BLOCKED: GOOGLE_APPLICATION_CREDENTIALS is required to apply. No write was performed.');
    process.exitCode = 1;
    return;
  }

  const app = getApps().length > 0
    ? getApp()
    : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const firestore = getFirestore(app);

  const writes = buildTransactionWrites(plan, FieldValue.delete());
  let committedWriteCount = 0;

  await firestore.runTransaction(async (transaction) => {
    // Transaction-level reads: these become the write preconditions. If any of
    // these documents changes before commit, Firestore aborts and retries, and
    // the re-read state is re-verified below.
    const refs = writes.map((write) => {
      const [collection, documentId] = write.path.split('/');
      return firestore.collection(collection).doc(documentId);
    });
    const snapshots = await transaction.getAll(...refs);

    const transactional = {};
    snapshots.forEach((snapshot, index) => {
      transactional[writes[index].path] = snapshot.exists ? snapshot.data() : null;
    });

    const inTransaction = verifyPreconditions(plan, transactional);
    if (!inTransaction.ok) {
      throw new Error(`Precondition drift inside transaction; nothing was written.\n${inTransaction.failures.map((f) => `  - ${f}`).join('\n')}`);
    }

    writes.forEach((write, index) => {
      transaction.update(refs[index], write.updates);
    });
    committedWriteCount = writes.length;
  });

  console.log(`Committed ${committedWriteCount} document write(s) in a single transaction.`);
  console.log('Run the dry run again to confirm it now proposes zero writes.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
