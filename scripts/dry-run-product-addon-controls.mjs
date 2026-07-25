import fs from 'node:fs';
import path from 'node:path';
import { readFirestoreCollection } from './firestore-read-only.mjs';
import { buildProductAddOnControlsPlan } from './product-addon-controls-plan.mjs';

const reportsDir = path.join(process.cwd(), 'reports');
const jsonPath = path.join(reportsDir, 'product-addon-controls-dry-run.json');
const csvPath = path.join(reportsDir, 'product-addon-controls-dry-run.csv');
const manifestPath = path.join(reportsDir, 'product-addon-controls-migration-manifest.json');

function csv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  if (process.argv.includes('--apply')) {
    throw new Error('This command is a zero-write dry run. Use the guarded apply command only after owner review.');
  }
  const [finishedGoodDocs, addOnGroupDocs] = await Promise.all([
    readFirestoreCollection('finishedGoods'),
    readFirestoreCollection('addOnGroups'),
  ]);
  const plan = buildProductAddOnControlsPlan({ finishedGoodDocs, addOnGroupDocs });
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    zeroWritesPerformed: true,
    ...plan,
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    projectId: plan.projectId,
    dryRunChecksum: plan.dryRunChecksum,
    operatorUid: 'REQUIRED_AT_APPLY',
    appliedAt: null,
    documentUpdates: plan.documentUpdates,
    auditEntries: plan.auditEntries,
    counts: plan.counts,
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const headers = [
    'productPath',
    'productCode',
    'productName',
    'groupId',
    'groupName',
    'previousOptionIds',
    'proposedOptionIds',
    'action',
    'reason',
  ];
  fs.writeFileSync(csvPath, [
    headers.join(','),
    ...plan.rows.map(row => headers.map(header => csv(
      Array.isArray(row[header]) ? row[header].join('|') : row[header],
    )).join(',')),
  ].join('\n') + '\n');

  console.log(JSON.stringify({
    ok: plan.applyReadiness === 'READY',
    zeroWritesPerformed: true,
    applyReadiness: plan.applyReadiness,
    dryRunChecksum: plan.dryRunChecksum,
    counts: plan.counts,
    reportPaths: { jsonPath, csvPath, manifestPath },
    blockers: plan.blockers,
  }, null, 2));
}

main().catch(error => {
  console.error('product-addon-controls-dry-run-failed', error);
  process.exitCode = 1;
});

