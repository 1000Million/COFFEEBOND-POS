#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';
import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'coffee-bond-pos';
const DEFAULT_WORKBOOK = 'data/imports/kitchen-missing-prep-recipes.xlsx';
const MASTER_WORKBOOK = 'data/imports/Coffee_Bond_Recipe_BOM_Costing_Master.xlsx';
const COMPONENT_MAPPING_PATH = 'data/imports/kitchen-bom-component-mappings.json';
const REPORT_DIR = 'reports';
const APPLY = process.argv.includes('--apply');

const REQUIRED_SHEETS = {
  headers: 'Prep Recipe Headers',
  components: 'Prep Recipe Components',
};

const UOM_ALIASES = {
  G: 'G',
  GM: 'G',
  GMS: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  ML: 'ML',
  MILLILITRE: 'ML',
  MILLILITER: 'ML',
  MILLILITRES: 'ML',
  MILLILITERS: 'ML',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  LITRE: 'L',
  LITER: 'L',
  LITRES: 'L',
  LITERS: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  SLICE: 'SLICE',
  SLICES: 'SLICE',
};

const UOM_SCALE = {
  G: { family: 'WEIGHT' },
  KG: { family: 'WEIGHT' },
  ML: { family: 'VOLUME' },
  L: { family: 'VOLUME' },
  PCS: { family: 'COUNT' },
  SLICE: { family: 'COUNT' },
};

const EXPECTED_PREP_ITEMS = [
  ['HONEY_LEMON_DRESSING', 'Honey Lemon Dressing'],
  ['OLIVE_OIL_DIP', 'Olive Oil Dip'],
  ['VANILLA_ICE_CREAM', 'Vanilla Ice Cream'],
  ['QUINOA_SALAD', 'Quinoa Salad'],
  ['COCONUT_SUGAR_DRESSING', 'Coconut Sugar Dressing'],
  ['CHILLI_OIL', 'Chilli Oil'],
  ['CASHEW_BLEND', 'Cashew Blend'],
  ['TOMATO_RELISH', 'Tomato Relish'],
  ['BOILED_POTATO', 'Boiled Potato'],
  ['PENNE_PASTA_BOILED', 'Penne Pasta Boiled'],
  ['FETTUCCINI_PASTA_BOILED', 'Fettuccini Pasta Boiled'],
  ['SPAGHETTI_BOILED', 'Spaghetti Boiled'],
  ['PICKLED_ONIONS', 'Pickled Onions'],
  ['MUSTARD_DIP', 'Mustard Dip'],
  ['RAJMA_BOILED', 'Rajma Boiled'],
  ['MASOOR_BOILED', 'Masoor Boiled'],
  ['BOILED_SOYA', 'Boiled Soya'],
  ['HARISSA_SAUCE', 'Harissa Sauce'],
  ['CHILLI_BEANS', 'Chilli Beans'],
];

const CANONICAL_PREP_NAME = new Map([
  ['tomato rellish', 'Tomato Relish'],
  ['fettuccini boiled pasta', 'Fettuccini Pasta Boiled'],
  ['pickled onions ring', 'Pickled Onions'],
]);

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : fallback;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  process.exit(1);
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value) {
  const parsed = number(value, NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeId(value) {
  return text(value).toUpperCase();
}

function normalizeName(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUom(value) {
  const raw = text(value).toUpperCase().replace(/\./g, '');
  return UOM_ALIASES[raw] || raw;
}

function sameOrConvertible(fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  return Boolean(fromMeta && toMeta && fromMeta.family === toMeta.family);
}

function codeFromName(name) {
  return text(name)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function readRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) fail(`Workbook is missing required sheet: ${sheetName}`);
  return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
    .map((row, index) => ({ ...row, __rowNumber: index + 2 }));
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < textValue.length; index += 1) {
    const char = textValue[index];
    const next = textValue[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...records] = rows;
  return records
    .filter((record) => record.some((value) => text(value)))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])));
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

async function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  });
  await fs.writeFile(filePath, `${lines.join('\n')}\n`);
}

function requireApplyEnv() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required only when --apply is used.');
  }
}

function initializeAdmin() {
  const app = getApps().length > 0
    ? getApp()
    : initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  return getFirestore(app);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(resolvePath(filePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function rawCatalogFromMaster(masterWorkbook, mappingFile) {
  const rawRows = readRows(masterWorkbook, 'Raw Material Master');
  const rawByCode = new Map();
  rawRows.forEach((row) => {
    const code = normalizeId(row['Raw Material ID']);
    if (!code) return;
    rawByCode.set(code, {
      code,
      name: text(row['Standard Ingredient']),
      uom: normalizeUom(row['Preferred Base UOM']),
      source: 'MASTER_WORKBOOK',
    });
  });

  (mappingFile.rawMaterialDefinitions || []).forEach((definition) => {
    const status = normalizeId(definition.approvalStatus || definition.status);
    if (!['APPROVED', 'APPROVED_DETERMINISTIC', 'OWNER_APPROVED'].includes(status)) return;
    const code = normalizeId(definition.code || definition.rawMaterialId);
    if (!code) return;
    rawByCode.set(code, {
      code,
      name: text(definition.name),
      uom: normalizeUom(definition.baseUOM || definition.usageUOM || definition.purchaseUOM),
      source: 'OWNER_DEFINED_MAPPING',
    });
  });

  return rawByCode;
}

function prepCatalogFromMaster(masterWorkbook, headers) {
  const prepRows = readRows(masterWorkbook, 'Prep Recipe Master');
  const prepByCode = new Map();
  prepRows.forEach((row) => {
    const code = normalizeId(row['Prep ID']);
    if (!code) return;
    prepByCode.set(code, {
      code,
      name: text(row['Prep Recipe']),
      uom: normalizeUom(row['Output UOM']),
      source: 'MASTER_WORKBOOK',
      isNewMissingPrep: false,
    });
  });

  headers.forEach((row) => {
    const code = normalizeId(row.prepCode || row['Prep Code']);
    if (!code) return;
    prepByCode.set(code, {
      code,
      name: text(row.prepName || row['Prep Name']),
      uom: normalizeUom(row.outputUnit || row['Output Unit']),
      source: 'MISSING_PREP_WORKBOOK',
      isNewMissingPrep: true,
    });
  });
  return prepByCode;
}

function canonicalPrepName(value) {
  const key = normalizeName(value);
  return CANONICAL_PREP_NAME.get(key) || text(value);
}

async function affectedProducts() {
  const filePath = resolvePath('reports/kitchen-bom-mapping-review.csv');
  let rows = [];
  try {
    rows = parseCsv(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const byPrepName = new Map();
  rows
    .filter((row) => row.classification === 'new PREP_ITEM required')
    .forEach((row) => {
      const prepName = canonicalPrepName(row.componentName);
      const prepCode = EXPECTED_PREP_ITEMS.find(([, name]) => normalizeName(name) === normalizeName(prepName))?.[0]
        || codeFromName(prepName);
      if (!byPrepName.has(prepCode)) {
        byPrepName.set(prepCode, {
          prepCode,
          prepName,
          affectedProducts: new Set(),
          unresolvedRows: 0,
          examples: [],
        });
      }
      const entry = byPrepName.get(prepCode);
      entry.affectedProducts.add(row.parent);
      entry.unresolvedRows += 1;
      entry.examples.push(`${row.parent} ${row.quantity}${row.requiredUnit}`);
    });

  return EXPECTED_PREP_ITEMS.map(([prepCode, prepName]) => {
    const found = byPrepName.get(prepCode) || {
      prepCode,
      prepName,
      affectedProducts: new Set(),
      unresolvedRows: 0,
      examples: [],
    };
    return {
      prepCode,
      prepName,
      affectedProductCount: found.affectedProducts.size,
      unresolvedBomRows: found.unresolvedRows,
      affectedProducts: [...found.affectedProducts].join(' | '),
      exampleUsage: found.examples.slice(0, 8).join(' | '),
    };
  });
}

function headerByCode(headers) {
  const map = new Map();
  headers.forEach((row) => {
    const code = normalizeId(row.prepCode || row['Prep Code']);
    if (code) map.set(code, row);
  });
  return map;
}

function componentRowsByPrep(components) {
  const map = new Map();
  components.forEach((row) => {
    const code = normalizeId(row.prepCode || row['Prep Code']);
    if (!code) return;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(row);
  });
  return map;
}

function normalizedComponentType(row) {
  const type = normalizeId(row.componentType || row['Component Type']);
  if (type === 'RAW_MATERIAL' || type === 'RAW_INGREDIENT' || type === 'RAW') return 'RAW_MATERIAL';
  if (type === 'PREP_ITEM' || type === 'PREP') return 'PREP_ITEM';
  return type;
}

function validate(workbookPath, masterWorkbookPath, mappingFile) {
  const workbook = xlsx.readFile(workbookPath, { raw: false });
  const masterWorkbook = xlsx.readFile(masterWorkbookPath, { raw: false });
  const headers = readRows(workbook, REQUIRED_SHEETS.headers);
  const components = readRows(workbook, REQUIRED_SHEETS.components);
  const headersMap = headerByCode(headers);
  const componentsMap = componentRowsByPrep(components);
  const rawByCode = rawCatalogFromMaster(masterWorkbook, mappingFile);
  const prepByCode = prepCatalogFromMaster(masterWorkbook, headers);
  const validationRows = [];
  const approvedCompletePrepCodes = new Set();

  function addIssue(row, issueCode, message, severity = 'BLOCKER', sheet = REQUIRED_SHEETS.headers, rowNumber = row.__rowNumber || '') {
    validationRows.push({
      prepCode: normalizeId(row.prepCode || row['Prep Code']),
      prepName: text(row.prepName || row['Prep Name']),
      status: 'BLOCKED',
      issueCode,
      issueMessage: message,
      severity,
      sheet,
      rowNumber,
    });
  }

  EXPECTED_PREP_ITEMS.forEach(([prepCode, prepName]) => {
    const row = headersMap.get(prepCode);
    if (!row) {
      validationRows.push({
        prepCode,
        prepName,
        status: 'BLOCKED',
        issueCode: 'MISSING_HEADER',
        issueMessage: 'Missing prep recipe header row.',
        severity: 'BLOCKER',
        sheet: REQUIRED_SHEETS.headers,
        rowNumber: '',
      });
      return;
    }

    const approval = normalizeId(row.approvalStatus || row['Approval Status']);
    const outputQty = positiveNumber(row.batchOutputQty || row['Batch Output Qty']);
    const outputUnit = normalizeUom(row.outputUnit || row['Output Unit']);
    const prepComponents = (componentsMap.get(prepCode) || [])
      .filter((component) => text(component.componentCode || component['Component Code'])
        || text(component.componentName || component['Component Name'])
        || text(component.quantity || component.Quantity)
        || text(component.unit || component.Unit)
        || text(component.componentType || component['Component Type']));

    if (approval !== 'APPROVED') addIssue(row, 'NOT_APPROVED', 'Prep recipe header must have Approval Status = APPROVED.');
    if (!outputQty) addIssue(row, 'MISSING_BATCH_OUTPUT', 'Batch output quantity must be greater than 0.');
    if (!outputUnit) addIssue(row, 'MISSING_OUTPUT_UNIT', 'Output unit is required.');
    if (prepComponents.length === 0) addIssue(row, 'MISSING_COMPONENTS', 'Recipe must include at least one approved component row.');

    if (approval === 'APPROVED' && outputQty && outputUnit && prepComponents.length > 0) {
      approvedCompletePrepCodes.add(prepCode);
    }
  });

  components.forEach((row) => {
    const prepCode = normalizeId(row.prepCode || row['Prep Code']);
    const hasAnyContent = [
      row.componentType || row['Component Type'],
      row.componentCode || row['Component Code'],
      row.componentName || row['Component Name'],
      row.quantity || row.Quantity,
      row.unit || row.Unit,
      row.approvalStatus || row['Approval Status'],
    ].some((value) => text(value));
    if (!hasAnyContent) return;

    const header = headersMap.get(prepCode);
    const componentType = normalizedComponentType(row);
    const componentCode = normalizeId(row.componentCode || row['Component Code']);
    const componentQty = positiveNumber(row.quantity || row.Quantity);
    const componentUnit = normalizeUom(row.unit || row.Unit);
    const approval = normalizeId(row.approvalStatus || row['Approval Status']);
    const target = componentType === 'RAW_MATERIAL' ? rawByCode.get(componentCode) : prepByCode.get(componentCode);

    if (!header) {
      addIssue({ prepCode, prepName: '' }, 'UNKNOWN_PREP_HEADER', 'Component row refers to a prep code without a header.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (!['RAW_MATERIAL', 'PREP_ITEM'].includes(componentType)) {
      addIssue(header || { prepCode }, 'INVALID_COMPONENT_TYPE', 'Component Type must be RAW_MATERIAL or PREP_ITEM.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (!componentCode) {
      addIssue(header || { prepCode }, 'MISSING_COMPONENT_CODE', 'Component Code is required.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    } else if (!target) {
      addIssue(header || { prepCode }, 'UNKNOWN_COMPONENT_CODE', `${componentType || 'Component'} code ${componentCode} was not found in the raw/prep catalog.`, 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (!componentQty) {
      addIssue(header || { prepCode }, 'INVALID_COMPONENT_QUANTITY', 'Component quantity must be greater than 0.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (!componentUnit) {
      addIssue(header || { prepCode }, 'MISSING_COMPONENT_UNIT', 'Component unit is required.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    } else if (target?.uom && !sameOrConvertible(componentUnit, target.uom)) {
      addIssue(header || { prepCode }, 'INCOMPATIBLE_COMPONENT_UNIT', `Cannot convert ${componentUnit} to ${target.uom} for ${componentCode}.`, 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (approval !== 'APPROVED') {
      addIssue(header || { prepCode }, 'COMPONENT_NOT_APPROVED', 'Component row must have Approval Status = APPROVED.', 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
    if (componentType === 'PREP_ITEM' && target?.isNewMissingPrep && !approvedCompletePrepCodes.has(componentCode)) {
      addIssue(header || { prepCode }, 'NESTED_PREP_INCOMPLETE', `Nested prep item ${componentCode} must also have an approved complete recipe and yield.`, 'BLOCKER', REQUIRED_SHEETS.components, row.__rowNumber);
    }
  });

  const graph = new Map();
  components.forEach((row) => {
    const prepCode = normalizeId(row.prepCode || row['Prep Code']);
    const componentType = normalizedComponentType(row);
    const componentCode = normalizeId(row.componentCode || row['Component Code']);
    if (prepCode && componentType === 'PREP_ITEM' && headersMap.has(componentCode)) {
      if (!graph.has(prepCode)) graph.set(prepCode, []);
      graph.get(prepCode).push(componentCode);
    }
  });

  function cycleFrom(prepCode, stack = []) {
    if (stack.includes(prepCode)) return [...stack, prepCode];
    for (const child of graph.get(prepCode) || []) {
      const found = cycleFrom(child, [...stack, prepCode]);
      if (found) return found;
    }
    return null;
  }

  graph.forEach((_, prepCode) => {
    const cycle = cycleFrom(prepCode);
    if (cycle) {
      const header = headersMap.get(prepCode) || { prepCode, prepName: prepCode };
      addIssue(header, 'CIRCULAR_PREP_DEPENDENCY', `Circular prep dependency detected: ${cycle.join(' -> ')}`);
    }
  });

  const issuePrepCodes = new Set(validationRows.map((row) => row.prepCode).filter(Boolean));
  const incompletePrepItems = EXPECTED_PREP_ITEMS
    .filter(([prepCode]) => issuePrepCodes.has(prepCode))
    .map(([prepCode, prepName]) => ({ prepCode, prepName }));

  return {
    headers,
    components,
    validationRows,
    incompletePrepItems,
  };
}

function buildPayloads(headers, components) {
  const componentsMap = componentRowsByPrep(components);
  return headers
    .map((row) => {
      const prepCode = normalizeId(row.prepCode || row['Prep Code']);
      const prepName = text(row.prepName || row['Prep Name']);
      if (!prepCode || !prepName) return null;
      const bom = (componentsMap.get(prepCode) || [])
        .filter((component) => normalizeId(component.approvalStatus || component['Approval Status']) === 'APPROVED')
        .map((component) => ({
          componentType: normalizedComponentType(component) === 'RAW_MATERIAL' ? 'RAW_INGREDIENT' : 'PREP_ITEM',
          componentCode: normalizeId(component.componentCode || component['Component Code']),
          componentName: text(component.componentName || component['Component Name']),
          quantity: positiveNumber(component.quantity || component.Quantity),
          uom: normalizeUom(component.unit || component.Unit),
          workbookNotes: text(component.notes || component.Notes),
        }))
        .filter((line) => line.componentCode && line.quantity && line.uom);
      return {
        code: prepCode,
        name: prepName,
        outputUOM: normalizeUom(row.outputUnit || row['Output Unit']),
        defaultBatchSize: positiveNumber(row.batchOutputQty || row['Batch Output Qty']),
        yieldQuantity: positiveNumber(row.batchOutputQty || row['Batch Output Qty']),
        yieldUOM: normalizeUom(row.outputUnit || row['Output Unit']),
        isStockTracked: true,
        bom,
        bomVersion: 1,
        isActive: true,
        importSource: 'PHASE_11A_MISSING_PREP_RECIPES',
        workbookStatus: normalizeId(row.approvalStatus || row['Approval Status']),
        workbookNotes: text(row.ownerNotes || row['Owner Notes']),
        updatedAt: FieldValue.serverTimestamp(),
      };
    })
    .filter(Boolean);
}

async function applyPayloads(payloads) {
  requireApplyEnv();
  const firestore = initializeAdmin();
  const batch = firestore.batch();
  payloads.forEach((payload) => {
    const ref = firestore.collection('prepItems').doc(payload.code);
    batch.set(ref, payload, { merge: true });
  });
  await batch.commit();
}

async function main() {
  const workbookPath = resolvePath(argValue('--workbook', DEFAULT_WORKBOOK));
  const masterWorkbookPath = resolvePath(argValue('--master-workbook', MASTER_WORKBOOK));
  const mappingFile = await readJson(COMPONENT_MAPPING_PATH, { rawMaterialDefinitions: [] });
  const affected = await affectedProducts();
  const validation = validate(workbookPath, masterWorkbookPath, mappingFile);
  const validationWithAffected = validation.validationRows.map((row) => {
    const affectedRow = affected.find((item) => item.prepCode === row.prepCode);
    return {
      ...row,
      affectedProducts: affectedRow?.affectedProducts || '',
    };
  });
  const payloads = buildPayloads(validation.headers, validation.components);
  const safeToApply = validationWithAffected.length === 0 && payloads.length === EXPECTED_PREP_ITEMS.length;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await writeCsv(path.join(REPORT_DIR, 'missing-prep-recipes-validation.csv'), validationWithAffected, [
    'prepCode',
    'prepName',
    'status',
    'issueCode',
    'issueMessage',
    'severity',
    'sheet',
    'rowNumber',
    'affectedProducts',
  ]);
  await writeCsv(path.join(REPORT_DIR, 'affected-products-by-prep-item.csv'), affected, [
    'prepCode',
    'prepName',
    'affectedProductCount',
    'unresolvedBomRows',
    'affectedProducts',
    'exampleUsage',
  ]);

  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    workbookPath,
    generatedAt: new Date().toISOString(),
    noFirestoreWritesPerformed: !APPLY,
    counts: {
      expectedPrepItems: EXPECTED_PREP_ITEMS.length,
      headerRows: validation.headers.length,
      componentRows: validation.components.length,
      unresolvedBomRowsRepresented: affected.reduce((sum, row) => sum + number(row.unresolvedBomRows), 0),
      affectedFinalProducts: new Set(affected.flatMap((row) => row.affectedProducts.split(' | ').filter(Boolean))).size,
      validationIssueRows: validationWithAffected.length,
      incompleteRecipeCount: validation.incompletePrepItems.length,
      payloadsReady: safeToApply ? payloads.length : 0,
    },
    incompletePrepItems: validation.incompletePrepItems,
    validation: {
      requireApprovedStatus: true,
      requirePositiveBatchOutput: true,
      requireOutputUnit: true,
      requireCompleteRecipeComponents: true,
      validateRawAndPrepReferences: true,
      validateNestedPrepDependencies: true,
      rejectCircularDependencies: true,
      costsWritten: false,
    },
    safeToApply,
    reports: {
      validation: path.join(REPORT_DIR, 'missing-prep-recipes-validation.csv'),
      affectedProducts: path.join(REPORT_DIR, 'affected-products-by-prep-item.csv'),
    },
  };
  await fs.writeFile(path.join(REPORT_DIR, 'missing-prep-recipes-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (APPLY) {
    if (!safeToApply) fail('Missing prep recipe import is blocked. Complete and approve every recipe before running --apply.');
    await applyPayloads(payloads);
  }

  console.log(`Mode: ${summary.mode}`);
  console.log(`Workbook: ${workbookPath}`);
  console.log(`Prep items expected: ${summary.counts.expectedPrepItems}`);
  console.log(`Unresolved BOM rows represented: ${summary.counts.unresolvedBomRowsRepresented}`);
  console.log(`Affected final products: ${summary.counts.affectedFinalProducts}`);
  console.log(`Incomplete recipe count: ${summary.counts.incompleteRecipeCount}`);
  console.log(`Safe to apply: ${summary.safeToApply ? 'yes' : 'no'}`);
  console.log(APPLY ? `Applied prep recipes: ${payloads.length}` : 'Dry run complete. No Firestore writes were performed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
