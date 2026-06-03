import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Loader2,
  ShieldCheck,
  Upload,
} from 'lucide-react';

type FileKey = 'raw' | 'prepBom' | 'finishedBom' | 'prepSummary' | 'finishedSummary' | 'legacyExcel';
type ReadinessStatus = 'READY_TO_IMPORT' | 'NEEDS_CLEANUP' | 'COSTING_INCOMPLETE';
type Severity = 'error' | 'warning' | 'info';

interface FileSpec {
  key: FileKey;
  label: string;
  expectedName: string;
  required: boolean;
  accept: string;
}

interface ValidationIssue {
  area: string;
  severity: Severity;
  code?: string;
  row?: number;
  message: string;
}

interface MissingComponentRow {
  missingCode: string;
  referencedByType: string;
  referencedByCode: string;
  referencedByName: string;
  sourceFile: string;
  suggestedCategory: string;
  suggestedPurchaseUOM: string;
  suggestedUsageUOM: string;
  suggestedConversionFactor: number;
  suggestedPurchaseCost: number;
  foundInLegacyExcel: string;
  legacyName: string;
  notes: string;
}

interface ZeroCostRow {
  code: string;
  name: string;
  category: string;
  purchaseUOM: string;
  usageUOM: string;
  currentPurchaseCost: number;
  suggestedPurchaseCost: string;
  notes: string;
}

interface ValidationReport {
  status: ReadinessStatus;
  counts: Record<string, number>;
  issues: ValidationIssue[];
  missingComponents: MissingComponentRow[];
  zeroCostIngredients: ZeroCostRow[];
}

type RowData = Record<string, string>;

const FILE_SPECS: FileSpec[] = [
  {
    key: 'raw',
    label: 'Raw ingredients',
    expectedName: 'Coffee_Bond_Raw_Ingredients_Import.csv',
    required: true,
    accept: '.csv',
  },
  {
    key: 'prepBom',
    label: 'Prep BOM',
    expectedName: 'Coffee_Bond_New_Menu_Prep_BOM_Import.csv',
    required: true,
    accept: '.csv',
  },
  {
    key: 'finishedBom',
    label: 'Finished goods BOM',
    expectedName: 'Coffee_Bond_New_Menu_Finished_Items_BOM_Import.csv',
    required: true,
    accept: '.csv',
  },
  {
    key: 'prepSummary',
    label: 'Prep item summary',
    expectedName: 'Coffee_Bond_New_Menu_Prep_Items_Summary.csv',
    required: true,
    accept: '.csv',
  },
  {
    key: 'finishedSummary',
    label: 'Finished item summary',
    expectedName: 'Coffee_Bond_New_Menu_Finished_Items_Summary.csv',
    required: true,
    accept: '.csv',
  },
  {
    key: 'legacyExcel',
    label: 'Legacy POS export reference',
    expectedName: 'POS_Data_Export.xlsx',
    required: false,
    accept: '.xlsx,.xls',
  },
];

const RAW_REQUIRED_FIELDS = [
  'code',
  'name',
  'category',
  'purchaseUOM',
  'usageUOM',
  'conversionFactor',
  'purchaseCost',
];

const PREP_REQUIRED_FIELDS = [
  'prepCode',
  'prepName',
  'outputUOM',
  'defaultBatchSize',
  'yieldQuantity',
  'yieldUOM',
];

const FINISHED_REQUIRED_FIELDS = [
  'fgCode',
  'fgName',
  'posCategoryCode',
  'posCategoryName',
  'salePrice',
  'itemType',
  'prepStation',
];

const VALID_UOMS = new Set([
  'g',
  'kg',
  'ml',
  'l',
  'pcs',
  'pc',
  'pack',
  'unit',
  'units',
  'bottle',
  'jar',
  'can',
  'bag',
  'box',
  'tray',
  'portion',
]);

const VALID_PREP_STATIONS = new Set(['BARISTA', 'KITCHEN', 'BOTH', 'NONE']);
const VALID_ITEM_TYPES = new Set(['MADE_TO_ORDER', 'DIRECT_STOCK', 'NO_STOCK']);
const VALID_PRODUCTION_MODES = new Set(['MADE_TO_ORDER', 'ASSEMBLED_TO_ORDER', 'BOUGHT_AND_SOLD', 'NO_STOCK']);

function cleanValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toNumber(value: unknown): number {
  const cleaned = cleanValue(value).replace(/,/g, '');
  if (!cleaned) return Number.NaN;
  return Number(cleaned);
}

function toBool(value: unknown, fallback = true): boolean {
  const cleaned = cleanValue(value).toLowerCase();
  if (!cleaned) return fallback;
  if (['false', 'no', '0', 'inactive'].includes(cleaned)) return false;
  if (['true', 'yes', '1', 'active'].includes(cleaned)) return true;
  return fallback;
}

function normalizeCode(value: unknown): string {
  return cleanValue(value).toUpperCase();
}

function normalizeUom(value: unknown): string {
  return cleanValue(value).toLowerCase();
}

function normalizeComponentType(value: unknown): string {
  const type = normalizeCode(value);
  if (type === 'RAW') return 'RAW_INGREDIENT';
  if (type === 'PREP') return 'PREP_ITEM';
  return type;
}

function isValidCode(code: string): boolean {
  return /^[A-Z0-9_]+$/.test(code);
}

function getHeaders(rows: RowData[]): Set<string> {
  const headers = new Set<string>();
  rows.forEach((row) => Object.keys(row).forEach((header) => headers.add(header)));
  return headers;
}

function addHeaderIssues(rows: RowData[], required: string[], area: string, issues: ValidationIssue[]) {
  const headers = getHeaders(rows);
  required.forEach((field) => {
    if (!headers.has(field)) {
      issues.push({
        area,
        severity: 'error',
        message: `Missing required column: ${field}`,
      });
    }
  });
}

function findDuplicateCodes(rows: RowData[], field: string): string[] {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const code = normalizeCode(row[field]);
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
  });
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([code]) => code)
    .sort();
}

function uniqueCodes(rows: RowData[], field: string): Set<string> {
  return new Set(rows.map((row) => normalizeCode(row[field])).filter(Boolean));
}

function findMasterConflicts(rows: RowData[], keyField: string, masterFields: string[]): string[] {
  const seen = new Map<string, Record<string, string>>();
  const conflicts = new Set<string>();

  rows.forEach((row) => {
    const code = normalizeCode(row[keyField]);
    if (!code) return;

    const current: Record<string, string> = {};
    masterFields.forEach((field) => {
      current[field] = cleanValue(row[field]);
    });

    const previous = seen.get(code);
    if (!previous) {
      seen.set(code, current);
      return;
    }

    const hasConflict = masterFields.some((field) => previous[field] !== current[field]);
    if (hasConflict) conflicts.add(code);
  });

  return Array.from(conflicts).sort();
}

function suggestCategory(code: string, legacyCategory: string, componentType: string): string {
  if (componentType === 'PREP_ITEM') return 'PREP_ITEM';
  if (legacyCategory) return legacyCategory;
  if (/(CUP|LID|BOX|BAG|SLEEVE|NAPKIN|STRAW|PACK|WRAP|CONTAINER)/.test(code)) return 'PACKAGING';
  if (/(MILK|CREAM|YOGURT|CHEESE|RICOTTA|MOZZARELLA|MASCARPONE)/.test(code)) return 'DAIRY';
  if (/(COFFEE|ESPRESSO|BEANS|TEA|MATCHA|HOJICHA)/.test(code)) return 'COFFEE';
  if (/(MANGO|BANANA|AVOCADO|BERRY|WATERMELON|LEMON|LIME|ORANGE|KALE|CARROT)/.test(code)) return 'FRESH_PRODUCE';
  return 'OTHER';
}

function suggestUomFromBom(uom: string): { purchaseUOM: string; usageUOM: string; conversionFactor: number } {
  const normalized = normalizeUom(uom);
  if (normalized === 'g') return { purchaseUOM: 'kg', usageUOM: 'g', conversionFactor: 1000 };
  if (normalized === 'ml') return { purchaseUOM: 'l', usageUOM: 'ml', conversionFactor: 1000 };
  if (normalized === 'kg') return { purchaseUOM: 'kg', usageUOM: 'kg', conversionFactor: 1 };
  if (normalized === 'l') return { purchaseUOM: 'l', usageUOM: 'l', conversionFactor: 1 };
  return { purchaseUOM: normalized || 'pcs', usageUOM: normalized || 'pcs', conversionFactor: 1 };
}

async function readRows(file: File, sheetName?: string): Promise<RowData[]> {
  const lowerName = file.name.toLowerCase();
  const workbook = lowerName.endsWith('.csv')
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' });

  const targetSheet = sheetName && workbook.SheetNames.includes(sheetName)
    ? sheetName
    : workbook.SheetNames[0];

  if (!targetSheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[targetSheet], {
    defval: '',
    raw: false,
  });

  return rows.map((row) => {
    const cleaned: RowData = {};
    Object.entries(row).forEach(([key, value]) => {
      cleaned[key.trim()] = cleanValue(value);
    });
    return cleaned;
  });
}

function makeCsv<T extends object>(rows: T[], columns: string[]): string {
  const escapeCell = (value: unknown) => {
    const text = cleanValue(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  return [
    columns.join(','),
    ...rows.map((row) => {
      const record = row as Record<string, unknown>;
      return columns.map((column) => escapeCell(record[column])).join(',');
    }),
  ].join('\n');
}

function downloadCsv<T extends object>(filename: string, rows: T[], columns: string[]) {
  const csv = makeCsv(rows, columns);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildLegacyInventoryMap(rows: RowData[]): Map<string, RowData> {
  const legacy = new Map<string, RowData>();
  rows.forEach((row) => {
    const code = normalizeCode(row.code);
    if (!code) return;
    legacy.set(code, row);
  });
  return legacy;
}

function addMissingComponent(
  missingRows: MissingComponentRow[],
  legacyInventory: Map<string, RowData>,
  missingCode: string,
  componentType: string,
  referencedByType: string,
  referencedByCode: string,
  referencedByName: string,
  sourceFile: string,
  bomUom: string,
) {
  const legacy = legacyInventory.get(missingCode);
  const uomSuggestion = suggestUomFromBom(bomUom || legacy?.unit || '');
  const legacyCategory = cleanValue(legacy?.category);
  const legacyName = cleanValue(legacy?.name);

  missingRows.push({
    missingCode,
    referencedByType,
    referencedByCode,
    referencedByName,
    sourceFile,
    suggestedCategory: suggestCategory(missingCode, legacyCategory, componentType),
    suggestedPurchaseUOM: uomSuggestion.purchaseUOM,
    suggestedUsageUOM: uomSuggestion.usageUOM,
    suggestedConversionFactor: uomSuggestion.conversionFactor,
    suggestedPurchaseCost: 0,
    foundInLegacyExcel: legacy ? 'YES' : 'NO',
    legacyName,
    notes: componentType === 'PREP_ITEM'
      ? 'Create or fix prep item master before import.'
      : 'Add this missing component to raw ingredients before import.',
  });
}

function buildValidationReport(rowsByKey: Record<FileKey, RowData[]>): ValidationReport {
  const issues: ValidationIssue[] = [];
  const missingComponents: MissingComponentRow[] = [];
  const zeroCostIngredients: ZeroCostRow[] = [];

  const rawRows = rowsByKey.raw || [];
  const prepBomRows = rowsByKey.prepBom || [];
  const finishedBomRows = rowsByKey.finishedBom || [];
  const prepSummaryRows = rowsByKey.prepSummary || [];
  const finishedSummaryRows = rowsByKey.finishedSummary || [];
  const legacyInventory = buildLegacyInventoryMap(rowsByKey.legacyExcel || []);

  addHeaderIssues(rawRows, RAW_REQUIRED_FIELDS, 'Raw Ingredients', issues);
  addHeaderIssues(prepBomRows, [...PREP_REQUIRED_FIELDS, 'bomComponentType', 'bomComponentCode', 'bomQuantity', 'bomUOM'], 'Prep BOM', issues);
  addHeaderIssues(prepSummaryRows, PREP_REQUIRED_FIELDS, 'Prep Summary', issues);
  addHeaderIssues(finishedBomRows, [...FINISHED_REQUIRED_FIELDS, 'bomComponentType', 'bomComponentCode', 'bomQuantity', 'bomUOM'], 'Finished Goods BOM', issues);
  addHeaderIssues(finishedSummaryRows, FINISHED_REQUIRED_FIELDS, 'Finished Summary', issues);

  const rawDuplicateCodes = findDuplicateCodes(rawRows, 'code');
  rawDuplicateCodes.forEach((code) => issues.push({
    area: 'Raw Ingredients',
    severity: 'error',
    code,
    message: 'Duplicate raw ingredient code.',
  }));

  const prepSummaryDuplicateCodes = findDuplicateCodes(prepSummaryRows, 'prepCode');
  prepSummaryDuplicateCodes.forEach((code) => issues.push({
    area: 'Prep Summary',
    severity: 'error',
    code,
    message: 'Duplicate prep item master code.',
  }));

  const finishedSummaryDuplicateCodes = findDuplicateCodes(finishedSummaryRows, 'fgCode');
  finishedSummaryDuplicateCodes.forEach((code) => issues.push({
    area: 'Finished Summary',
    severity: 'error',
    code,
    message: 'Duplicate finished goods master code.',
  }));

  rawRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const code = normalizeCode(row.code);

    RAW_REQUIRED_FIELDS.forEach((field) => {
      if (!cleanValue(row[field])) {
        issues.push({
          area: 'Raw Ingredients',
          severity: 'error',
          code,
          row: rowNumber,
          message: `Missing required field: ${field}`,
        });
      }
    });

    if (code && !isValidCode(code)) {
      issues.push({
        area: 'Raw Ingredients',
        severity: 'error',
        code,
        row: rowNumber,
        message: 'Code must be uppercase snake case.',
      });
    }

    const purchaseUom = normalizeUom(row.purchaseUOM);
    const usageUom = normalizeUom(row.usageUOM);
    if (purchaseUom && !VALID_UOMS.has(purchaseUom)) {
      issues.push({
        area: 'Raw Ingredients',
        severity: 'error',
        code,
        row: rowNumber,
        message: `Invalid purchaseUOM: ${row.purchaseUOM}`,
      });
    }
    if (usageUom && !VALID_UOMS.has(usageUom)) {
      issues.push({
        area: 'Raw Ingredients',
        severity: 'error',
        code,
        row: rowNumber,
        message: `Invalid usageUOM: ${row.usageUOM}`,
      });
    }

    const conversionFactor = toNumber(row.conversionFactor);
    if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
      issues.push({
        area: 'Raw Ingredients',
        severity: 'error',
        code,
        row: rowNumber,
        message: 'conversionFactor must be greater than 0.',
      });
    }

    const purchaseCost = toNumber(row.purchaseCost);
    const usageCost = toNumber(row.costPerUsageUnit);
    if (!Number.isFinite(purchaseCost) || purchaseCost < 0) {
      issues.push({
        area: 'Raw Ingredients',
        severity: 'error',
        code,
        row: rowNumber,
        message: 'purchaseCost must be 0 or greater.',
      });
    }

    if (code && toBool(row.isActive, true) && (!Number.isFinite(purchaseCost) || purchaseCost === 0 || !Number.isFinite(usageCost) || usageCost === 0)) {
      zeroCostIngredients.push({
        code,
        name: cleanValue(row.name),
        category: cleanValue(row.category),
        purchaseUOM: cleanValue(row.purchaseUOM),
        usageUOM: cleanValue(row.usageUOM),
        currentPurchaseCost: Number.isFinite(purchaseCost) ? purchaseCost : 0,
        suggestedPurchaseCost: '',
        notes: 'Fill purchase cost before final costing/margin rollout.',
      });
    }
  });

  const rawCodes = uniqueCodes(rawRows, 'code');
  const prepMasterCodes = uniqueCodes(prepSummaryRows, 'prepCode');
  const finishedMasterCodes = uniqueCodes(finishedSummaryRows, 'fgCode');
  const prepBomCodes = uniqueCodes(prepBomRows, 'prepCode');
  const finishedBomCodes = uniqueCodes(finishedBomRows, 'fgCode');

  const prepConflicts = findMasterConflicts(prepBomRows, 'prepCode', PREP_REQUIRED_FIELDS);
  prepConflicts.forEach((code) => issues.push({
    area: 'Prep BOM',
    severity: 'error',
    code,
    message: 'Conflicting prep master fields across BOM rows.',
  }));

  const finishedConflicts = findMasterConflicts(finishedBomRows, 'fgCode', FINISHED_REQUIRED_FIELDS);
  finishedConflicts.forEach((code) => issues.push({
    area: 'Finished Goods BOM',
    severity: 'error',
    code,
    message: 'Conflicting finished goods master fields across BOM rows.',
  }));

  prepBomCodes.forEach((code) => {
    if (!prepMasterCodes.has(code)) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code,
        message: 'Prep item appears in BOM but is missing from prep summary.',
      });
    }
  });

  finishedBomCodes.forEach((code) => {
    if (!finishedMasterCodes.has(code)) {
      issues.push({
        area: 'Finished Goods BOM',
        severity: 'error',
        code,
        message: 'Finished good appears in BOM but is missing from finished summary.',
      });
    }
  });

  prepBomRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const prepCode = normalizeCode(row.prepCode);
    const prepName = cleanValue(row.prepName);
    const componentType = normalizeComponentType(row.bomComponentType);
    const componentCode = normalizeCode(row.bomComponentCode);

    PREP_REQUIRED_FIELDS.forEach((field) => {
      if (!cleanValue(row[field])) {
        issues.push({
          area: 'Prep BOM',
          severity: 'error',
          code: prepCode,
          row: rowNumber,
          message: `Missing required field: ${field}`,
        });
      }
    });

    if (prepCode && !isValidCode(prepCode)) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code: prepCode,
        row: rowNumber,
        message: 'prepCode must be uppercase snake case.',
      });
    }

    if (!componentCode) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code: prepCode,
        row: rowNumber,
        message: 'Missing component code.',
      });
    }

    if (!['RAW_INGREDIENT', 'PREP_ITEM'].includes(componentType)) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code: prepCode,
        row: rowNumber,
        message: 'Prep BOM component type must be RAW or PREP.',
      });
    }

    const quantity = toNumber(row.bomQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code: prepCode,
        row: rowNumber,
        message: 'bomQuantity must be greater than 0.',
      });
    }

    if (prepCode && componentCode === prepCode) {
      issues.push({
        area: 'Prep BOM',
        severity: 'error',
        code: prepCode,
        row: rowNumber,
        message: 'Self-reference detected.',
      });
    }

    if (componentCode && componentType === 'RAW_INGREDIENT' && !rawCodes.has(componentCode)) {
      addMissingComponent(
        missingComponents,
        legacyInventory,
        componentCode,
        componentType,
        'PREP_ITEM',
        prepCode,
        prepName,
        'Coffee_Bond_New_Menu_Prep_BOM_Import.csv',
        row.bomUOM,
      );
    }

    if (componentCode && componentType === 'PREP_ITEM' && !prepMasterCodes.has(componentCode)) {
      addMissingComponent(
        missingComponents,
        legacyInventory,
        componentCode,
        componentType,
        'PREP_ITEM',
        prepCode,
        prepName,
        'Coffee_Bond_New_Menu_Prep_BOM_Import.csv',
        row.bomUOM,
      );
    }
  });

  finishedSummaryRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const code = normalizeCode(row.fgCode);
    const salePrice = toNumber(row.salePrice);
    const prepStation = normalizeCode(row.prepStation);
    const itemType = normalizeCode(row.itemType);

    FINISHED_REQUIRED_FIELDS.forEach((field) => {
      if (!cleanValue(row[field])) {
        issues.push({
          area: 'Finished Summary',
          severity: 'error',
          code,
          row: rowNumber,
          message: `Missing required field: ${field}`,
        });
      }
    });

    if (code && !isValidCode(code)) {
      issues.push({
        area: 'Finished Summary',
        severity: 'error',
        code,
        row: rowNumber,
        message: 'fgCode must be uppercase snake case.',
      });
    }

    if (!Number.isFinite(salePrice) || salePrice < 0) {
      issues.push({
        area: 'Finished Summary',
        severity: 'error',
        code,
        row: rowNumber,
        message: 'salePrice must be 0 or greater.',
      });
    }

    if (prepStation && !VALID_PREP_STATIONS.has(prepStation)) {
      issues.push({
        area: 'Finished Summary',
        severity: 'error',
        code,
        row: rowNumber,
        message: `Invalid prepStation: ${row.prepStation}`,
      });
    }

    if (itemType && !VALID_ITEM_TYPES.has(itemType)) {
      issues.push({
        area: 'Finished Summary',
        severity: 'error',
        code,
        row: rowNumber,
        message: `Invalid itemType: ${row.itemType}`,
      });
    }

    const productionMode = normalizeCode(row.productionMode);
    if (productionMode && !VALID_PRODUCTION_MODES.has(productionMode)) {
      issues.push({
        area: 'Finished Summary',
        severity: 'error',
        code,
        row: rowNumber,
        message: `Invalid productionMode: ${row.productionMode}`,
      });
    }
  });

  const finishedHeaders = getHeaders(finishedSummaryRows);
  if (!finishedHeaders.has('productionMode')) {
    issues.push({
      area: 'Finished Summary',
      severity: 'warning',
      message: 'productionMode column is missing. MADE_TO_ORDER rows will import as Made to Order unless manually classified as Assembled to Order.',
    });
  }

  finishedBomRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const fgCode = normalizeCode(row.fgCode);
    const fgName = cleanValue(row.fgName);
    const componentType = normalizeComponentType(row.bomComponentType);
    const componentCode = normalizeCode(row.bomComponentCode);
    const itemType = normalizeCode(row.itemType);

    if (itemType !== 'NO_STOCK' || componentCode) {
      if (!componentCode) {
        issues.push({
          area: 'Finished Goods BOM',
          severity: 'error',
          code: fgCode,
          row: rowNumber,
          message: 'Missing component code.',
        });
      }

      if (!['RAW_INGREDIENT', 'PREP_ITEM', 'PACKAGING', 'FINISHED_GOOD'].includes(componentType)) {
        issues.push({
          area: 'Finished Goods BOM',
          severity: 'error',
          code: fgCode,
          row: rowNumber,
          message: 'Finished BOM component type must be RAW, PREP, PACKAGING, or FINISHED_GOOD.',
        });
      }

      const quantity = toNumber(row.bomQuantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        issues.push({
          area: 'Finished Goods BOM',
          severity: 'error',
          code: fgCode,
          row: rowNumber,
          message: 'bomQuantity must be greater than 0.',
        });
      }
    }

    if (fgCode && componentCode === fgCode) {
      issues.push({
        area: 'Finished Goods BOM',
        severity: 'error',
        code: fgCode,
        row: rowNumber,
        message: 'Self-reference detected.',
      });
    }

    if (componentCode && ['RAW_INGREDIENT', 'PACKAGING'].includes(componentType) && !rawCodes.has(componentCode)) {
      addMissingComponent(
        missingComponents,
        legacyInventory,
        componentCode,
        componentType,
        'FINISHED_GOOD',
        fgCode,
        fgName,
        'Coffee_Bond_New_Menu_Finished_Items_BOM_Import.csv',
        row.bomUOM,
      );
    }

    if (componentCode && componentType === 'PREP_ITEM' && !prepMasterCodes.has(componentCode)) {
      addMissingComponent(
        missingComponents,
        legacyInventory,
        componentCode,
        componentType,
        'FINISHED_GOOD',
        fgCode,
        fgName,
        'Coffee_Bond_New_Menu_Finished_Items_BOM_Import.csv',
        row.bomUOM,
      );
    }

    if (componentCode && componentType === 'FINISHED_GOOD' && !finishedMasterCodes.has(componentCode)) {
      addMissingComponent(
        missingComponents,
        legacyInventory,
        componentCode,
        componentType,
        'FINISHED_GOOD',
        fgCode,
        fgName,
        'Coffee_Bond_New_Menu_Finished_Items_BOM_Import.csv',
        row.bomUOM,
      );
    }
  });

  const dedupedMissing = Array.from(
    new Map(
      missingComponents.map((row) => [
        `${row.missingCode}|${row.referencedByType}|${row.referencedByCode}|${row.sourceFile}`,
        row,
      ]),
    ).values(),
  ).sort((a, b) => a.missingCode.localeCompare(b.missingCode));

  const blockingIssueCount = issues.filter((issue) => issue.severity === 'error').length + dedupedMissing.length;
  const status: ReadinessStatus = blockingIssueCount > 0
    ? 'NEEDS_CLEANUP'
    : zeroCostIngredients.length > 0
      ? 'COSTING_INCOMPLETE'
      : 'READY_TO_IMPORT';

  return {
    status,
    counts: {
      rawRows: rawRows.length,
      rawDuplicateCodes: rawDuplicateCodes.length,
      zeroCostIngredients: zeroCostIngredients.length,
      prepSummaryRows: prepSummaryRows.length,
      prepBomRows: prepBomRows.length,
      prepItemsInBom: prepBomCodes.size,
      finishedSummaryRows: finishedSummaryRows.length,
      finishedBomRows: finishedBomRows.length,
      finishedGoodsInBom: finishedBomCodes.size,
      missingComponentReferences: dedupedMissing.length,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
      legacyInventoryRows: legacyInventory.size,
    },
    issues,
    missingComponents: dedupedMissing,
    zeroCostIngredients,
  };
}

const missingComponentColumns = [
  'missingCode',
  'referencedByType',
  'referencedByCode',
  'referencedByName',
  'sourceFile',
  'suggestedCategory',
  'suggestedPurchaseUOM',
  'suggestedUsageUOM',
  'suggestedConversionFactor',
  'suggestedPurchaseCost',
  'foundInLegacyExcel',
  'legacyName',
  'notes',
];

const zeroCostColumns = [
  'code',
  'name',
  'category',
  'purchaseUOM',
  'usageUOM',
  'currentPurchaseCost',
  'suggestedPurchaseCost',
  'notes',
];

export default function Phase7AValidation() {
  const [files, setFiles] = useState<Partial<Record<FileKey, File>>>({});
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState('');

  const requiredFilesReady = useMemo(
    () => FILE_SPECS.filter((spec) => spec.required).every((spec) => files[spec.key]),
    [files],
  );

  const handleFileChange = (key: FileKey, file?: File) => {
    setFiles((prev) => ({ ...prev, [key]: file }));
    setReport(null);
    setError('');
  };

  const runValidation = async () => {
    setError('');
    setReport(null);

    if (!requiredFilesReady) {
      setError('Select all required Coffee Bond import files before running validation.');
      return;
    }

    setIsRunning(true);
    try {
      const rowsByKey = {} as Record<FileKey, RowData[]>;
      for (const spec of FILE_SPECS) {
        const file = files[spec.key];
        if (!file) {
          rowsByKey[spec.key] = [];
          continue;
        }
        rowsByKey[spec.key] = await readRows(file, spec.key === 'legacyExcel' ? 'GlobalInventory' : undefined);
      }

      setReport(buildValidationReport(rowsByKey));
    } catch (err: any) {
      setError(err?.message || 'Validation failed while reading files.');
    } finally {
      setIsRunning(false);
    }
  };

  const statusStyles = {
    READY_TO_IMPORT: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    COSTING_INCOMPLETE: 'bg-amber-50 text-amber-800 border-amber-200',
    NEEDS_CLEANUP: 'bg-red-50 text-red-800 border-red-200',
  } satisfies Record<ReadinessStatus, string>;

  const statusText = {
    READY_TO_IMPORT: 'Ready to import',
    COSTING_INCOMPLETE: 'Costing incomplete',
    NEEDS_CLEANUP: 'Needs cleanup',
  } satisfies Record<ReadinessStatus, string>;

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6 pb-20">
      <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start gap-4 justify-between">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-amber-50 text-amber-700 rounded-xl flex items-center justify-center shrink-0">
              <ShieldCheck size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-neutral-900">Phase 7A Validation</h2>
              <p className="text-sm font-medium text-neutral-500 mt-1">
                Validate Coffee Bond menu, inventory, and BOM files before any Firestore import.
              </p>
            </div>
          </div>

          <div className="border border-blue-200 bg-blue-50 text-blue-800 rounded-xl p-3 text-sm max-w-md">
            This screen only reads selected files in your browser and creates CSV downloads.
            It has no import button and performs no Firestore writes.
          </div>
        </div>
      </div>

      <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6 md:p-8">
        <div className="flex items-center gap-3 mb-5">
          <FileSpreadsheet className="text-[#5c4033]" size={22} />
          <h3 className="text-lg font-black text-neutral-900">Select files</h3>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {FILE_SPECS.map((spec) => (
            <label key={spec.key} className="border border-neutral-200 rounded-xl p-4 bg-neutral-50/60">
              <div className="flex justify-between gap-3 mb-3">
                <div>
                  <div className="font-bold text-neutral-800">
                    {spec.label}
                    {spec.required && <span className="text-red-500 ml-1">*</span>}
                  </div>
                  <div className="text-xs text-neutral-500 font-mono break-all">{spec.expectedName}</div>
                </div>
                {files[spec.key] ? (
                  <CheckCircle2 className="text-emerald-600 shrink-0" size={20} />
                ) : (
                  <Upload className="text-neutral-400 shrink-0" size={20} />
                )}
              </div>
              <input
                type="file"
                accept={spec.accept}
                onChange={(event) => handleFileChange(spec.key, event.target.files?.[0])}
                className="block w-full text-sm text-neutral-600 file:mr-4 file:rounded-lg file:border-0 file:bg-[#5c4033] file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-[#3e2723]"
              />
              {files[spec.key] && (
                <div className="mt-2 text-xs text-neutral-500 truncate">
                  Selected: {files[spec.key]?.name}
                </div>
              )}
            </label>
          ))}
        </div>

        {error && (
          <div className="mt-5 bg-red-50 text-red-800 border border-red-200 rounded-xl p-4 text-sm font-semibold">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-col sm:flex-row gap-3 sm:items-center">
          <button
            type="button"
            onClick={runValidation}
            disabled={isRunning || !requiredFilesReady}
            className="px-5 py-3 bg-[#5c4033] text-white rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? <Loader2 size={18} className="animate-spin" /> : <FileCheck2 size={18} />}
            Run Phase 7A Validation
          </button>
          <p className="text-xs text-neutral-500">
            Required files must be selected. Legacy Excel is optional and only improves cleanup suggestions.
          </p>
        </div>
      </div>

      {report && (
        <>
          <div className={`border rounded-2xl p-5 ${statusStyles[report.status]}`}>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-wider opacity-80">Readiness status</div>
                <div className="text-2xl font-black">{statusText[report.status]}</div>
              </div>
              <div className="text-sm font-semibold">
                {report.status === 'READY_TO_IMPORT' && 'No blocking structure issues found.'}
                {report.status === 'COSTING_INCOMPLETE' && 'Structure passed, but ingredient costs need completion.'}
                {report.status === 'NEEDS_CLEANUP' && 'Blocking validation issues or missing component references were found.'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              ['Raw rows', report.counts.rawRows],
              ['Zero-cost ingredients', report.counts.zeroCostIngredients],
              ['Prep BOM rows', report.counts.prepBomRows],
              ['Prep items', report.counts.prepItemsInBom],
              ['Finished BOM rows', report.counts.finishedBomRows],
              ['Finished items', report.counts.finishedGoodsInBom],
              ['Missing references', report.counts.missingComponentReferences],
              ['Errors', report.counts.errors],
            ].map(([label, value]) => (
              <div key={label} className="bg-white border border-neutral-200 rounded-xl p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">{label}</div>
                <div className="text-2xl font-black text-neutral-900 mt-1">{value}</div>
              </div>
            ))}
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
              <div>
                <h3 className="text-lg font-black text-neutral-900">Cleanup CSVs</h3>
                <p className="text-sm text-neutral-500">Downloads are generated from the validation result only.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  disabled={report.missingComponents.length === 0}
                  onClick={() => downloadCsv('Coffee_Bond_Phase7A_Missing_Components_Cleanup.csv', report.missingComponents, missingComponentColumns)}
                  className="px-4 py-2 rounded-xl bg-red-100 text-red-800 font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Download size={16} />
                  Missing Components CSV
                </button>
                <button
                  type="button"
                  disabled={report.zeroCostIngredients.length === 0}
                  onClick={() => downloadCsv('Coffee_Bond_Phase7A_Zero_Cost_Ingredients.csv', report.zeroCostIngredients, zeroCostColumns)}
                  className="px-4 py-2 rounded-xl bg-amber-100 text-amber-800 font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Download size={16} />
                  Zero-Cost Ingredients CSV
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-neutral-200 rounded-xl p-4">
                <div className="text-sm font-black text-neutral-800 mb-1">Missing components</div>
                <div className="text-3xl font-black text-red-700">{report.missingComponents.length}</div>
                <p className="text-xs text-neutral-500 mt-2">
                  One row per missing component reference, with legacy lookup hints when available.
                </p>
              </div>
              <div className="border border-neutral-200 rounded-xl p-4">
                <div className="text-sm font-black text-neutral-800 mb-1">Zero-cost ingredients</div>
                <div className="text-3xl font-black text-amber-700">{report.zeroCostIngredients.length}</div>
                <p className="text-xs text-neutral-500 mt-2">
                  Active ingredients that need purchase costs for accurate recipe costing.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-neutral-200 rounded-2xl shadow-sm p-6">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={20} className="text-amber-600" />
              <h3 className="text-lg font-black text-neutral-900">Validation issues</h3>
            </div>

            {report.issues.length === 0 ? (
              <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-xl p-4 text-sm font-semibold">
                No validation issues found.
              </div>
            ) : (
              <div className="border border-neutral-200 rounded-xl overflow-hidden">
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-sm min-w-[760px]">
                    <thead className="bg-neutral-50 sticky top-0">
                      <tr className="border-b border-neutral-200">
                        <th className="text-left p-3 font-black text-neutral-500">Severity</th>
                        <th className="text-left p-3 font-black text-neutral-500">Area</th>
                        <th className="text-left p-3 font-black text-neutral-500">Code</th>
                        <th className="text-left p-3 font-black text-neutral-500">Row</th>
                        <th className="text-left p-3 font-black text-neutral-500">Issue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {report.issues.slice(0, 300).map((issue, index) => (
                        <tr key={`${issue.area}-${issue.code || 'global'}-${issue.row || index}-${issue.message}`}>
                          <td className="p-3">
                            <span className={`px-2 py-1 rounded-md text-xs font-black uppercase ${
                              issue.severity === 'error'
                                ? 'bg-red-100 text-red-700'
                                : issue.severity === 'warning'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-blue-100 text-blue-700'
                            }`}>
                              {issue.severity}
                            </span>
                          </td>
                          <td className="p-3 font-semibold text-neutral-700">{issue.area}</td>
                          <td className="p-3 font-mono text-xs text-neutral-600">{issue.code || '-'}</td>
                          <td className="p-3 text-neutral-600">{issue.row || '-'}</td>
                          <td className="p-3 text-neutral-700">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.issues.length > 300 && (
                  <div className="bg-neutral-50 border-t border-neutral-200 p-3 text-xs text-neutral-500">
                    Showing first 300 issues. Download cleanup CSVs for detailed missing component rows.
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
