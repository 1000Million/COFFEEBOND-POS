import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Power,
  Search,
  ShieldCheck,
  Store as StoreIcon,
  Upload,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { db, functions } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';
import { beginCriticalOperation, OFFLINE_ACTION_MESSAGE, requireOnlineAction } from '../../lib/connectivity';

type ModuleId =
  | 'OPERATING'
  | 'MENU'
  | 'ADD_ONS'
  | 'KOT'
  | 'INVENTORY'
  | 'CUSTOMER_ORDERING'
  | 'LEGAL_RECEIPT' | 'ITEM_OVERRIDES';

type InventoryOption = 'STRUCTURE_ONLY' | 'CONFIGURED_OPENING' | 'CURRENT_STOCK_ADVANCED';

type LocationForm = {
  displayName: string;
  storeCode: string;
  legalEntityName: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
  phone: string;
  email: string;
  gstRegistered: boolean;
  gstin: string;
  gstRate: string;
  receiptName: string;
  receiptFooter: string;
  timezone: string;
  inventoryMode: 'FINISHED_GOODS';
  gstDecisionReviewed: boolean;
  receiptReviewComplete: boolean;
};

type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

type LocationSummary = {
  store: Store;
  staffCount: number;
  menuCount: number;
  stockCount: number;
  gstLabel: string;
};

type ProvisioningPreview = {
  destinationStore: Record<string, unknown>;
  sourceTemplate: { id: string; code: string; name: string } | null;
  selectedModules: ModuleId[];
  inventoryOption: InventoryOption;
  counts: Record<string, number>;
  writesByCollection: Record<string, number>;
  writeOperationsByCollection: Record<string, { creates: number; updates: number }>;
  skippedDocumentsByCollection: Record<string, number>;
  skippedUncountedScopes: string[];
  planChecksum: string;
  legalGstSelected: boolean;
  customerOrderingInitialStatus: string;
  staffAssignmentCount: number;
  staffAssignmentValidation?: {
    selectedCount: number;
    hasSetupLead: boolean;
    hasPosCapable: boolean;
    changeCount: number;
  };
  warnings: string[];
  validationErrors: ValidationIssue[];
  validationWarnings: string[];
  neverCopiedCollections: string[];
  safeToCreateDraft: boolean;
  canCreate: boolean;
  applyReadiness: string;
  sourceStoreId: string | null;
  sourceStoreCode: string | null;
  destinationStoreId: string;
  destinationConflictCount: number;
  countsByCollection: Record<string, number>;
  totalProposedWrites: number;
  dryRunChecksum: string;
  firestoreWritesPerformed: number;
};

type StaffOption = {
  uid: string;
  displayName: string;
  email: string;
  role: string;
  isActive: boolean;
  assignedStoreIds: string[];
};

type OpeningStockEditorRow = {
  stockId: string;
  itemName: string;
  itemCode: string;
  itemType: string;
  unit: string;
  openingStock: string;
  currentStock: string;
  unitCost: string;
  confirmed: boolean;
  validationStatus: 'VALID' | 'INVALID' | 'UNCONFIRMED';
  validationMessage: string;
};

type StockCsvPreviewRow = {
  rowNumber: number;
  itemCode: string;
  openingStock: string;
  unitCost: string;
  confirmed: boolean;
  status: 'READY' | 'UNMATCHED' | 'DUPLICATE' | 'INVALID';
  message: string;
};

const MODULES: Array<{
  id: ModuleId;
  label: string;
  description: string;
  recommended: boolean;
}> = [
  { id: 'OPERATING', label: 'Store operating configuration', description: 'Hours, order types, POS, printers, payments, discounts, and business-day settings.', recommended: true },
  { id: 'MENU', label: 'Menu configuration', description: 'Product, category, price, tax, visibility, and online-menu assignments.', recommended: true },
  { id: 'ADD_ONS', label: 'Add-on configuration', description: 'Reuse approved global Finished Good add-on assignments without duplicating options.', recommended: true },
  { id: 'KOT', label: 'KOT configuration', description: 'Reuse approved Finished Good station routing and copy store printer settings.', recommended: true },
  { id: 'INVENTORY', label: 'Inventory structure', description: 'Create destination stock rows and preserve catalogue, units, and reorder configuration.', recommended: true },
  { id: 'CUSTOMER_ORDERING', label: 'Customer-ordering configuration', description: 'Pickup options, hours, instructions, and visibility settings. Ordering stays disabled.', recommended: true },
  { id: 'LEGAL_RECEIPT', label: 'Legal and receipt configuration', description: 'GST, legal entity, receipt footer, and invoice numbering. Off by default.', recommended: false },
  { id: 'ITEM_OVERRIDES', label: 'Store item overrides', description: 'Copies explicit store-level price, availability, customer-menu visibility and display-order overrides. If left off, the new store inherits global item settings.', recommended: false },
];

const RECOMMENDED_MODULES = MODULES.filter((module) => module.recommended).map((module) => module.id);
const ALL_MODULES = MODULES.map((module) => module.id);
const READINESS_LABELS: Record<string, string> = {
  basicDetailsComplete: 'Basic store details complete',
  legalGstReviewed: 'Legal/GST configuration reviewed',
  menuCopied: 'Menu copied',
  productAvailabilityReviewed: 'Product availability reviewed',
  addOnsReviewed: 'Add-ons reviewed',
  kotRoutingReviewed: 'KOT routing reviewed',
  inventoryStructureCreated: 'Inventory structure created',
  openingStockReviewed: 'Opening stock reviewed',
  receiptConfigurationReviewed: 'Receipt configuration reviewed',
  staffAssigned: 'Staff assigned',
  posTestCompleted: 'POS test completed',
  customerOrderingTestCompleted: 'Customer-ordering test completed',
};

type SetupStepKey =
  | 'legalGstReviewed'
  | 'receiptConfigurationReviewed'
  | 'productAvailabilityReviewed'
  | 'addOnsReviewed'
  | 'kotRoutingReviewed'
  | 'openingStockReviewed'
  | 'staffAssigned'
  | 'posTestCompleted';

const SETUP_STEPS: Array<{
  key: SetupStepKey;
  label: string;
  description: string;
  wizardStep: number;
  automatic: boolean;
}> = [
  { key: 'legalGstReviewed', label: 'Review legal and GST', description: 'GST registration, GSTIN, tax rate and legal entity are consistent.', wizardStep: 1, automatic: true },
  { key: 'receiptConfigurationReviewed', label: 'Configure receipt', description: 'Receipt name and footer are ready for test billing.', wizardStep: 1, automatic: true },
  { key: 'productAvailabilityReviewed', label: 'Review products', description: 'At least one active sellable item is enabled for this location.', wizardStep: 5, automatic: true },
  { key: 'addOnsReviewed', label: 'Validate add-ons', description: 'Enabled add-on group references resolve to active groups and options.', wizardStep: 5, automatic: true },
  { key: 'kotRoutingReviewed', label: 'Validate KOT routing', description: 'Operational menu items route to Barista, Kitchen or None.', wizardStep: 5, automatic: true },
  { key: 'openingStockReviewed', label: 'Confirm opening stock', description: 'Opening quantities have been entered or zero stock has been explicitly accepted.', wizardStep: 3, automatic: false },
  { key: 'staffAssigned', label: 'Assign staff', description: 'Active Store Manager or POS staff are assigned to this location.', wizardStep: 4, automatic: true },
  { key: 'posTestCompleted', label: 'Complete POS test', description: 'A setup-test bill exercises receipt, KOT, stock deduction and void reversal.', wizardStep: 6, automatic: false },
];

const GSTIN_PATTERN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const BAKED_BY_BOND_51_STORE_ID = 'BAKED_BY_BOND_51';
const POS_LAUNCH_EXCEPTION_HOURS = 24;

const defaultForm: LocationForm = {
  displayName: '',
  storeCode: '',
  legalEntityName: '',
  address: '',
  city: '',
  state: '',
  pinCode: '',
  phone: '',
  email: '',
  gstRegistered: false,
  gstin: '',
  gstRate: '5',
  receiptName: '',
  receiptFooter: '',
  timezone: 'Asia/Kolkata',
  inventoryMode: 'FINISHED_GOODS',
  gstDecisionReviewed: false,
  receiptReviewComplete: false,
};

const previewStoreProvisioning = httpsCallable<Record<string, unknown>, ProvisioningPreview>(
  functions,
  'previewStoreProvisioning',
);
const createStoreFromTemplate = httpsCallable<Record<string, unknown>, {
  storeId: string;
  jobId: string;
  status: string;
  message: string;
}>(functions, 'createStoreFromTemplate');
const activateStoreCallable = httpsCallable<{ storeId: string }, Record<string, unknown>>(
  functions,
  'activateStore',
);
const enableInternalPosTestCallable = httpsCallable<{ storeId: string }, Record<string, unknown>>(
  functions,
  'enableInternalPosTest',
);
const markInternalPosTestPassedCallable = httpsCallable<{ storeId: string }, Record<string, unknown>>(
  functions,
  'markInternalPosTestPassed',
);
const saveLocationOpeningStockCallable = httpsCallable<{
  storeId: string;
  rows?: Array<{ stockId: string; openingStock: number; costPerUnit: number; confirmed: boolean }>;
  confirmAllZero?: boolean;
  typedConfirmation?: string;
}, Record<string, unknown>>(
  functions,
  'saveLocationOpeningStock',
);
const saveLocationStaffAssignmentsCallable = httpsCallable<{
  storeId: string;
  selectedUserIds: string[];
}, Record<string, unknown>>(
  functions,
  'saveLocationStaffAssignments',
);
const setPosLaunchExceptionCallable = httpsCallable<{
  storeId: string;
  enabled: boolean;
  reason: string;
  expiresAt: string;
}, Record<string, unknown>>(
  functions,
  'setPosLaunchException',
);
const updateStoreConfigurationCallable = httpsCallable<Record<string, unknown>, Record<string, unknown>>(
  functions,
  'updateStoreConfiguration',
);
const setStoreCustomerOrderingCallable = httpsCallable<{ storeId: string; enabled: boolean }, Record<string, unknown>>(
  functions,
  'setStoreCustomerOrdering',
);

function dateLabel(value: any): string {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'Not recorded';
}

function timestampMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1000000);
  return 0;
}

function isBakedByBond51(store: Store): boolean {
  return [store.id, store.code, store.storeCode].some((value) => String(value || '') === BAKED_BY_BOND_51_STORE_ID);
}

function isGoldenI(store: Store): boolean {
  return store.id === 'GOLDEN_I' && (store.code === 'GOLDEN_I' || store.storeCode === 'GOLDEN_I');
}

function isLegacyMigratedGoldenI(store: Store): boolean {
  return isGoldenI(store) && store.onboardingMode === 'LEGACY_MIGRATED';
}

function customerOrderingFullyEnabled(store: Store): boolean {
  return store.customerOrderingEnabled === true
    && store.onlineOrderingEnabled === true
    && store.publicOrderingEnabled === true
    && store.acceptingOrders === true
    && store.isAcceptingOrders === true;
}

function customerOrderingOperational(store: Store): boolean {
  return isGoldenI(store)
    ? customerOrderingFullyEnabled(store)
    : store.customerOrderingEnabled === true || store.onlineOrderingEnabled === true;
}

function legacyMigrationWarnings(store: Store): string[] {
  if (!isLegacyMigratedGoldenI(store)) return [];
  const warnings: string[] = [];
  if (!store.city || !store.state || !/^[1-9][0-9]{5}$/.test(String(store.pinCode || ''))) {
    warnings.push('Structured city, state or PIN details are not recorded; the existing full address remains in use.');
  }
  if (store.readiness?.openingStockReviewed !== true && store.openingStockConfirmed !== true) {
    warnings.push('Opening stock has not been reviewed in the new onboarding workflow.');
  }
  if (store.readiness?.posTestCompleted !== true && store.posTestCompleted !== true) {
    warnings.push('The new internal POS setup test is not recorded for this migrated store.');
  }
  if (store.readiness?.customerOrderingTestCompleted !== true) {
    warnings.push('The new customer-ordering setup test is not recorded for this migrated store.');
  }
  const legacyRecord = store as Store & Record<string, unknown>;
  if (!legacyRecord.openingHours && !legacyRecord.orderingHours) warnings.push('Store and ordering hours are not configured.');
  if (!(store.legalName || store.legalEntityName) || !store.stateName || !store.stateCode || !legacyRecord.receiptSettings) {
    warnings.push('Legal or receipt fields are incomplete; existing tax fallback remains in effect.');
  }
  return warnings;
}

function activePosLaunchException(store: Store): boolean {
  const exception = store.posLaunchException;
  return exception?.enabled === true && timestampMillis(exception.expiresAt) > Date.now();
}

function openingStockPending(store: Store): boolean {
  const readiness = store.readiness || {};
  return readiness.openingStockReviewed !== true && store.openingStockConfirmed !== true;
}

function normalizedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_');
}

function newProvisioningJobId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `store_${random}`;
}

function numericValue(value: string | number | undefined): number {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

const DECIMAL_OPENING_STOCK_UNITS = new Set(['G', 'KG', 'ML', 'L']);
const INTEGER_OPENING_STOCK_UNITS = new Set(['PCS', 'SLICE', 'PACK', 'BOX', 'BOTTLE', 'BAG', 'TRAY']);
const OPENING_STOCK_UNIT_ALIASES: Record<string, string> = {
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  SLICES: 'SLICE',
};

function normaliseUnit(value: string): string {
  const rawUnit = String(value || '').trim().toUpperCase();
  return OPENING_STOCK_UNIT_ALIASES[rawUnit] || rawUnit;
}

function isSupportedOpeningStockUnit(unit: string): boolean {
  const normalised = normaliseUnit(unit);
  return DECIMAL_OPENING_STOCK_UNITS.has(normalised) || INTEGER_OPENING_STOCK_UNITS.has(normalised);
}

function unitAllowsDecimal(unit: string): boolean {
  return DECIMAL_OPENING_STOCK_UNITS.has(normaliseUnit(unit));
}

function validateOpeningStockEditorRow(row: OpeningStockEditorRow): OpeningStockEditorRow {
  const opening = numericValue(row.openingStock);
  const unitCost = numericValue(row.unitCost);
  const messages: string[] = [];
  if (!Number.isFinite(opening) || opening < 0) messages.push('Opening quantity must be zero or positive.');
  const unit = normaliseUnit(row.unit);
  if (!isSupportedOpeningStockUnit(unit)) {
    messages.push(`${unit || 'This unit'} is not a supported opening-stock unit.`);
  }
  if (isSupportedOpeningStockUnit(unit) && Number.isFinite(opening) && !unitAllowsDecimal(unit) && !Number.isInteger(opening)) {
    messages.push(`${unit || 'This unit'} requires a whole-number quantity.`);
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) messages.push('Unit cost cannot be negative.');
  if (!row.confirmed) messages.push('Confirm this row.');
  return {
    ...row,
    currentStock: Number.isFinite(opening) ? String(opening) : row.currentStock,
    validationStatus: messages.length > 0 ? (row.confirmed ? 'INVALID' : 'UNCONFIRMED') : 'VALID',
    validationMessage: messages.join(' '),
  };
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(current.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  row.push(current.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function statusFor(store: Store): string {
  return store.status || (store.isActive ? 'ACTIVE' : 'DRAFT');
}

function badgeClass(active: boolean, tone: 'green' | 'amber' | 'neutral' = 'neutral'): string {
  if (!active) return 'border-neutral-200 bg-neutral-50 text-neutral-500';
  if (tone === 'green') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-[#decfc2] bg-[#f7f0e9] text-[#5c4033]';
}

function storeDisplayName(store: Store): string {
  return store.displayName || store.name || store.code || store.id;
}

function setupStepComplete(summary: LocationSummary, key: SetupStepKey): boolean {
  const store = summary.store as Store & Record<string, any>;
  const readiness = store.readiness || {};
  if (key === 'staffAssigned') return summary.staffCount > 0;
  if (key === 'productAvailabilityReviewed') return summary.menuCount > 0;
  if (key === 'legalGstReviewed') {
    if (store.gstRegistered === true) {
      return GSTIN_PATTERN.test(String(store.gstin || '').trim().toUpperCase()) && Number(store.gstRate || 0) > 0;
    }
    return !store.gstin;
  }
  if (key === 'receiptConfigurationReviewed') return Boolean(store.receiptName || store.tradeName || store.name || store.displayName);
  if (key === 'openingStockReviewed') return readiness.openingStockReviewed === true || store.openingStockConfirmed === true;
  if (key === 'posTestCompleted') return readiness.posTestCompleted === true || store.posTestCompleted === true;
  return readiness[key] === true || statusFor(store) === 'ACTIVE';
}

function setupProgress(summary: LocationSummary): { complete: number; total: number; incomplete: typeof SETUP_STEPS } {
  const incomplete = SETUP_STEPS.filter((step) => !setupStepComplete(summary, step.key));
  return {
    complete: SETUP_STEPS.length - incomplete.length,
    total: SETUP_STEPS.length,
    incomplete,
  };
}

export default function LocationManagement() {
  const { staffProfile } = useAuth();
  const [summaries, setSummaries] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [selectedSummary, setSelectedSummary] = useState<LocationSummary | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [form, setForm] = useState<LocationForm>(defaultForm);
  const [templateMode, setTemplateMode] = useState<'BLANK' | 'COPY'>('BLANK');
  const [sourceStoreId, setSourceStoreId] = useState('');
  const [selectedModules, setSelectedModules] = useState<ModuleId[]>(RECOMMENDED_MODULES);
  const [inventoryOption, setInventoryOption] = useState<InventoryOption>('STRUCTURE_ONLY');
  const [inventoryConfirmation, setInventoryConfirmation] = useState('');
  const [inventoryReason, setInventoryReason] = useState('');
  const [plannedStaffUids, setPlannedStaffUids] = useState<string[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [confirmLegalEntity, setConfirmLegalEntity] = useState(false);
  const [confirmDuplicateName, setConfirmDuplicateName] = useState(false);
  const [preview, setPreview] = useState<ProvisioningPreview | null>(null);
  const [wizardError, setWizardError] = useState('');
  const [provisioningJobId, setProvisioningJobId] = useState(newProvisioningJobId());
  const [actioning, setActioning] = useState('');
  const [editStore, setEditStore] = useState<Store | null>(null);
  const [editForm, setEditForm] = useState<Partial<LocationForm>>({});
  const [openingStockSummary, setOpeningStockSummary] = useState<LocationSummary | null>(null);
  const [openingStockRows, setOpeningStockRows] = useState<OpeningStockEditorRow[]>([]);
  const [openingStockSearch, setOpeningStockSearch] = useState('');
  const [openingStockFilter, setOpeningStockFilter] = useState<'ALL' | 'NEEDS_ATTENTION' | 'CONFIRMED'>('ALL');
  const [openingStockLoading, setOpeningStockLoading] = useState(false);
  const [openingStockError, setOpeningStockError] = useState('');
  const [openingStockDirty, setOpeningStockDirty] = useState(false);
  const [zeroStockConfirmation, setZeroStockConfirmation] = useState('');
  const [csvPreviewRows, setCsvPreviewRows] = useState<StockCsvPreviewRow[]>([]);
  const [staffAssignmentSummary, setStaffAssignmentSummary] = useState<LocationSummary | null>(null);
  const [draftStaffUids, setDraftStaffUids] = useState<string[]>([]);

  const canAccess = staffProfile?.role === 'ADMIN' && staffProfile.isActive === true;

  const loadLocations = async () => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [storesSnap, usersSnap, finishedSnap, stockSnap, gstSnap] = await Promise.all([
        getDocs(collection(db, 'stores')),
        getDocs(collection(db, 'users')),
        getDocs(collection(db, 'finishedGoods')),
        getDocs(collection(db, 'storeStock')),
        getDoc(doc(db, 'appSettings', 'gstConfig')),
      ]);
      const stores = storesSnap.docs.map((storeDoc) => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
      const users = usersSnap.docs.map((userDoc) => ({ id: userDoc.id, ...userDoc.data() } as Record<string, unknown>));
      const nextStaffOptions: StaffOption[] = users
        .filter((profile) => profile.isActive === true && profile.role !== 'FRANCHISE_VIEWER')
        .map((profile) => ({
          uid: String(profile.uid || profile.id),
          displayName: String(profile.displayName || profile.name || profile.email || profile.id),
          email: String(profile.email || ''),
          role: String(profile.role || 'TRAINEE'),
          isActive: profile.isActive === true,
          assignedStoreIds: [
            ...(Array.isArray(profile.storeIds) ? profile.storeIds : []),
            ...(Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []),
          ].filter((value, index, array): value is string => typeof value === 'string' && array.indexOf(value) === index),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email));
      const finishedGoods = finishedSnap.docs.map((itemDoc) => itemDoc.data() as Record<string, unknown>);
      const stockRows = stockSnap.docs.map((stockDoc) => stockDoc.data() as Record<string, unknown>);
      const gstConfig = gstSnap.exists() ? gstSnap.data() as Record<string, unknown> : {};
      const defaultGstRate = Number(gstConfig.defaultGstRate || gstConfig.defaultRate || gstConfig.gstRate || 0);
      const gstOverrides = gstConfig.storeOverrides && typeof gstConfig.storeOverrides === 'object'
        ? gstConfig.storeOverrides as Record<string, unknown>
        : {};
      const next = stores.map((store) => ({
        store,
        staffCount: users.filter((profile) => {
          const ids = [
            ...(Array.isArray(profile.storeIds) ? profile.storeIds : []),
            ...(Array.isArray(profile.assignedStoreIds) ? profile.assignedStoreIds : []),
          ];
          return profile.isActive === true && ids.includes(store.id);
        }).length,
        menuCount: finishedGoods.filter((item) => (
          Array.isArray(item.availableStoreIds) && item.availableStoreIds.includes(store.id)
        )).length,
        stockCount: stockRows.filter((row) => row.storeId === store.id).length,
        gstLabel: (() => {
          const override = Number(gstOverrides[store.id] || gstOverrides[store.code] || 0);
          const rate = override > 0 ? override : defaultGstRate;
          if (store.gstRegistered === true && !store.gstin) return 'Needs GSTIN';
          return rate > 0 ? `Configured (${rate}%)` : 'Not configured';
        })(),
      }));
      next.sort((a, b) => String(a.store.name || '').localeCompare(String(b.store.name || '')));
      setSummaries(next);
      setStaffOptions(nextStaffOptions);
      setSelectedSummary((current) => (
        current ? next.find((summary) => summary.store.id === current.store.id) || null : null
      ));
    } catch (err) {
      console.error('Failed to load Location Management', err);
      setError(err instanceof Error ? err.message : 'Could not load locations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLocations();
  }, [canAccess]);

  useEffect(() => {
    if (!openingStockDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [openingStockDirty]);

  const filteredSummaries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return summaries;
    return summaries.filter(({ store }) => (
      String(store.name || '').toLowerCase().includes(needle)
      || String(store.code || store.storeCode || store.id).toLowerCase().includes(needle)
      || String(store.city || '').toLowerCase().includes(needle)
    ));
  }, [search, summaries]);

  const storesById = useMemo(() => new Map(summaries.map((summary) => [summary.store.id, summary.store])), [summaries]);
  const staffSearchNeedle = staffSearch.trim().toLowerCase();
  const visibleStaffOptions = useMemo(() => (
    staffOptions.filter((person) => (
      !staffSearchNeedle
      || person.displayName.toLowerCase().includes(staffSearchNeedle)
      || person.email.toLowerCase().includes(staffSearchNeedle)
      || person.role.toLowerCase().includes(staffSearchNeedle)
    ))
  ), [staffOptions, staffSearchNeedle]);

  const staffRequirement = (uids: string[]) => {
    const selected = staffOptions.filter((person) => uids.includes(person.uid));
    return {
      selected,
      hasSetupLead: selected.some((person) => ['ADMIN', 'STORE_MANAGER'].includes(person.role)),
      hasPosCapable: selected.some((person) => ['ADMIN', 'STORE_MANAGER', 'CASHIER'].includes(person.role)),
    };
  };

  const togglePlannedStaff = (uid: string) => {
    setPreview(null);
    setPlannedStaffUids((current) => (
      current.includes(uid) ? current.filter((value) => value !== uid) : [...current, uid]
    ));
  };

  const updateOpeningStockRow = (stockId: string, changes: Partial<OpeningStockEditorRow>) => {
    setOpeningStockDirty(true);
    setOpeningStockRows((current) => current.map((row) => (
      row.stockId === stockId ? validateOpeningStockEditorRow({ ...row, ...changes }) : row
    )));
  };

  const loadOpeningStockRows = async (summary: LocationSummary) => {
    setOpeningStockSummary(summary);
    setOpeningStockLoading(true);
    setOpeningStockError('');
    setOpeningStockDirty(false);
    setCsvPreviewRows([]);
    setZeroStockConfirmation('');
    try {
      const snap = await getDocs(query(collection(db, 'storeStock'), where('storeId', '==', summary.store.id)));
      const rows = snap.docs
        .map((stockDoc) => {
          const data = stockDoc.data() as Record<string, unknown>;
          return validateOpeningStockEditorRow({
            stockId: stockDoc.id,
            itemName: String(data.stockItemName || data.inventoryItemName || data.stockItemCode || stockDoc.id),
            itemCode: String(data.stockItemCode || data.inventoryItemId || stockDoc.id),
            itemType: String(data.stockItemType || 'ITEM'),
            unit: String(data.uom || data.unit || ''),
            openingStock: String(data.openingStock ?? 0),
            currentStock: String(data.openingStock ?? 0),
            unitCost: String(data.costPerUnit ?? 0),
            confirmed: data.openingStockConfirmed === true,
            validationStatus: 'UNCONFIRMED',
            validationMessage: '',
          });
        })
        .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemCode.localeCompare(b.itemCode));
      setOpeningStockRows(rows);
    } catch (err: any) {
      setOpeningStockError(err?.message || 'Could not load opening stock rows.');
    } finally {
      setOpeningStockLoading(false);
    }
  };

  const closeOpeningStock = () => {
    if (openingStockDirty && !window.confirm('Discard unsaved opening stock changes?')) return;
    setOpeningStockSummary(null);
    setOpeningStockRows([]);
    setOpeningStockDirty(false);
    setCsvPreviewRows([]);
    setOpeningStockError('');
  };

  const downloadOpeningStockTemplate = () => {
    const header = ['itemCode', 'itemName', 'inventoryType', 'unit', 'openingQuantity', 'unitCost', 'confirmed'];
    const rows = openingStockRows.map((row) => [
      row.itemCode,
      row.itemName,
      row.itemType,
      row.unit,
      row.openingStock,
      row.unitCost,
      row.confirmed ? 'TRUE' : 'FALSE',
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([`${csv}\n`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${openingStockSummary?.store.code || 'location'}-opening-stock-template.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const previewOpeningStockCsv = async (file: File | null) => {
    if (!file) return;
    setOpeningStockError('');
    const text = await file.text();
    const parsed = parseCsv(text);
    const [headers = [], ...body] = parsed;
    const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
    const indexFor = (name: string) => normalizedHeaders.indexOf(name.toLowerCase());
    const itemCodeIndex = indexFor('itemCode');
    const openingIndex = indexFor('openingQuantity');
    const costIndex = indexFor('unitCost');
    const confirmedIndex = indexFor('confirmed');
    if (itemCodeIndex < 0 || openingIndex < 0 || costIndex < 0 || confirmedIndex < 0) {
      setCsvPreviewRows([]);
      setOpeningStockError('CSV must include itemCode, openingQuantity, unitCost and confirmed columns.');
      return;
    }
    const rowsByCode = new Map(openingStockRows.map((row) => [row.itemCode, row]));
    const seenCodes = new Set<string>();
    const previewRows = body.map((columns, index) => {
      const itemCode = String(columns[itemCodeIndex] || '').trim();
      const openingStock = String(columns[openingIndex] || '').trim();
      const unitCost = String(columns[costIndex] || '').trim();
      const confirmedText = String(columns[confirmedIndex] || '').trim().toUpperCase();
      const matched = rowsByCode.get(itemCode);
      let status: StockCsvPreviewRow['status'] = 'READY';
      const messages: string[] = [];
      if (!matched) {
        status = 'UNMATCHED';
        messages.push('No exact inventory item code match.');
      }
      if (seenCodes.has(itemCode)) {
        status = 'DUPLICATE';
        messages.push('Duplicate CSV item code.');
      }
      seenCodes.add(itemCode);
      const opening = numericValue(openingStock);
      const cost = numericValue(unitCost);
      if (!Number.isFinite(opening) || opening < 0) {
        status = 'INVALID';
        messages.push('Opening quantity must be zero or positive.');
      }
      const matchedUnit = matched ? normaliseUnit(matched.unit) : '';
      if (matched && !isSupportedOpeningStockUnit(matchedUnit)) {
        status = 'INVALID';
        messages.push(`${matchedUnit || 'This unit'} is not a supported opening-stock unit.`);
      }
      if (matched && isSupportedOpeningStockUnit(matchedUnit) && Number.isFinite(opening) && !unitAllowsDecimal(matchedUnit) && !Number.isInteger(opening)) {
        status = 'INVALID';
        messages.push(`${matchedUnit} requires a whole-number quantity.`);
      }
      if (!Number.isFinite(cost) || cost < 0) {
        status = 'INVALID';
        messages.push('Unit cost cannot be negative.');
      }
      const confirmed = ['TRUE', 'YES', '1'].includes(confirmedText);
      if (!confirmed) {
        status = 'INVALID';
        messages.push('confirmed must be TRUE.');
      }
      return {
        rowNumber: index + 2,
        itemCode,
        openingStock,
        unitCost,
        confirmed,
        status,
        message: messages.join(' ') || 'Ready to apply.',
      };
    });
    setCsvPreviewRows(previewRows);
  };

  const applyCsvPreviewToEditor = () => {
    const blocked = csvPreviewRows.filter((row) => row.status !== 'READY');
    if (blocked.length > 0) {
      setOpeningStockError('Resolve unmatched, duplicate or invalid CSV rows before applying.');
      return;
    }
    if (!window.confirm('Apply CSV values to the opening-stock editor? No Firestore write happens until Save Opening Stock.')) return;
    const csvByCode = new Map(csvPreviewRows.map((row) => [row.itemCode, row]));
    setOpeningStockRows((current) => current.map((row) => {
      const csvRow = csvByCode.get(row.itemCode);
      return csvRow
        ? validateOpeningStockEditorRow({
          ...row,
          openingStock: csvRow.openingStock,
          currentStock: csvRow.openingStock,
          unitCost: csvRow.unitCost,
          confirmed: true,
        })
        : row;
    }));
    setOpeningStockDirty(true);
  };

  const saveOpeningStockRows = async (confirmAllZero = false) => {
    if (!openingStockSummary) return;
    if (!requireOnlineAction()) {
      setOpeningStockError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const invalidRows = openingStockRows.map(validateOpeningStockEditorRow).filter((row) => row.validationStatus !== 'VALID');
    if (!confirmAllZero && invalidRows.length > 0) {
      setOpeningStockRows((current) => current.map(validateOpeningStockEditorRow));
      setOpeningStockError(`Fix or confirm ${invalidRows.length} opening-stock rows before saving.`);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`opening-stock:${openingStockSummary.store.id}`);
    setOpeningStockError('');
    try {
      await saveLocationOpeningStockCallable({
        storeId: openingStockSummary.store.id,
        confirmAllZero,
        typedConfirmation: zeroStockConfirmation,
        rows: confirmAllZero ? [] : openingStockRows.map((row) => ({
          stockId: row.stockId,
          openingStock: numericValue(row.openingStock),
          costPerUnit: numericValue(row.unitCost),
          confirmed: row.confirmed,
        })),
      });
      setOpeningStockDirty(false);
      setMessage('Opening stock saved and readiness updated.');
      await loadLocations();
      await loadOpeningStockRows(openingStockSummary);
    } catch (err: any) {
      setOpeningStockError(err?.message || 'Could not save opening stock.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const openStaffAssignment = (summary: LocationSummary) => {
    setStaffAssignmentSummary(summary);
    setDraftStaffUids(staffOptions.filter((person) => person.assignedStoreIds.includes(summary.store.id)).map((person) => person.uid));
    setStaffSearch('');
  };

  const toggleDraftStaff = (uid: string) => {
    setDraftStaffUids((current) => (
      current.includes(uid) ? current.filter((value) => value !== uid) : [...current, uid]
    ));
  };

  const saveDraftStaffAssignments = async () => {
    if (!staffAssignmentSummary) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const requirement = staffRequirement(draftStaffUids);
    if (!requirement.hasSetupLead || !requirement.hasPosCapable) {
      setError('Assign at least one active Admin or Store Manager and one active POS-capable user.');
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`staff:${staffAssignmentSummary.store.id}`);
    setError('');
    try {
      await saveLocationStaffAssignmentsCallable({
        storeId: staffAssignmentSummary.store.id,
        selectedUserIds: draftStaffUids,
      });
      setMessage('Staff assignments saved.');
      await loadLocations();
      setStaffAssignmentSummary(null);
    } catch (err: any) {
      setError(err?.message || 'Could not save staff assignments.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const requestPayload = () => ({
    location: form,
    templateMode,
    sourceStoreId: templateMode === 'COPY' ? sourceStoreId : '',
    selectedModules,
    staffAssignmentUids: plannedStaffUids,
    inventoryOption,
    inventoryConfirmationStoreCode: inventoryConfirmation,
    inventoryReason,
    confirmLegalEntity,
    confirmDuplicateName,
    provisioningJobId,
    previewChecksum: preview?.planChecksum || '',
  });

  const resetWizard = () => {
    setWizardStep(1);
    setForm(defaultForm);
    setTemplateMode('BLANK');
    setSourceStoreId('');
    setSelectedModules(RECOMMENDED_MODULES);
    setInventoryOption('STRUCTURE_ONLY');
    setInventoryConfirmation('');
    setInventoryReason('');
    setPlannedStaffUids([]);
    setStaffSearch('');
    setConfirmLegalEntity(false);
    setConfirmDuplicateName(false);
    setPreview(null);
    setWizardError('');
    setProvisioningJobId(newProvisioningJobId());
  };

  const openNewWizard = () => {
    resetWizard();
    setWizardOpen(true);
  };

  const openCloneWizard = (source: Store) => {
    resetWizard();
    setTemplateMode('COPY');
    setSourceStoreId(source.id);
    setWizardOpen(true);
  };

  const toggleModule = (moduleId: ModuleId) => {
    setPreview(null);
    setWizardError('');
    setSelectedModules((current) => (
      current.includes(moduleId)
        ? current.filter((id) => id !== moduleId)
        : [...current, moduleId]
    ));
    if (moduleId === 'LEGAL_RECEIPT' && selectedModules.includes(moduleId)) setConfirmLegalEntity(false);
  };

  const handlePreview = async () => {
    if (!requireOnlineAction()) {
      setWizardError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning('preview');
    setWizardError('');
    setMessage('');
    try {
      const result = await previewStoreProvisioning(requestPayload());
      setPreview(result.data);
      setWizardStep(5);
    } catch (err: any) {
      console.error('Location preview failed', err);
      setWizardError(err?.message || 'Could not preview this location.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleCreateDraft = async () => {
    if (!preview?.canCreate) return;
    if (!requireOnlineAction()) {
      setWizardError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning('create');
    setWizardError('');
    try {
      const result = await createStoreFromTemplate(requestPayload());
      setMessage(result.data.message);
      setWizardStep(7);
      await loadLocations();
    } catch (err: any) {
      console.error('Location creation failed', err);
      setWizardError(err?.message || 'Could not create the draft location.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const validationFields = useMemo(
    () => new Set((preview?.validationErrors || []).map((issue) => issue.field)),
    [preview],
  );

  const updateForm = (field: keyof LocationForm, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(null);
    setWizardError('');
  };

  const handleActivate = async (storeId: string) => {
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`activate:${storeId}`);
    setError('');
    try {
      await activateStoreCallable({ storeId });
      setMessage('POS activated. Customer ordering remains disabled until its separate readiness check passes.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Location readiness is incomplete.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleClassifyLegacyGoldenI = async (store: Store) => {
    if (!isGoldenI(store) || isLegacyMigratedGoldenI(store)) return;
    if (!window.confirm('Classify the existing Golden I operation as a migrated legacy store? This does not change stock, readiness, menu, GST, hours or ordering flags.')) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`legacy-migration:${store.id}`);
    setError('');
    try {
      await updateStoreConfigurationCallable({ storeId: store.id, action: 'CLASSIFY_LEGACY_MIGRATED' });
      setMessage('Golden I classified as a migrated legacy store. Review warnings before normalizing POS and customer ordering.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not classify Golden I as a migrated legacy store.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleEnablePosLaunchException = async (summary: LocationSummary) => {
    const store = summary.store;
    if (!isBakedByBond51(store)) return;
    const reason = window.prompt('Enter the owner-approved reason for this temporary staff-POS launch exception. Customer ordering will stay disabled.');
    if (!reason?.trim()) return;
    if (!window.confirm('Approve temporary staff POS while opening stock remains pending? This does not enable customer ordering.')) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`pos-exception:${store.id}`);
    setError('');
    try {
      const expiresAt = new Date(Date.now() + POS_LAUNCH_EXCEPTION_HOURS * 60 * 60 * 1000).toISOString();
      await setPosLaunchExceptionCallable({
        storeId: store.id,
        enabled: true,
        reason: reason.trim(),
        expiresAt,
      });
      setMessage('Temporary staff-POS launch exception recorded. Activate POS when the remaining checks pass.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not approve the POS launch exception.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleEnableInternalPosTest = async (storeId: string) => {
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`internal-test:${storeId}`);
    setError('');
    try {
      await enableInternalPosTestCallable({ storeId });
      setMessage('Internal POS test enabled. The location remains Draft and customer ordering stays disabled.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not enable internal POS testing.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleMarkInternalPosTestPassed = async (storeId: string) => {
    if (!window.confirm('Mark POS test passed only after the setup-test bill was created, receipt/KOT/stock were checked, and the test order was voided. Continue?')) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`pos-test-passed:${storeId}`);
    setError('');
    try {
      await markInternalPosTestPassedCallable({ storeId });
      setMessage('Internal POS test marked complete.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not mark the POS test complete.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const handleDeactivate = async (storeId: string) => {
    if (!window.confirm('Deactivate this location? Existing history will remain unchanged.')) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`deactivate:${storeId}`);
    setError('');
    try {
      await updateStoreConfigurationCallable({ storeId, action: 'DEACTIVATE' });
      setMessage('Location deactivated. No records were deleted.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not deactivate the location.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const startEdit = (store: Store) => {
    setEditStore(store);
    setEditForm({
      displayName: store.displayName || store.name,
      legalEntityName: store.legalEntityName || '',
      address: store.address || '',
      city: store.city || '',
      state: store.state || '',
      pinCode: store.pinCode || '',
      phone: store.phone || '',
      email: store.email || '',
      gstRegistered: store.gstRegistered === true,
      gstin: store.gstin || '',
      gstRate: String((store as Store & Record<string, unknown>).gstRate || '5'),
      receiptName: store.receiptName || '',
      receiptFooter: store.receiptFooter || '',
      timezone: store.timezone || 'Asia/Kolkata',
    });
  };

  const saveEdit = async () => {
    if (!editStore) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`edit:${editStore.id}`);
    setError('');
    try {
      await updateStoreConfigurationCallable({
        storeId: editStore.id,
        action: 'UPDATE',
        patch: {
          name: editForm.displayName,
          displayName: editForm.displayName,
          legalEntityName: editForm.legalEntityName,
          address: editForm.address,
          city: editForm.city,
          state: editForm.state,
          pinCode: editForm.pinCode,
          phone: editForm.phone,
          email: editForm.email,
          gstRegistered: editForm.gstRegistered,
          gstin: editForm.gstRegistered ? editForm.gstin : '',
          gstRate: editForm.gstRegistered ? editForm.gstRate : '0',
          receiptName: editForm.receiptName,
          receiptFooter: editForm.receiptFooter,
          timezone: editForm.timezone,
        },
      });
      setEditStore(null);
      setMessage('Location configuration updated. Store code was not changed.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not update location configuration.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  const toggleCustomerOrdering = async (store: Store, enabled: boolean) => {
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const endCriticalOperation = beginCriticalOperation();
    setActioning(`ordering:${store.id}`);
    setError('');
    try {
      await setStoreCustomerOrderingCallable({ storeId: store.id, enabled });
      setMessage(enabled ? 'Customer ordering enabled.' : 'Customer ordering paused.');
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Customer ordering readiness is incomplete.');
    } finally {
      setActioning('');
      endCriticalOperation();
    }
  };

  if (!staffProfile) return null;

  if (!canAccess) {
    return (
      <section className="mx-auto max-w-2xl rounded-lg border border-neutral-200 bg-white p-6">
        <ShieldCheck className="mb-3 text-neutral-400" />
        <h1 className="text-xl font-black text-[#3e2723]">Location Management</h1>
        <p className="mt-2 text-sm text-neutral-600">Only an active Admin can access store provisioning.</p>
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 space-y-5 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/admin" className="flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-600">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-700">Admin only</p>
            <h1 className="text-2xl font-black text-[#3e2723]">Location Management</h1>
          </div>
        </div>
        <button
          onClick={openNewWizard}
          className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-4 text-sm font-black text-white"
        >
          <Plus size={17} /> New Location
        </button>
      </header>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</div>}

      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-4">
          <div>
            <h2 className="font-black text-neutral-900">Locations</h2>
            <p className="text-xs text-neutral-500">{summaries.length} configured</p>
          </div>
          <label className="flex h-10 min-w-[240px] items-center gap-2 rounded-lg border border-neutral-200 px-3">
            <Search size={16} className="text-neutral-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, code, or city"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
        </div>

        {loading ? (
          <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin text-[#5c4033]" /></div>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">POS</th>
                  <th className="px-3 py-3">Customer</th>
                  <th className="px-3 py-3">Inventory</th>
                  <th className="px-3 py-3">GST</th>
                  <th className="px-3 py-3">Staff</th>
                  <th className="px-3 py-3">Menu</th>
                  <th className="px-3 py-3">Inventory rows</th>
                  <th className="px-3 py-3">Created</th>
                  <th className="px-3 py-3">Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredSummaries.map((summary) => {
                  const store = summary.store;
                  const status = statusFor(store);
                  const progress = setupProgress(summary);
                  return (
                    <tr key={store.id} className="align-top hover:bg-[#fcf9f5]">
                      <td className="px-4 py-4">
                        <p className="font-black text-neutral-900">{storeDisplayName(store)}</p>
                        <p className="font-mono text-xs text-neutral-500">{store.code}</p>
                        {status !== 'ACTIVE' && progress.incomplete.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedSummary(summary)}
                            className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs font-bold text-amber-900 hover:bg-amber-100"
                          >
                            {storeDisplayName(store)} needs {progress.incomplete.length} setup steps before POS can be activated.
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-4">
                        <span className={`rounded-full border px-2 py-1 text-xs font-black ${badgeClass(true, status === 'ACTIVE' ? 'green' : status === 'DRAFT' ? 'amber' : 'neutral')}`}>{status}</span>
                        <p className="mt-2 text-xs font-bold text-neutral-500">{progress.complete} of {progress.total} completed</p>
                      </td>
                      <td className="px-3 py-4 font-bold">{(store.posEnabled ?? store.isActive) ? 'Enabled' : 'Disabled'}</td>
                      <td className="px-3 py-4 font-bold">{customerOrderingOperational(store) ? 'Accepting' : 'Disabled'}</td>
                      <td className="px-3 py-4 font-mono text-xs">{store.inventoryMode || 'FINISHED_GOODS (effective)'}</td>
                      <td className="px-3 py-4">{summary.gstLabel}</td>
                      <td className="px-3 py-4 font-black">{summary.staffCount}</td>
                      <td className="px-3 py-4 font-black">{summary.menuCount}</td>
                      <td className="px-3 py-4">
                        <p className="font-black">{summary.stockCount} inventory rows</p>
                        <p className="mt-1 text-xs text-neutral-500">Opening stock confirmed: {setupStepComplete(summary, 'openingStockReviewed') ? 'Yes' : 'No'}</p>
                      </td>
                      <td className="px-3 py-4 text-xs text-neutral-500">{dateLabel(store.createdAt)}</td>
                      <td className="px-3 py-4 text-xs text-neutral-500">{dateLabel(store.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => setSelectedSummary(summary)} title="View" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Eye size={16} /></button>
                          <button onClick={() => startEdit(store)} title="Edit configuration" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Pencil size={16} /></button>
                          <button onClick={() => openCloneWizard(store)} title="Clone location" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Copy size={16} /></button>
                          {!store.isActive && (
                            <button data-requires-online="true" onClick={() => handleActivate(store.id)} title="Activate POS" className="rounded-md p-2 text-emerald-700 hover:bg-emerald-50"><Power size={16} /></button>
                          )}
                          {store.isActive && (
                            <button data-requires-online="true" onClick={() => handleDeactivate(store.id)} title="Deactivate" className="rounded-md p-2 text-red-600 hover:bg-red-50"><X size={16} /></button>
                          )}
                          <button onClick={() => setSelectedSummary(summary)} title="Complete Setup" className="rounded-md px-2 py-2 text-xs font-black text-amber-700 hover:bg-amber-50"><ClipboardCheck size={16} className="inline" /> Setup</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedSummary && (
        <div className="fixed inset-0 z-[80] flex justify-end bg-black/35" role="dialog" aria-modal="true">
          <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-amber-700">Readiness review</p>
                <h2 className="text-xl font-black text-[#3e2723]">{selectedSummary.store.name}</h2>
                <p className="font-mono text-xs text-neutral-500">{selectedSummary.store.code}</p>
              </div>
              <button onClick={() => setSelectedSummary(null)} className="rounded-lg border border-neutral-200 p-2"><X size={17} /></button>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-2">
              {[
                ['Menu', selectedSummary.menuCount],
                ['Inventory rows', selectedSummary.stockCount],
                ['Staff', selectedSummary.staffCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-neutral-200 p-3">
                  <p className="text-xs font-bold text-neutral-500">{label}</p>
                  <p className="mt-1 text-xl font-black">{value}</p>
                </div>
              ))}
            </div>
            {isGoldenI(selectedSummary.store) && !isLegacyMigratedGoldenI(selectedSummary.store) && (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-black">Existing legacy location</p>
                <p className="mt-1 text-xs font-bold">Golden I predates the new-location onboarding workflow. Classify it explicitly before normalizing its operational flags.</p>
                <button
                  onClick={() => handleClassifyLegacyGoldenI(selectedSummary.store)}
                  disabled={actioning === `legacy-migration:${selectedSummary.store.id}`}
                  className="mt-3 h-9 rounded-lg border border-amber-300 bg-white px-3 text-xs font-black text-amber-900 disabled:opacity-50"
                >
                  Classify migrated legacy store
                </button>
              </div>
            )}
            {isLegacyMigratedGoldenI(selectedSummary.store) && (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-black">Migrated legacy-store warnings</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs font-bold">
                  {legacyMigrationWarnings(selectedSummary.store).map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            )}
            {isBakedByBond51(selectedSummary.store) && openingStockPending(selectedSummary.store) && (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-black">Opening stock is still required</p>
                    <p className="mt-1 text-xs font-bold">
                      Staff POS can be temporarily activated only with an active Admin approval. Customer ordering stays disabled and opening-stock readiness remains incomplete.
                    </p>
                    {activePosLaunchException(selectedSummary.store) && (
                      <p className="mt-2 text-xs font-black">
                        Temporary staff-POS exception active until {new Date(timestampMillis(selectedSummary.store.posLaunchException?.expiresAt)).toLocaleString()}.
                      </p>
                    )}
                  </div>
                  {!activePosLaunchException(selectedSummary.store) && statusFor(selectedSummary.store) !== 'ACTIVE' && (
                    <button
                      onClick={() => handleEnablePosLaunchException(selectedSummary)}
                      disabled={actioning === `pos-exception:${selectedSummary.store.id}`}
                      className="h-9 rounded-lg border border-amber-300 bg-white px-3 text-xs font-black text-amber-900 disabled:opacity-50"
                    >
                      Approve staff-POS exception
                    </button>
                  )}
                </div>
              </div>
            )}
            {(() => {
              const progress = setupProgress(selectedSummary);
              return (
                <div className="mt-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-black text-neutral-900">Setup progress</p>
                      <p className="text-xs text-neutral-500">{progress.complete} of {progress.total} completed</p>
                    </div>
                    <span className={`rounded-full border px-2 py-1 text-xs font-black ${progress.incomplete.length === 0 ? badgeClass(true, 'green') : badgeClass(true, 'amber')}`}>
                      {progress.incomplete.length === 0 ? 'Ready for activation' : `${progress.incomplete.length} steps left`}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {SETUP_STEPS.map((step) => {
                      const complete = setupStepComplete(selectedSummary, step.key);
                      return (
                        <div key={step.key} className="rounded-lg border border-neutral-200 bg-white p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-black text-neutral-900">{step.label}</p>
                              <p className="mt-1 text-xs text-neutral-500">{step.description}</p>
                            </div>
                            <span className={`shrink-0 rounded-full border px-2 py-1 text-xs font-black ${complete ? badgeClass(true, 'green') : badgeClass(true, step.automatic ? 'amber' : 'neutral')}`}>
                              {complete ? 'Complete' : step.automatic ? 'Needs attention' : 'Manual step'}
                            </span>
                          </div>
                          {!complete && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {(step.key === 'legalGstReviewed' || step.key === 'receiptConfigurationReviewed') && (
                                <button onClick={() => startEdit(selectedSummary.store)} className="h-9 rounded-lg border border-neutral-200 px-3 text-xs font-black">Edit details</button>
                              )}
                              {(step.key === 'productAvailabilityReviewed' || step.key === 'addOnsReviewed' || step.key === 'kotRoutingReviewed') && (
                                <Link to="/admin/menu-management" className="flex h-9 items-center rounded-lg border border-neutral-200 px-3 text-xs font-black">Open menu setup</Link>
                              )}
                              {step.key === 'openingStockReviewed' && (
                                <button
                                  onClick={() => loadOpeningStockRows(selectedSummary)}
                                  disabled={openingStockLoading}
                                  className="h-9 rounded-lg border border-neutral-200 px-3 text-xs font-black"
                                >
                                  Open opening stock setup
                                </button>
                              )}
                              {step.key === 'staffAssigned' && (
                                <button
                                  onClick={() => openStaffAssignment(selectedSummary)}
                                  className="h-9 rounded-lg border border-neutral-200 px-3 text-xs font-black"
                                >
                                  Assign staff here
                                </button>
                              )}
                              {step.key === 'posTestCompleted' && (
                                <>
                                  <button
                                    onClick={() => handleEnableInternalPosTest(selectedSummary.store.id)}
                                    disabled={actioning === `internal-test:${selectedSummary.store.id}` || selectedSummary.store.internalPosTestEnabled === true}
                                    className="h-9 rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-black text-amber-900 disabled:opacity-50"
                                  >
                                    Enable Internal POS Test
                                  </button>
                                  {selectedSummary.store.internalPosTestEnabled === true && (
                                    <Link to="/pos" className="flex h-9 items-center rounded-lg border border-neutral-200 px-3 text-xs font-black">Open POS test</Link>
                                  )}
                                  {selectedSummary.store.internalPosTestEnabled === true && (
                                    <button
                                      onClick={() => handleMarkInternalPosTestPassed(selectedSummary.store.id)}
                                      disabled={actioning === `pos-test-passed:${selectedSummary.store.id}`}
                                      className="h-9 rounded-lg bg-[#3e2723] px-3 text-xs font-black text-white disabled:opacity-50"
                                    >
                                      Mark test passed
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              POS activation never enables customer ordering. Customer ordering requires its own completed test and public menu snapshot.
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {(!selectedSummary.store.isActive || (isLegacyMigratedGoldenI(selectedSummary.store) && selectedSummary.store.posEnabled !== true)) && (
                <button data-requires-online="true" onClick={() => handleActivate(selectedSummary.store.id)} className="h-11 flex-1 rounded-lg bg-[#3e2723] font-black text-white">
                  {isLegacyMigratedGoldenI(selectedSummary.store) ? 'Normalize staff POS' : 'Activate POS'}
                </button>
              )}
              {statusFor(selectedSummary.store) === 'ACTIVE' && (!isLegacyMigratedGoldenI(selectedSummary.store) || selectedSummary.store.posEnabled === true) && (
                <button
                  onClick={() => toggleCustomerOrdering(
                    selectedSummary.store,
                    !customerOrderingOperational(selectedSummary.store),
                  )}
                  className="h-11 flex-1 rounded-lg border border-[#5c4033] font-black text-[#5c4033]"
                >
                  {customerOrderingOperational(selectedSummary.store) ? 'Pause Customer Ordering' : 'Enable Customer Ordering'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {editStore && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-black text-[#3e2723]">Edit configuration</h2>
                <p className="text-xs text-neutral-500">Store code {editStore.code} is permanent.</p>
              </div>
              <button onClick={() => setEditStore(null)} className="rounded-lg border border-neutral-200 p-2"><X size={17} /></button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ['displayName', 'Location name'],
                ['legalEntityName', 'Legal entity name'],
                ['address', 'Address'],
                ['city', 'City'],
                ['state', 'State'],
                ['pinCode', 'PIN code'],
                ['phone', 'Phone'],
                ['email', 'Email'],
	                ['receiptName', 'Receipt name'],
                ['receiptFooter', 'Receipt footer'],
                ['timezone', 'Timezone'],
              ].map(([key, label]) => (
                <label key={key} className={key === 'address' || key === 'receiptFooter' ? 'sm:col-span-2' : ''}>
                  <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">{label}</span>
                  <input
                    value={String(editForm[key as keyof LocationForm] ?? '')}
                    onChange={(event) => setEditForm((current) => ({ ...current, [key]: event.target.value }))}
                    className="h-11 w-full rounded-lg border border-neutral-200 px-3 outline-none focus:border-[#5c4033]"
                  />
                </label>
              ))}
              <label className="flex items-center gap-2 sm:col-span-2">
                <input
	                  type="checkbox"
	                  checked={editForm.gstRegistered === true}
	                  onChange={(event) => setEditForm((current) => ({
                      ...current,
                      gstRegistered: event.target.checked,
                      gstin: event.target.checked ? current.gstin : '',
                      gstRate: event.target.checked ? (current.gstRate || '5') : '0',
                    }))}
	                />
	                <span className="text-sm font-bold">GST registered</span>
	              </label>
              {editForm.gstRegistered === true && (
                <>
                  <label>
                    <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">GSTIN</span>
                    <input
                      value={String(editForm.gstin ?? '')}
                      onChange={(event) => setEditForm((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))}
                      className="h-11 w-full rounded-lg border border-neutral-200 px-3 font-mono outline-none focus:border-[#5c4033]"
                    />
                  </label>
                  <label>
                    <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">GST rate</span>
                    <input
                      value={String(editForm.gstRate ?? '5')}
                      onChange={(event) => setEditForm((current) => ({ ...current, gstRate: event.target.value }))}
                      className="h-11 w-full rounded-lg border border-neutral-200 px-3 outline-none focus:border-[#5c4033]"
                    />
                  </label>
                </>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditStore(null)} className="h-11 rounded-lg border border-neutral-200 px-4 font-bold">Cancel</button>
              <button data-requires-online="true" onClick={saveEdit} disabled={actioning.startsWith('edit:')} className="h-11 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">Save configuration</button>
            </div>
          </div>
        </div>
      )}

      {openingStockSummary && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center overflow-y-auto bg-black/40 p-3" role="dialog" aria-modal="true">
          <div className="flex max-h-[94vh] w-full max-w-6xl flex-col rounded-lg bg-white shadow-2xl">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 p-4">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-amber-700">Opening Stock</p>
                <h2 className="text-xl font-black text-[#3e2723]">{storeDisplayName(openingStockSummary.store)}</h2>
                <p className="text-sm text-neutral-500">Set opening and current stock together. Non-zero rows create one deterministic OPENING_STOCK movement.</p>
              </div>
              <button onClick={closeOpeningStock} className="rounded-lg border border-neutral-200 p-2"><X size={17} /></button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3">
              <label className="flex h-10 min-w-[240px] flex-1 items-center gap-2 rounded-lg border border-neutral-200 px-3">
                <Search size={15} className="text-neutral-400" />
                <input
                  value={openingStockSearch}
                  onChange={(event) => setOpeningStockSearch(event.target.value)}
                  placeholder="Search item name or code"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <select value={openingStockFilter} onChange={(event) => setOpeningStockFilter(event.target.value as typeof openingStockFilter)} className="h-10 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-bold">
                <option value="ALL">All rows</option>
                <option value="NEEDS_ATTENTION">Needs attention</option>
                <option value="CONFIRMED">Confirmed</option>
              </select>
              <button onClick={downloadOpeningStockTemplate} className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-200 px-3 text-sm font-black">
                <Download size={15} /> Template
              </button>
              <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-3 text-sm font-black">
                <Upload size={15} /> Upload CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(event) => {
                    void previewOpeningStockCsv(event.target.files?.[0] || null);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            </div>

            {openingStockError && (
              <div className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{openingStockError}</div>
            )}

            {csvPreviewRows.length > 0 && (
              <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-black text-amber-950">CSV import preview</p>
                    <p className="text-xs text-amber-800">
                      Ready {csvPreviewRows.filter((row) => row.status === 'READY').length} · Blocked {csvPreviewRows.filter((row) => row.status !== 'READY').length}
                    </p>
                  </div>
                  <button onClick={applyCsvPreviewToEditor} className="h-9 rounded-lg bg-[#3e2723] px-3 text-xs font-black text-white">Apply CSV to editor</button>
                </div>
                <div className="mt-3 max-h-40 overflow-auto rounded-lg border border-amber-200 bg-white">
                  <table className="w-full min-w-[700px] text-left text-xs">
                    <thead className="bg-amber-50 text-amber-900"><tr><th className="px-2 py-2">Row</th><th>Item code</th><th>Opening</th><th>Unit cost</th><th>Status</th><th>Message</th></tr></thead>
                    <tbody>
                      {csvPreviewRows.map((row) => (
                        <tr key={`${row.rowNumber}:${row.itemCode}`} className="border-t border-amber-100">
                          <td className="px-2 py-1">{row.rowNumber}</td>
                          <td className="font-mono">{row.itemCode}</td>
                          <td>{row.openingStock}</td>
                          <td>{row.unitCost}</td>
                          <td className={row.status === 'READY' ? 'font-black text-emerald-700' : 'font-black text-red-700'}>{row.status}</td>
                          <td>{row.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {openingStockLoading ? (
                <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin text-[#5c4033]" /></div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-neutral-200">
                  <table className="w-full min-w-[1100px] text-left text-sm">
                    <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Code</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Unit</th>
                        <th className="px-3 py-2">Opening quantity</th>
                        <th className="px-3 py-2">Current quantity</th>
                        <th className="px-3 py-2">Unit cost</th>
                        <th className="px-3 py-2">Confirmed</th>
                        <th className="px-3 py-2">Validation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {openingStockRows
                        .filter((row) => {
                          const needle = openingStockSearch.trim().toLowerCase();
                          if (needle && !row.itemName.toLowerCase().includes(needle) && !row.itemCode.toLowerCase().includes(needle)) return false;
                          if (openingStockFilter === 'CONFIRMED') return row.confirmed;
                          if (openingStockFilter === 'NEEDS_ATTENTION') return row.validationStatus !== 'VALID';
                          return true;
                        })
                        .map((row) => (
                          <tr key={row.stockId} className={row.validationStatus === 'VALID' ? '' : 'bg-amber-50/40'}>
                            <td className="px-3 py-2 font-bold">{row.itemName}</td>
                            <td className="px-3 py-2 font-mono text-xs">{row.itemCode}</td>
                            <td className="px-3 py-2">{row.itemType}</td>
                            <td className="px-3 py-2 font-mono">{row.unit}</td>
                            <td className="px-3 py-2">
                              <input
                                value={row.openingStock}
                                onChange={(event) => updateOpeningStockRow(row.stockId, { openingStock: event.target.value, currentStock: event.target.value })}
                                inputMode="decimal"
                                className="h-9 w-28 rounded-lg border border-neutral-200 px-2 font-mono outline-none focus:border-[#5c4033]"
                              />
                            </td>
                            <td className="px-3 py-2 font-mono">{row.currentStock}</td>
                            <td className="px-3 py-2">
                              <input
                                value={row.unitCost}
                                onChange={(event) => updateOpeningStockRow(row.stockId, { unitCost: event.target.value })}
                                inputMode="decimal"
                                className="h-9 w-28 rounded-lg border border-neutral-200 px-2 font-mono outline-none focus:border-[#5c4033]"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={row.confirmed}
                                onChange={(event) => updateOpeningStockRow(row.stockId, { confirmed: event.target.checked })}
                                className="h-5 w-5 accent-[#5c4033]"
                              />
                            </td>
                            <td className={`px-3 py-2 text-xs font-bold ${row.validationStatus === 'VALID' ? 'text-emerald-700' : 'text-amber-800'}`}>
                              {row.validationStatus === 'VALID' ? 'Valid' : row.validationMessage}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="border-t border-neutral-200 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-black">Confirm all as zero</p>
                  <p className="mt-1 text-xs">Type the store code to confirm every row starts at zero. This does not represent a physical stock count.</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={zeroStockConfirmation}
                      onChange={(event) => setZeroStockConfirmation(normalizedCode(event.target.value))}
                      placeholder={openingStockSummary.store.code}
                      className="h-10 rounded-lg border border-amber-300 bg-white px-3 font-mono text-sm outline-none"
                    />
                    <button
                      onClick={() => saveOpeningStockRows(true)}
                      data-requires-online="true"
                      disabled={actioning === `opening-stock:${openingStockSummary.store.id}`}
                      className="h-10 rounded-lg border border-amber-400 bg-white px-3 text-xs font-black text-amber-900 disabled:opacity-50"
                    >
                      Confirm zero stock
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button onClick={closeOpeningStock} className="h-11 rounded-lg border border-neutral-200 px-4 font-bold">Close</button>
                  <button
                    onClick={() => saveOpeningStockRows(false)}
                    data-requires-online="true"
                    disabled={actioning === `opening-stock:${openingStockSummary.store.id}` || openingStockLoading}
                    className="h-11 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50"
                  >
                    {actioning === `opening-stock:${openingStockSummary.store.id}` ? 'Saving...' : 'Save Opening Stock'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {staffAssignmentSummary && (
        <div className="fixed inset-0 z-[89] flex items-center justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-4xl rounded-lg bg-white shadow-2xl">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 p-4">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-amber-700">Staff Assignment</p>
                <h2 className="text-xl font-black text-[#3e2723]">{storeDisplayName(staffAssignmentSummary.store)}</h2>
                <p className="text-sm text-neutral-500">Assign or unassign existing active users without leaving Location Management.</p>
              </div>
              <button onClick={() => setStaffAssignmentSummary(null)} className="rounded-lg border border-neutral-200 p-2"><X size={17} /></button>
            </div>
            {(() => {
              const requirement = staffRequirement(draftStaffUids);
              return (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-3">
                    <div className="flex flex-wrap gap-2 text-xs font-black">
                      <span className={`rounded-full border px-2 py-1 ${requirement.hasSetupLead ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                        Admin/Manager {requirement.hasSetupLead ? 'selected' : 'needed'}
                      </span>
                      <span className={`rounded-full border px-2 py-1 ${requirement.hasPosCapable ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                        POS-capable {requirement.hasPosCapable ? 'selected' : 'needed'}
                      </span>
                      <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-neutral-600">{draftStaffUids.length} selected</span>
                    </div>
                    <label className="flex h-10 min-w-[240px] items-center gap-2 rounded-lg border border-neutral-200 px-3">
                      <Search size={15} className="text-neutral-400" />
                      <input
                        value={staffSearch}
                        onChange={(event) => setStaffSearch(event.target.value)}
                        placeholder="Search staff"
                        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      />
                    </label>
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto p-3">
                    <div className="grid gap-2">
                      {visibleStaffOptions.map((person) => (
                        <label key={person.uid} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50">
                          <input
                            type="checkbox"
                            checked={draftStaffUids.includes(person.uid)}
                            onChange={() => toggleDraftStaff(person.uid)}
                            className="mt-1 h-5 w-5 accent-[#5c4033]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-black text-neutral-900">{person.displayName}</span>
                            <span className="block truncate text-xs text-neutral-500">{person.email || person.uid}</span>
                            <span className="mt-1 inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-black uppercase text-neutral-600">{person.role}</span>
                          </span>
                          <span className="max-w-[260px] text-right text-[10px] font-bold text-neutral-500">
                            Current: {person.assignedStoreIds.length ? person.assignedStoreIds.map((storeId) => storesById.get(storeId)?.code || storeId).join(', ') : 'None'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 p-4">
                    <button onClick={() => setStaffAssignmentSummary(null)} className="h-11 rounded-lg border border-neutral-200 px-4 font-bold">Cancel</button>
                    <button
                      onClick={saveDraftStaffAssignments}
                      data-requires-online="true"
                      disabled={actioning === `staff:${staffAssignmentSummary.store.id}` || !requirement.hasSetupLead || !requirement.hasPosCapable}
                      className="h-11 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50"
                    >
                      {actioning === `staff:${staffAssignmentSummary.store.id}` ? 'Saving...' : 'Save assignments'}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {wizardOpen && (
        <div className="fixed inset-0 z-[90] overflow-y-auto bg-[#f7f3ee]" role="dialog" aria-modal="true">
          <div className="mx-auto min-h-full w-full max-w-5xl p-4 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-700">Secure provisioning</p>
                <h2 className="text-2xl font-black text-[#3e2723]">New Location</h2>
              </div>
              <button onClick={() => setWizardOpen(false)} className="rounded-lg border border-neutral-200 bg-white p-2"><X size={18} /></button>
            </header>

            <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
              {['Store Details', 'Copy Config', 'Opening Stock', 'Staff', 'Validation', 'POS Test', 'Activate'].map((label, index) => (
                <button
                  key={label}
                  disabled={index + 1 > wizardStep}
                  onClick={() => setWizardStep(index + 1)}
                  className={`flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-black ${
                    wizardStep === index + 1 ? 'border-[#5c4033] bg-[#5c4033] text-white' : 'border-neutral-200 bg-white text-neutral-500'
                  }`}
                >
                  <span>{index + 1}</span>{label}
                </button>
              ))}
            </div>

            {wizardError && (
              <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
                {wizardError}
              </div>
            )}

            <section className="mt-3 rounded-lg border border-neutral-200 bg-white p-4 sm:p-6">
              {wizardStep === 1 && (
                <div>
                  <h3 className="text-lg font-black">Basic location details</h3>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {[
                      ['displayName', 'Location display name', 'Baked by Bond 51'],
                      ['storeCode', 'Permanent store code', 'BAKED_BY_BOND_51'],
                      ['legalEntityName', 'Legal entity name', ''],
                      ['address', 'Address', ''],
                      ['city', 'City', ''],
                      ['state', 'State', ''],
                      ['pinCode', 'PIN code', ''],
                      ['phone', 'Phone', ''],
                      ['email', 'Email', ''],
                      ['receiptName', 'Receipt name', ''],
                      ['receiptFooter', 'Receipt footer', ''],
                      ['timezone', 'Business timezone', 'Asia/Kolkata'],
                    ].map(([key, label, placeholder]) => (
                      <label key={key} className={key === 'address' || key === 'receiptFooter' ? 'sm:col-span-2' : ''}>
                        <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">{label}</span>
                        <input
                          value={String(form[key as keyof LocationForm] ?? '')}
                          readOnly={key === 'inventoryMode'}
                          aria-invalid={validationFields.has(key)}
                          onChange={(event) => updateForm(
                            key as keyof LocationForm,
                            key === 'storeCode' ? normalizedCode(event.target.value) : event.target.value,
                          )}
                          placeholder={placeholder}
                          className={`h-11 w-full rounded-lg border px-3 outline-none focus:border-[#5c4033] ${
                            validationFields.has(key) ? 'border-red-300 bg-red-50/40' : 'border-neutral-200'
                          }`}
                        />
                      </label>
                    ))}
                    <label>
                      <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">GST registration status</span>
                      <select
                        value={form.gstDecisionReviewed ? (form.gstRegistered ? 'REGISTERED' : 'NOT_REGISTERED') : ''}
                        aria-invalid={validationFields.has('gstDecisionReviewed')}
                        onChange={(event) => {
                          const reviewed = event.target.value !== '';
	                          setForm((current) => ({
	                            ...current,
	                            gstDecisionReviewed: reviewed,
	                            gstRegistered: event.target.value === 'REGISTERED',
	                            gstin: event.target.value === 'REGISTERED' ? current.gstin : '',
	                            gstRate: event.target.value === 'REGISTERED' ? (current.gstRate || '5') : '0',
	                          }));
                          setPreview(null);
                          setWizardError('');
                        }}
                        className={`h-11 w-full rounded-lg border bg-white px-3 ${
                          validationFields.has('gstDecisionReviewed') ? 'border-red-300 bg-red-50/40' : 'border-neutral-200'
                        }`}
                      >
                        <option value="">Select registration status</option>
                        <option value="NOT_REGISTERED">Not GST registered</option>
                        <option value="REGISTERED">GST registered</option>
	                      </select>
	                    </label>
                    {form.gstRegistered && (
                      <>
                        <label>
                          <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">GSTIN</span>
                          <input
                            value={form.gstin}
                            aria-invalid={validationFields.has('gstin')}
                            onChange={(event) => updateForm('gstin', event.target.value.toUpperCase())}
                            placeholder="09ABCDE1234F1Z5"
                            className={`h-11 w-full rounded-lg border px-3 font-mono outline-none focus:border-[#5c4033] ${
                              validationFields.has('gstin') ? 'border-red-300 bg-red-50/40' : 'border-neutral-200'
                            }`}
                          />
                        </label>
                        <label>
                          <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">GST rate</span>
                          <input
                            value={form.gstRate}
                            aria-invalid={validationFields.has('gstRate')}
                            onChange={(event) => updateForm('gstRate', event.target.value)}
                            inputMode="decimal"
                            placeholder="5"
                            className={`h-11 w-full rounded-lg border px-3 outline-none focus:border-[#5c4033] ${
                              validationFields.has('gstRate') ? 'border-red-300 bg-red-50/40' : 'border-neutral-200'
                            }`}
                          />
                        </label>
                      </>
                    )}
                    <label>
                      <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">Inventory mode</span>
                      <input readOnly value="FINISHED_GOODS" className="h-11 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 font-mono text-sm" />
                    </label>
                    <label className={`flex items-start gap-3 rounded-lg border p-3 sm:col-span-2 ${
                      validationFields.has('receiptReviewComplete') ? 'border-red-300 bg-red-50/40' : 'border-neutral-200'
                    }`}>
                      <input
                        type="checkbox"
                        checked={form.receiptReviewComplete}
                        onChange={(event) => updateForm('receiptReviewComplete', event.target.checked)}
                        className="mt-0.5 h-5 w-5 accent-[#5c4033]"
                      />
                      <span>
                        <span className="block text-sm font-black">Receipt details reviewed</span>
                        <span className="mt-1 block text-xs text-neutral-500">Confirm that the receipt name and footer are intentionally set or left blank for this Draft.</span>
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {wizardStep === 2 && (
                <div>
                  <h3 className="text-lg font-black">Template store</h3>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {[
                      ['BLANK', 'Create blank location', 'Start with only the destination store details.'],
                      ['COPY', 'Copy from existing location', 'Choose individual configuration modules to reuse.'],
                    ].map(([mode, label, description]) => (
                      <button
                        key={mode}
                        onClick={() => setTemplateMode(mode as 'BLANK' | 'COPY')}
                        className={`rounded-lg border p-4 text-left ${templateMode === mode ? 'border-[#5c4033] bg-[#fbf6f1]' : 'border-neutral-200'}`}
                      >
                        <p className="font-black">{label}</p>
                        <p className="mt-1 text-sm text-neutral-500">{description}</p>
                      </button>
                    ))}
                  </div>
	                  {templateMode === 'COPY' && (
	                    <label className="mt-4 block">
                      <span className="mb-1 block text-xs font-black uppercase tracking-wide text-neutral-500">Source location</span>
                      <select value={sourceStoreId} onChange={(event) => setSourceStoreId(event.target.value)} className="h-11 w-full rounded-lg border border-neutral-200 bg-white px-3">
                        <option value="">Select a location</option>
                        {summaries.map(({ store }) => <option key={store.id} value={store.id}>{store.name} ({store.code})</option>)}
	                      </select>
	                    </label>
	                  )}
                  <div className="mt-5 border-t border-neutral-200 pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="font-black">Configuration to copy</h4>
                        <p className="text-sm text-neutral-500">Staff, orders, payments, KOT history, customer data, stock movements and historical reports are never copied.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => setSelectedModules(RECOMMENDED_MODULES)} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">Recommended</button>
                        <button onClick={() => setSelectedModules(ALL_MODULES)} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">All config</button>
                        <button onClick={() => setSelectedModules([])} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">Clear</button>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2">
                      {MODULES.map((module) => (
                        <label key={module.id} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3">
                          <input
                            type="checkbox"
                            checked={selectedModules.includes(module.id)}
                            onChange={() => toggleModule(module.id)}
                            className="mt-0.5 h-5 w-5 accent-[#5c4033]"
                          />
                          <span>
                            <span className="font-black">{module.label}</span>
                            {module.recommended && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-700">Recommended</span>}
                            <span className="mt-1 block text-sm text-neutral-500">{module.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {selectedModules.includes('LEGAL_RECEIPT') && (
                      <label className="mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
                        <input type="checkbox" checked={confirmLegalEntity} onChange={(event) => setConfirmLegalEntity(event.target.checked)} className="mt-0.5 h-5 w-5 accent-amber-700" />
                        <span className="text-sm font-bold text-amber-900">Copy receipt and legal/GST defaults only when this location uses the same legal entity.</span>
                      </label>
                    )}
                  </div>
	                </div>
	              )}

	              {wizardStep === 3 && (
	                <div>
                    <h3 className="text-lg font-black">Opening stock</h3>
                    <p className="mt-1 text-sm text-neutral-500">Inventory rows can be created for setup without copying physical quantities. The location list shows row count, not stock quantity.</p>
                    <div className="mt-4 grid gap-2">
                      {[
                        ['STRUCTURE_ONLY', 'Structure only with zero stock', 'Recommended. Opening and current stock start at zero and must be confirmed before activation.'],
                        ['CONFIGURED_OPENING', 'Use configured opening quantities', 'Uses formal opening quantities and creates auditable opening records.'],
                        ['CURRENT_STOCK_ADVANCED', 'Copy current source balances', 'Advanced. Requires explicit confirmation because it treats source current stock as destination opening stock.'],
                      ].map(([value, label, description]) => (
                        <label key={value} className={`rounded-lg border p-3 ${value === 'CURRENT_STOCK_ADVANCED' ? 'border-red-200 bg-red-50/50' : 'border-neutral-200'}`}>
                          <span className="flex items-start gap-3">
                            <input type="radio" name="inventoryOption" checked={inventoryOption === value} onChange={() => setInventoryOption(value as InventoryOption)} className="mt-0.5 h-5 w-5 accent-[#5c4033]" />
                            <span><span className="font-black">{label}</span><span className="mt-1 block text-sm text-neutral-500">{description}</span></span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {inventoryOption === 'STRUCTURE_ONLY' && (
                      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        Confirming all zero stock is a separate setup action after the Draft is created. It does not represent a physical stock count.
                      </div>
                    )}
                    {inventoryOption === 'CURRENT_STOCK_ADVANCED' && (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <label>
                          <span className="mb-1 block text-xs font-black uppercase text-red-700">Type destination code</span>
                          <input value={inventoryConfirmation} onChange={(event) => setInventoryConfirmation(normalizedCode(event.target.value))} className="h-11 w-full rounded-lg border border-red-300 px-3" />
                        </label>
                        <label>
                          <span className="mb-1 block text-xs font-black uppercase text-red-700">Mandatory reason</span>
                          <input value={inventoryReason} onChange={(event) => setInventoryReason(event.target.value)} className="h-11 w-full rounded-lg border border-red-300 px-3" />
                        </label>
                      </div>
                    )}
	                  <label className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                    <input
                      type="checkbox"
                      checked={confirmDuplicateName}
                      onChange={(event) => {
                        setConfirmDuplicateName(event.target.checked);
                        setPreview(null);
                      }}
                      className="mt-0.5 h-5 w-5 accent-[#5c4033]"
                    />
                    <span className="text-sm text-neutral-600">Allow a duplicate normalized location name if the permanent store code remains unique. Leave this off unless the preview reports a name conflict.</span>
                  </label>
                </div>
              )}

              {wizardStep === 4 && (
                <div>
                  <h3 className="text-lg font-black">Staff</h3>
                  <p className="mt-1 text-sm text-neutral-500">Select existing active staff to assign to this location when the Draft is created. Staff accounts are not copied from the source store.</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-neutral-200 p-4">
                      <p className="font-black">Required before activation</p>
                      <p className="mt-1 text-sm text-neutral-500">At least one active Admin or Store Manager, plus one POS-capable user.</p>
                    </div>
                    <div className="rounded-lg border border-neutral-200 p-4">
                      <p className="font-black">Derived automatically</p>
                      <p className="mt-1 text-sm text-neutral-500">The setup check reads active users with this store in `assignedStoreIds` or `storeIds`. No separate staff checkbox is required.</p>
                    </div>
                  </div>
                  {(() => {
                    const requirement = staffRequirement(plannedStaffUids);
                    return (
                      <div className="mt-4 rounded-lg border border-neutral-200">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-3">
                          <div>
                            <p className="font-black">Planned assignments</p>
                            <p className="text-xs text-neutral-500">
                              {plannedStaffUids.length} selected · Lead {requirement.hasSetupLead ? 'ready' : 'needed'} · POS user {requirement.hasPosCapable ? 'ready' : 'needed'}
                            </p>
                          </div>
                          <label className="flex h-10 min-w-[220px] items-center gap-2 rounded-lg border border-neutral-200 px-3">
                            <Search size={15} className="text-neutral-400" />
                            <input
                              value={staffSearch}
                              onChange={(event) => setStaffSearch(event.target.value)}
                              placeholder="Search staff"
                              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                            />
                          </label>
                        </div>
                        <div className="max-h-80 overflow-y-auto p-2">
                          {visibleStaffOptions.map((person) => (
                            <label key={person.uid} className="flex items-start gap-3 rounded-lg border border-neutral-100 p-3 hover:bg-neutral-50">
                              <input
                                type="checkbox"
                                checked={plannedStaffUids.includes(person.uid)}
                                onChange={() => togglePlannedStaff(person.uid)}
                                className="mt-1 h-5 w-5 accent-[#5c4033]"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block font-black text-neutral-900">{person.displayName}</span>
                                <span className="block truncate text-xs text-neutral-500">{person.email || person.uid}</span>
                                <span className="mt-1 inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-black uppercase text-neutral-600">{person.role}</span>
                              </span>
                              <span className="max-w-[220px] text-right text-[10px] font-bold text-neutral-500">
                                Existing: {person.assignedStoreIds.length ? person.assignedStoreIds.map((storeId) => storesById.get(storeId)?.code || storeId).join(', ') : 'None'}
                              </span>
                            </label>
                          ))}
                          {visibleStaffOptions.length === 0 && (
                            <p className="p-4 text-sm text-neutral-500">No active staff profiles match this search.</p>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {wizardStep === 5 && preview && (
                <div>
                  <div className="flex items-start gap-3">
                    {preview.canCreate
                      ? <CheckCircle2 className="mt-0.5 text-emerald-600" />
                      : <AlertTriangle className="mt-0.5 text-amber-600" />}
                    <div>
                      <h3 className="text-lg font-black">Automatic validation preview</h3>
                      <p className="text-sm text-neutral-500">No writes have occurred. Review required destination details and proposed collection changes.</p>
                    </div>
                  </div>
                  {!preview.canCreate && (
                    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-black">Preview generated. Complete the required destination details before creating this location.</p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                            {preview.validationErrors.map((issue) => <li key={`${issue.field}:${issue.code}`}>{issue.message}</li>)}
                          </ul>
                        </div>
                        <button onClick={() => setWizardStep(1)} className="h-10 rounded-lg border border-amber-400 bg-white px-3 text-sm font-black">
                          Edit destination details
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border border-neutral-200 p-3"><p className="text-xs font-bold text-neutral-500">Destination</p><p className="mt-1 font-black">{String(preview.destinationStore.displayName)}</p><p className="font-mono text-xs">{String(preview.destinationStore.storeCode)}</p></div>
                    <div className="rounded-lg border border-neutral-200 p-3"><p className="text-xs font-bold text-neutral-500">Template</p><p className="mt-1 font-black">{preview.sourceTemplate?.name || 'Blank location'}</p><p className="font-mono text-xs">{preview.sourceTemplate?.id || 'None'}</p></div>
                    <div className="rounded-lg border border-neutral-200 p-3"><p className="text-xs font-bold text-neutral-500">Proposed writes</p><p className="mt-1 text-2xl font-black">{preview.totalProposedWrites}</p></div>
                    <div className="rounded-lg border border-neutral-200 p-3"><p className="text-xs font-bold text-neutral-500">Readiness</p><p className={`mt-1 text-sm font-black ${preview.canCreate ? 'text-emerald-700' : 'text-amber-700'}`}>{preview.applyReadiness}</p><p className="mt-1 text-xs text-neutral-500">Writes performed: {preview.firestoreWritesPerformed}</p></div>
                  </div>
                  <div className="mt-4 max-w-full overflow-x-auto rounded-lg border border-neutral-200">
                    <table className="w-full min-w-[540px] text-sm">
                      <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500"><tr><th className="px-3 py-2">Collection</th><th className="px-3 py-2 text-right">Create</th><th className="px-3 py-2 text-right">Update assignment</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
                      <tbody className="divide-y divide-neutral-100">
                        {Object.entries(preview.writesByCollection).map(([collectionName, count]) => (
                          <tr key={collectionName}>
                            <td className="px-3 py-2 font-mono">{collectionName}</td>
                            <td className="px-3 py-2 text-right">{preview.writeOperationsByCollection[collectionName]?.creates || 0}</td>
                            <td className="px-3 py-2 text-right">{preview.writeOperationsByCollection[collectionName]?.updates || 0}</td>
                            <td className="px-3 py-2 text-right font-black">{count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 space-y-2">
                    {preview.warnings.map((warning) => (
                      <div key={warning} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{warning}</div>
                    ))}
                  </div>
                  <details className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                    <summary className="cursor-pointer text-sm font-black text-neutral-700">
                      Excluded source records ({preview.counts.skippedHistoricalDocuments || 0} counted)
                    </summary>
                    <div className="mt-3 grid gap-1 text-xs text-neutral-600 sm:grid-cols-2">
                      {Object.entries(preview.skippedDocumentsByCollection)
                        .filter(([, count]) => count > 0)
                        .map(([collectionName, count]) => (
                          <p key={collectionName}><span className="font-mono">{collectionName}</span>: {count}</p>
                        ))}
                    </div>
                    <p className="mt-3 text-xs text-neutral-500">
                      Excluded without enumeration: {preview.skippedUncountedScopes.join(', ')}.
                    </p>
                  </details>
                  <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
                    Staff assignments: <strong>{preview.staffAssignmentCount}</strong>. Customer ordering: <strong>{preview.customerOrderingInitialStatus}</strong>. Legal/GST copied: <strong>{preview.legalGstSelected ? 'Yes' : 'No'}</strong>.
                  </div>
                  {preview.inventoryOption === 'STRUCTURE_ONLY' && (
                    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                      <strong>Zero-stock plan confirmed:</strong> destination inventory rows start with opening and current quantities of zero. No stock movement history is copied.
                    </div>
                  )}
                  <p className="mt-3 break-all font-mono text-[11px] text-neutral-400">Dry-run checksum: {preview.dryRunChecksum}</p>
                </div>
              )}

              {wizardStep === 6 && (
                <div>
                  <h3 className="text-lg font-black">Internal POS test</h3>
                  <p className="mt-1 text-sm text-neutral-500">After the Draft location is created, use Complete Setup from the location list to enable internal POS testing. The store remains Draft, customer ordering stays disabled, and setup-test orders are labelled for exclusion from commercial reports.</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {[
                      ['Cash test order', 'Create one setup-test cash bill from POS.'],
                      ['Receipt and KOT', 'Confirm receipt generation and station routing.'],
                      ['Stock deduction', 'Confirm stock deducts through the normal checkout path.'],
                      ['Void and reversal', 'Void the setup-test order and confirm stock reversal.'],
                    ].map(([title, body]) => (
                      <div key={title} className="rounded-lg border border-neutral-200 p-4">
                        <p className="font-black">{title}</p>
                        <p className="mt-1 text-sm text-neutral-500">{body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {wizardStep === 7 && (
                <div className="py-8 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Check size={28} /></div>
                  <h3 className="mt-4 text-xl font-black text-[#3e2723]">Location created as Draft</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-neutral-600">No historical transactions, staff accounts, customer data, KOT history, stock movements or payment records were copied. Complete Setup before activating POS.</p>
                </div>
              )}
            </section>

            <footer className="mt-4 flex flex-wrap justify-between gap-2">
              <button
                onClick={() => setWizardStep((step) => Math.max(1, step - 1))}
                disabled={wizardStep === 1 || wizardStep === 7}
                className="h-11 rounded-lg border border-neutral-200 bg-white px-4 font-bold disabled:opacity-40"
              >
                Back
              </button>
              <div className="flex gap-2">
                {wizardStep < 4 && (
                  <button
                    onClick={() => setWizardStep((step) => step + 1)}
                    disabled={wizardStep === 2 && templateMode === 'COPY' && !sourceStoreId}
                    className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-40"
                  >
                    Continue <ChevronRight size={16} />
                  </button>
                )}
                {wizardStep === 4 && (
                  <button data-requires-online="true" onClick={handlePreview} disabled={actioning === 'preview'} className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">
                    {actioning === 'preview' && <Loader2 size={16} className="animate-spin" />} Run validation preview
                  </button>
                )}
                {wizardStep === 5 && (
                  <button data-requires-online="true" onClick={handleCreateDraft} disabled={actioning === 'create' || !preview?.canCreate} className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">
                    {actioning === 'create' && <Loader2 size={16} className="animate-spin" />} Create Draft
                  </button>
                )}
                {wizardStep === 6 && (
                  <button onClick={() => setWizardStep(7)} className="h-11 rounded-lg border border-neutral-200 bg-white px-5 font-black text-neutral-700">Skip until Draft exists</button>
                )}
                {wizardStep === 7 && (
                  <button onClick={() => setWizardOpen(false)} className="h-11 rounded-lg bg-[#3e2723] px-5 font-black text-white">Return to locations</button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
