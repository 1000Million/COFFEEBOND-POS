import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Eye,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Power,
  Search,
  ShieldCheck,
  Store as StoreIcon,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { db, functions } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store } from '../../types';

type ModuleId =
  | 'OPERATING'
  | 'MENU'
  | 'ADD_ONS'
  | 'KOT'
  | 'INVENTORY'
  | 'CUSTOMER_ORDERING'
  | 'LEGAL_RECEIPT';

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

function normalizedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_');
}

function newProvisioningJobId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `store_${random}`;
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
  const [confirmLegalEntity, setConfirmLegalEntity] = useState(false);
  const [confirmDuplicateName, setConfirmDuplicateName] = useState(false);
  const [preview, setPreview] = useState<ProvisioningPreview | null>(null);
  const [wizardError, setWizardError] = useState('');
  const [provisioningJobId, setProvisioningJobId] = useState(newProvisioningJobId());
  const [actioning, setActioning] = useState('');
  const [editStore, setEditStore] = useState<Store | null>(null);
  const [editForm, setEditForm] = useState<Partial<LocationForm>>({});

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
      const users = usersSnap.docs.map((userDoc) => userDoc.data() as Record<string, unknown>);
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

  const filteredSummaries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return summaries;
    return summaries.filter(({ store }) => (
      String(store.name || '').toLowerCase().includes(needle)
      || String(store.code || store.storeCode || store.id).toLowerCase().includes(needle)
      || String(store.city || '').toLowerCase().includes(needle)
    ));
  }, [search, summaries]);

  const requestPayload = () => ({
    location: form,
    templateMode,
    sourceStoreId: templateMode === 'COPY' ? sourceStoreId : '',
    selectedModules,
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
    setActioning('preview');
    setWizardError('');
    setMessage('');
    try {
      const result = await previewStoreProvisioning(requestPayload());
      setPreview(result.data);
      setWizardStep(4);
    } catch (err: any) {
      console.error('Location preview failed', err);
      setWizardError(err?.message || 'Could not preview this location.');
    } finally {
      setActioning('');
    }
  };

  const handleCreateDraft = async () => {
    if (!preview?.canCreate) return;
    setActioning('create');
    setWizardError('');
    try {
      const result = await createStoreFromTemplate(requestPayload());
      setMessage(result.data.message);
      setWizardStep(5);
      await loadLocations();
    } catch (err: any) {
      console.error('Location creation failed', err);
      setWizardError(err?.message || 'Could not create the draft location.');
    } finally {
      setActioning('');
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
    }
  };

  const handleDeactivate = async (storeId: string) => {
    if (!window.confirm('Deactivate this location? Existing history will remain unchanged.')) return;
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
      receiptName: store.receiptName || '',
      receiptFooter: store.receiptFooter || '',
      timezone: store.timezone || 'Asia/Kolkata',
    });
  };

  const saveEdit = async () => {
    if (!editStore) return;
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
          gstin: editForm.gstin,
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
    }
  };

  const saveReadiness = async (summary: LocationSummary, key: string, checked: boolean) => {
    setActioning(`readiness:${summary.store.id}:${key}`);
    setError('');
    try {
      await updateStoreConfigurationCallable({
        storeId: summary.store.id,
        action: 'UPDATE',
        patch: { readiness: { [key]: checked } },
      });
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Could not update readiness.');
    } finally {
      setActioning('');
    }
  };

  const toggleCustomerOrdering = async (store: Store, enabled: boolean) => {
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
                  <th className="px-3 py-3">Stock</th>
                  <th className="px-3 py-3">Created</th>
                  <th className="px-3 py-3">Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredSummaries.map((summary) => {
                  const store = summary.store;
                  const status = statusFor(store);
                  return (
                    <tr key={store.id} className="align-top hover:bg-[#fcf9f5]">
                      <td className="px-4 py-4">
                        <p className="font-black text-neutral-900">{store.displayName || store.name}</p>
                        <p className="font-mono text-xs text-neutral-500">{store.code}</p>
                      </td>
                      <td className="px-3 py-4">
                        <span className={`rounded-full border px-2 py-1 text-xs font-black ${badgeClass(true, status === 'ACTIVE' ? 'green' : status === 'DRAFT' ? 'amber' : 'neutral')}`}>{status}</span>
                      </td>
                      <td className="px-3 py-4 font-bold">{(store.posEnabled ?? store.isActive) ? 'Enabled' : 'Disabled'}</td>
                      <td className="px-3 py-4 font-bold">{store.customerOrderingEnabled || store.onlineOrderingEnabled ? 'Accepting' : 'Disabled'}</td>
                      <td className="px-3 py-4 font-mono text-xs">{store.inventoryMode || 'FINISHED_GOODS (effective)'}</td>
                      <td className="px-3 py-4">{summary.gstLabel}</td>
                      <td className="px-3 py-4 font-black">{summary.staffCount}</td>
                      <td className="px-3 py-4 font-black">{summary.menuCount}</td>
                      <td className="px-3 py-4 font-black">{summary.stockCount}</td>
                      <td className="px-3 py-4 text-xs text-neutral-500">{dateLabel(store.createdAt)}</td>
                      <td className="px-3 py-4 text-xs text-neutral-500">{dateLabel(store.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => setSelectedSummary(summary)} title="View" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Eye size={16} /></button>
                          <button onClick={() => startEdit(store)} title="Edit configuration" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Pencil size={16} /></button>
                          <button onClick={() => openCloneWizard(store)} title="Clone location" className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100"><Copy size={16} /></button>
                          {!store.isActive && (
                            <button onClick={() => handleActivate(store.id)} title="Activate POS" className="rounded-md p-2 text-emerald-700 hover:bg-emerald-50"><Power size={16} /></button>
                          )}
                          {store.isActive && (
                            <button onClick={() => handleDeactivate(store.id)} title="Deactivate" className="rounded-md p-2 text-red-600 hover:bg-red-50"><X size={16} /></button>
                          )}
                          <button onClick={() => setSelectedSummary(summary)} title="Open readiness review" className="rounded-md p-2 text-amber-700 hover:bg-amber-50"><ClipboardCheck size={16} /></button>
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
                ['Inventory', selectedSummary.stockCount],
                ['Staff', selectedSummary.staffCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-neutral-200 p-3">
                  <p className="text-xs font-bold text-neutral-500">{label}</p>
                  <p className="mt-1 text-xl font-black">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 space-y-2">
              {Object.entries(READINESS_LABELS).map(([key, label]) => {
                const derivedChecked = key === 'staffAssigned'
                  ? selectedSummary.staffCount > 0
                  : key === 'menuCopied'
                    ? selectedSummary.menuCount > 0 && selectedSummary.store.readiness?.menuCopied === true
                    : key === 'inventoryStructureCreated'
                      ? selectedSummary.stockCount > 0 && selectedSummary.store.readiness?.inventoryStructureCreated === true
                      : selectedSummary.store.readiness?.[key] === true;
                const derived = ['staffAssigned', 'menuCopied', 'inventoryStructureCreated'].includes(key);
                return (
                  <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-3">
                    <span className="text-sm font-semibold text-neutral-700">{label}</span>
                    <input
                      type="checkbox"
                      checked={derivedChecked}
                      disabled={derived || actioning.startsWith('readiness:')}
                      onChange={(event) => saveReadiness(selectedSummary, key, event.target.checked)}
                      className="h-5 w-5 rounded border-neutral-300 accent-[#5c4033]"
                    />
                  </label>
                );
              })}
            </div>
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              POS activation never enables customer ordering. Customer ordering requires its own completed test and public menu snapshot.
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {!selectedSummary.store.isActive && (
                <button onClick={() => handleActivate(selectedSummary.store.id)} className="h-11 flex-1 rounded-lg bg-[#3e2723] font-black text-white">Activate POS</button>
              )}
              {statusFor(selectedSummary.store) === 'ACTIVE' && (
                <button
                  onClick={() => toggleCustomerOrdering(
                    selectedSummary.store,
                    !(selectedSummary.store.customerOrderingEnabled || selectedSummary.store.onlineOrderingEnabled),
                  )}
                  className="h-11 flex-1 rounded-lg border border-[#5c4033] font-black text-[#5c4033]"
                >
                  {selectedSummary.store.customerOrderingEnabled || selectedSummary.store.onlineOrderingEnabled ? 'Pause Customer Ordering' : 'Enable Customer Ordering'}
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
                ['gstin', 'GSTIN'],
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
                  onChange={(event) => setEditForm((current) => ({ ...current, gstRegistered: event.target.checked }))}
                />
                <span className="text-sm font-bold">GST registered</span>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditStore(null)} className="h-11 rounded-lg border border-neutral-200 px-4 font-bold">Cancel</button>
              <button onClick={saveEdit} disabled={actioning.startsWith('edit:')} className="h-11 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">Save configuration</button>
            </div>
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
              {['Details', 'Template', 'Configuration', 'Preview', 'Complete'].map((label, index) => (
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
                      ['gstin', 'GSTIN', ''],
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
                </div>
              )}

              {wizardStep === 3 && (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-black">Copy configuration</h3>
                      <p className="text-sm text-neutral-500">Transactional history and staff are always excluded.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setSelectedModules(RECOMMENDED_MODULES)} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">Select recommended</button>
                      <button onClick={() => setSelectedModules(ALL_MODULES)} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">Select all configuration</button>
                      <button onClick={() => setSelectedModules([])} className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-black">Clear all</button>
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
                      <span className="text-sm font-bold text-amber-900">Confirm that the new location uses the same legal entity and GST registration.</span>
                    </label>
                  )}

                  {selectedModules.includes('INVENTORY') && (
                    <div className="mt-4 border-t border-neutral-200 pt-4">
                      <h4 className="font-black">Inventory copy option</h4>
                      <div className="mt-2 grid gap-2">
                        {[
                          ['STRUCTURE_ONLY', 'Copy structure only', 'Recommended. Opening and current stock start at zero.'],
                          ['CONFIGURED_OPENING', 'Copy configured opening quantities', 'Uses only formal opening quantities and creates auditable opening records.'],
                          ['CURRENT_STOCK_ADVANCED', 'Copy current stock quantities', 'Advanced. Uses current source balances as destination opening balances.'],
                        ].map(([value, label, description]) => (
                          <label key={value} className={`rounded-lg border p-3 ${value === 'CURRENT_STOCK_ADVANCED' ? 'border-red-200 bg-red-50/50' : 'border-neutral-200'}`}>
                            <span className="flex items-start gap-3">
                              <input type="radio" name="inventoryOption" checked={inventoryOption === value} onChange={() => setInventoryOption(value as InventoryOption)} className="mt-0.5 h-5 w-5 accent-[#5c4033]" />
                              <span><span className="font-black">{label}</span><span className="mt-1 block text-sm text-neutral-500">{description}</span></span>
                            </span>
                          </label>
                        ))}
                      </div>
                      {inventoryOption === 'CURRENT_STOCK_ADVANCED' && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
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

              {wizardStep === 4 && preview && (
                <div>
                  <div className="flex items-start gap-3">
                    {preview.canCreate
                      ? <CheckCircle2 className="mt-0.5 text-emerald-600" />
                      : <AlertTriangle className="mt-0.5 text-amber-600" />}
                    <div>
                      <h3 className="text-lg font-black">Dry-run preview</h3>
                      <p className="text-sm text-neutral-500">No writes have occurred. Review every proposed collection change.</p>
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

              {wizardStep === 5 && (
                <div className="py-8 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Check size={28} /></div>
                  <h3 className="mt-4 text-xl font-black text-[#3e2723]">Location created as Draft</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-neutral-600">No historical transactions or staff accounts were copied. Complete the readiness review before activating POS.</p>
                </div>
              )}
            </section>

            <footer className="mt-4 flex flex-wrap justify-between gap-2">
              <button
                onClick={() => setWizardStep((step) => Math.max(1, step - 1))}
                disabled={wizardStep === 1 || wizardStep === 5}
                className="h-11 rounded-lg border border-neutral-200 bg-white px-4 font-bold disabled:opacity-40"
              >
                Back
              </button>
              <div className="flex gap-2">
                {wizardStep < 3 && (
                  <button
                    onClick={() => setWizardStep((step) => step + 1)}
                    disabled={wizardStep === 2 && templateMode === 'COPY' && !sourceStoreId}
                    className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-40"
                  >
                    Continue <ChevronRight size={16} />
                  </button>
                )}
                {wizardStep === 3 && (
                  <button onClick={handlePreview} disabled={actioning === 'preview'} className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">
                    {actioning === 'preview' && <Loader2 size={16} className="animate-spin" />} Preview dry run
                  </button>
                )}
                {wizardStep === 4 && (
                  <button onClick={handleCreateDraft} disabled={actioning === 'create' || !preview?.canCreate} className="flex h-11 items-center gap-2 rounded-lg bg-[#3e2723] px-5 font-black text-white disabled:opacity-50">
                    {actioning === 'create' && <Loader2 size={16} className="animate-spin" />} Create Draft
                  </button>
                )}
                {wizardStep === 5 && (
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
