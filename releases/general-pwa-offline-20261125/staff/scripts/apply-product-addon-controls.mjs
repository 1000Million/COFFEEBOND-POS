import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import {
  PRODUCT_ADD_ON_CONFIRMATION_FLAG,
  PRODUCT_ADD_ON_PROJECT_ID,
  buildProductAddOnControlsPlan,
} from './product-addon-controls-plan.mjs';

const reportsDir = path.join(process.cwd(), 'reports');
const manifestPath = path.join(reportsDir, 'product-addon-controls-migration-manifest.json');
const requestedProjectId = process.argv.find(argument => argument.startsWith('--project='))?.slice(10) || '';
const operatorUid = process.argv.find(argument => argument.startsWith('--operator-uid='))?.slice(15).trim() || '';

async function main() {
  if (!process.argv.includes(PRODUCT_ADD_ON_CONFIRMATION_FLAG)) {
    throw new Error(`Refusing to write without ${PRODUCT_ADD_ON_CONFIRMATION_FLAG}.`);
  }
  if (requestedProjectId !== PRODUCT_ADD_ON_PROJECT_ID) {
    throw new Error(`Refusing to write unless --project=${PRODUCT_ADD_ON_PROJECT_ID} is supplied exactly.`);
  }
  if (!operatorUid) throw new Error('Refusing to write without --operator-uid=<ACTIVE_ADMIN_UID>.');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Missing reviewed migration manifest. Run npm run dry-run:product-addon-controls first.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: requestedProjectId,
      credential: admin.credential.applicationDefault(),
    });
  }
  if (admin.app().options.projectId !== PRODUCT_ADD_ON_PROJECT_ID) {
    throw new Error('Firebase Admin initialized for an unexpected project.');
  }

  const db = admin.firestore();
  const operatorSnap = await db.collection('users').doc(operatorUid).get();
  const operator = operatorSnap.data() || {};
  if (!operatorSnap.exists || operator.isActive !== true || operator.role !== 'ADMIN') {
    throw new Error(`Operator users/${operatorUid} is not an active ADMIN.`);
  }

  const [finishedSnapshot, groupSnapshot] = await Promise.all([
    db.collection('finishedGoods').get(),
    db.collection('addOnGroups').get(),
  ]);
  const livePlan = buildProductAddOnControlsPlan({
    finishedGoodDocs: finishedSnapshot.docs.map(snap => ({ id: snap.id, data: snap.data() })),
    addOnGroupDocs: groupSnapshot.docs.map(snap => ({ id: snap.id, data: snap.data() })),
  });
  const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (livePlan.applyReadiness !== 'READY') throw new Error('Live migration plan is blocked.');
  if (reviewedManifest.dryRunChecksum !== livePlan.dryRunChecksum) {
    throw new Error('Dry-run checksum mismatch. Re-run and review the dry run before applying.');
  }
  if (livePlan.documentUpdates.length === 0) {
    console.log(JSON.stringify({ ok: true, alreadyApplied: true, firestoreWritesPerformed: 0 }, null, 2));
    return;
  }

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  livePlan.documentUpdates.forEach(update => {
    batch.update(db.doc(update.targetPath), {
      addOnOptionIdsByGroup: update.afterAddOnOptionIdsByGroup,
      updatedAt: now,
      updatedBy: operatorUid,
    });
  });
  livePlan.auditEntries.forEach(entry => {
    const auditId = `migration_${livePlan.dryRunChecksum.slice(0, 16)}_${entry.productId}_${entry.groupId}`;
    batch.create(db.collection('productAddOnAudit').doc(auditId), {
      ...entry,
      changedByUid: operatorUid,
      changedByName: operator.displayName || operator.name || operator.email || operatorUid,
      changedAt: now,
    });
  });
  await batch.commit();
  console.log(JSON.stringify({
    ok: true,
    alreadyApplied: false,
    dryRunChecksum: livePlan.dryRunChecksum,
    counts: livePlan.counts,
  }, null, 2));
}

main().catch(error => {
  console.error('product-addon-controls-apply-failed', error);
  process.exitCode = 1;
});

