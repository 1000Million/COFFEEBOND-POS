import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import {
  PHASE_1_CONFIRMATION_FLAG,
  PHASE_1_NAME,
  PHASE_1_PROJECT_ID,
  buildPhase1Plan,
  stableStringify,
} from './addon-group-phase-1.mjs';
import {
  loadApprovalManifest,
  validateApprovalSources,
} from './addon-product-reconciliation.mjs';

const reportsDir = path.join(process.cwd(), 'reports');
const reportPath = path.join(reportsDir, 'addon-group-deployment-dry-run.json');
const phase1ManifestPath = path.join(reportsDir, 'addon-group-phase-1-deployment-manifest.json');
const confirmationProvided = process.argv.includes(PHASE_1_CONFIRMATION_FLAG);
const requestedProjectId = process.argv
  .find((argument) => argument.startsWith('--project='))
  ?.slice('--project='.length) || '';
const operatorUid = process.argv
  .find((argument) => argument.startsWith('--operator-uid='))
  ?.slice('--operator-uid='.length)
  .trim() || '';

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()),
  )];
}

function sameStrings(left, right) {
  return stableStringify(uniqueStrings(left)) === stableStringify(uniqueStrings(right));
}

async function verifyOperator(db) {
  if (!operatorUid) {
    throw new Error('Refusing to write without --operator-uid=<ACTIVE_ADMIN_UID>.');
  }
  const operatorSnap = await db.collection('users').doc(operatorUid).get();
  const operator = operatorSnap.data() || {};
  if (!operatorSnap.exists || operator.isActive !== true || operator.role !== 'ADMIN') {
    throw new Error(`Operator users/${operatorUid} is not an active ADMIN.`);
  }
  return {
    uid: operatorUid,
    name: operator.displayName || operator.name || operator.email || operatorUid,
    email: operator.email || null,
  };
}

async function verifyLiveBeforeValues(db, plan) {
  const updatePlans = plan.finishedGoodDocumentPlan.filter((document) => document.action === 'UPDATE');
  const documentSnaps = await Promise.all(
    updatePlans.map((document) => db.doc(document.targetPath).get()),
  );
  documentSnaps.forEach((snap, index) => {
    const documentPlan = updatePlans[index];
    if (!snap.exists) {
      throw new Error(`Dry-run target no longer exists: ${documentPlan.targetPath}.`);
    }
    if (!sameStrings(snap.data()?.addOnGroupIds, documentPlan.beforeAddOnGroupIds)) {
      throw new Error(
        `Dry-run before-value mismatch at ${documentPlan.targetPath}. Re-run npm run dry-run:addon-group-deployment.`,
      );
    }
  });

  for (const groupPlan of plan.groupDocumentPlan) {
    const groupSnap = await db.doc(groupPlan.documentPath).get();
    if (groupPlan.action === 'CREATE' && groupSnap.exists) {
      throw new Error(
        `${groupPlan.documentPath} was created after the reviewed dry run. Re-run the dry run before applying.`,
      );
    }
  }
}

async function main() {
  if (!confirmationProvided) {
    throw new Error(
      `Refusing to write without ${PHASE_1_CONFIRMATION_FLAG}. This command applies only ${PHASE_1_NAME}.`,
    );
  }
  if (requestedProjectId !== PHASE_1_PROJECT_ID) {
    throw new Error(`Refusing to write unless --project=${PHASE_1_PROJECT_ID} is supplied exactly.`);
  }
  if (!fs.existsSync(reportPath) || !fs.existsSync(phase1ManifestPath)) {
    throw new Error('Missing Phase 1 dry-run artifacts. Run npm run dry-run:addon-group-deployment first.');
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const reviewedManifest = JSON.parse(fs.readFileSync(phase1ManifestPath, 'utf8'));
  const approvalManifest = loadApprovalManifest();
  const recomputedPlan = buildPhase1Plan({ report, approvalManifest });

  if (
    report.summary?.zeroWritesPerformed !== true
    || report.summary?.phase1ApplyReadiness !== 'READY_PHASE_1'
    || recomputedPlan.applyReadiness !== 'READY_PHASE_1'
  ) {
    throw new Error('The latest add-on deployment dry run is not READY_PHASE_1.');
  }
  if (
    reviewedManifest.dryRunChecksum !== recomputedPlan.dryRunChecksum
    || report.summary.phase1DryRunChecksum !== recomputedPlan.dryRunChecksum
  ) {
    throw new Error('Phase 1 dry-run checksum mismatch. Re-run and review the dry run before applying.');
  }
  if (
    recomputedPlan.counts.sourceProductAssignments !== 54
    || recomputedPlan.counts.deferredProducts !== 10
    || recomputedPlan.counts.legacyExclusions !== 1
    || recomputedPlan.counts.inventoryConfiguredOptions !== 0
    || recomputedPlan.counts.inventoryNotConfiguredOptions !== 27
  ) {
    throw new Error('Phase 1 counts do not match the owner-approved deployment contract.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: requestedProjectId,
      credential: admin.credential.applicationDefault(),
    });
  }
  const configuredProjectId = admin.app().options.projectId;
  if (configuredProjectId !== PHASE_1_PROJECT_ID) {
    throw new Error(`Firebase Admin initialized for unexpected project ${configuredProjectId || '(missing)'}.`);
  }

  const db = admin.firestore();
  const operator = await verifyOperator(db);
  const [menuSnapshot, finishedSnapshot] = await Promise.all([
    db.collection('menuItems').get(),
    db.collection('finishedGoods').get(),
  ]);
  validateApprovalSources(
    approvalManifest,
    menuSnapshot.docs.map((snap) => ({ id: snap.id, data: snap.data() })),
    finishedSnapshot.docs.map((snap) => ({ id: snap.id, data: snap.data() })),
  );

  const auditRef = db.collection('addOnGroupAudit').doc(recomputedPlan.deploymentId);
  const existingAudit = await auditRef.get();
  if (existingAudit.exists) {
    if (existingAudit.data()?.dryRunChecksum === recomputedPlan.dryRunChecksum) {
      console.log(JSON.stringify({
        ok: true,
        alreadyApplied: true,
        deploymentId: recomputedPlan.deploymentId,
        auditManifestPath: auditRef.path,
        firestoreWritesPerformed: 0,
      }, null, 2));
      return;
    }
    throw new Error(`Audit ID collision at ${auditRef.path}.`);
  }

  await verifyLiveBeforeValues(db, recomputedPlan);

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  recomputedPlan.groupDocumentPlan.forEach((groupPlan) => {
    batch.set(db.doc(groupPlan.documentPath), {
      ...groupPlan.payload,
      updatedAt: now,
      updatedBy: operator.uid,
    }, { merge: true });
  });

  const productUpdates = recomputedPlan.finishedGoodDocumentPlan
    .filter((document) => document.action === 'UPDATE');
  productUpdates.forEach((document) => {
    batch.update(db.doc(document.targetPath), {
      addOnGroupIds: document.afterAddOnGroupIds,
      updatedAt: now,
      updatedBy: operator.uid,
    });
  });

  batch.create(auditRef, {
    action: 'PHASE_1_DEPLOYMENT',
    deploymentPhase: PHASE_1_NAME,
    projectId: PHASE_1_PROJECT_ID,
    dryRunChecksum: recomputedPlan.dryRunChecksum,
    approvalManifestChecksum: recomputedPlan.approvalManifestChecksum,
    assignedProducts: recomputedPlan.assignedProducts,
    finishedGoodDocumentPlan: recomputedPlan.finishedGoodDocumentPlan,
    deferredProducts: recomputedPlan.deferredProducts,
    excludedProducts: recomputedPlan.excludedProducts,
    inventoryLimitation: recomputedPlan.inventoryLimitation,
    counts: recomputedPlan.counts,
    operatorUid: operator.uid,
    operatorName: operator.name,
    operatorEmail: operator.email,
    sourceReport: 'reports/addon-group-deployment-dry-run.json',
    appliedAt: now,
    immutable: true,
  });

  await batch.commit();
  console.log(JSON.stringify({
    ok: true,
    alreadyApplied: false,
    deploymentId: recomputedPlan.deploymentId,
    dryRunChecksum: recomputedPlan.dryRunChecksum,
    groupsWritten: recomputedPlan.groupDocumentPlan.length,
    finishedGoodDocumentsUpdated: productUpdates.length,
    sourceProductAssignments: recomputedPlan.counts.sourceProductAssignments,
    deferredProducts: recomputedPlan.counts.deferredProducts,
    auditManifestPath: auditRef.path,
    firestoreWritesPerformed: recomputedPlan.counts.firstApplyFirestoreWrites,
  }, null, 2));
}

main().catch((error) => {
  console.error('addon-group-phase-1-apply-failed', error);
  process.exitCode = 1;
});
