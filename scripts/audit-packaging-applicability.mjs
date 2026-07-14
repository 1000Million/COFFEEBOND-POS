#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const REPORT_DIR = 'reports';
const REPORT_PATH = path.join(REPORT_DIR, 'packaging-applicability-audit.csv');

const TAKEAWAY_PACKAGING_PATTERNS = [
  /\bbox(es)?\b/i,
  /\bcontainer(s)?\b/i,
  /\bcup(s)?\b/i,
  /\blid(s)?\b/i,
  /\bbag(s)?\b/i,
  /\bcarry\b/i,
  /\btake[\s_-]?away\b/i,
  /\bparcel\b/i,
  /\bcutlery\b/i,
  /\bspoon(s)?\b/i,
  /\bfork(s)?\b/i,
  /\bknife\b/i,
  /\bstraw(s)?\b/i,
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function initializeAdmin() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required for the read-only packaging applicability audit.');
  }
  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  return getFirestore(app);
}

function text(value) {
  return String(value ?? '').trim();
}

function normalizeApplicabilityValue(value) {
  const normalized = text(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'DINE_IN' || normalized === 'DINEIN') return 'DINE_IN';
  if (normalized === 'TAKEAWAY' || normalized === 'PICKUP' || normalized === 'TAKE_OUT' || normalized === 'TAKEOUT') return 'TAKEAWAY';
  if (normalized === 'DELIVERY') return 'DELIVERY';
  if (normalized === 'ALL' || normalized === 'ANY') return 'ALL';
  return '';
}

function inferPackagingApplicability(line) {
  const label = `${line.componentCode || ''} ${line.componentName || ''}`.replace(/_/g, ' ');
  if (TAKEAWAY_PACKAGING_PATTERNS.some((pattern) => pattern.test(label))) {
    return ['TAKEAWAY', 'DELIVERY'];
  }
  return ['ALL'];
}

function readExplicitApplicability(line) {
  const rawValue = line.applicableOrderTypes
    ?? line.packagingApplicability
    ?? line.orderTypes
    ?? line.serviceTypes
    ?? line.serviceType
    ?? line.applicability;
  const values = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
  return Array.from(new Set(values.map(normalizeApplicabilityValue).filter(Boolean)));
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

async function writeCsv(rows) {
  const columns = [
    'finishedGoodCode',
    'finishedGoodName',
    'componentCode',
    'componentName',
    'quantity',
    'uom',
    'applicabilitySource',
    'applicability',
    'reviewNote',
  ];
  const lines = [columns.join(',')];
  rows.forEach((row) => lines.push(columns.map((column) => csvEscape(row[column])).join(',')));
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_PATH, `${lines.join('\n')}\n`);
}

async function main() {
  const firestore = initializeAdmin();
  const snap = await firestore.collection('finishedGoods').get();
  const rows = [];
  snap.docs.forEach((doc) => {
    const fg = doc.data() || {};
    const bom = Array.isArray(fg.bom) ? fg.bom : [];
    bom.forEach((line) => {
      if (line.componentType !== 'PACKAGING') return;
      const explicit = readExplicitApplicability(line);
      const inferred = inferPackagingApplicability(line);
      const applicability = explicit.length > 0 ? explicit : inferred;
      rows.push({
        finishedGoodCode: fg.code || doc.id,
        finishedGoodName: fg.displayName || fg.name || doc.id,
        componentCode: line.componentCode || '',
        componentName: line.componentName || '',
        quantity: line.quantity ?? '',
        uom: line.uom || '',
        applicabilitySource: explicit.length > 0 ? 'EXPLICIT' : 'INFERRED',
        applicability: applicability.join('|'),
        reviewNote: explicit.length > 0
          ? 'Explicit BOM applicability present.'
          : applicability.includes('ALL')
            ? 'No explicit applicability; preserved as ALL pending review.'
            : 'No explicit applicability; inferred takeaway/delivery packaging from component name/code.',
      });
    });
  });
  rows.sort((a, b) => a.finishedGoodCode.localeCompare(b.finishedGoodCode) || a.componentCode.localeCompare(b.componentCode));
  await writeCsv(rows);
  console.log(`Packaging applicability audit written: ${REPORT_PATH}`);
  console.log(`Packaging BOM rows reviewed: ${rows.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
