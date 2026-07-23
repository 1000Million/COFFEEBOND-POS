import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from 'firebase/storage';
import { useAuth } from '../../contexts/AuthContext';
import { db, storage } from '../../lib/firebase';
import { buildPublicMenuAvailabilitySnapshot } from '../../lib/publicMenuAvailability';
import {
  buildProductImageAuditRecord,
  buildProductImagePatch,
  buildNextProductImageStoragePath,
  buildProductImageUploadMetadata,
  getCurrentProductImage,
  prepareProductImageForUpload,
  validateProductImageFile,
} from '../../lib/productImages';
import { FinishedGood, PrepItem, ProductImageAudit, RawIngredient, StoreStock } from '../../types/menu-management';
import { Store } from '../../types';

type FiniteFilter = 'all' | 'active' | 'inactive';
type ImageFilter = 'all' | 'with-image' | 'missing-image';

type FinishedGoodRecord = FinishedGood & { id: string };
type StoreRecord = Store & { id: string };

type PreviewState = {
  file: File;
  blob: Blob;
  previewUrl: string;
  fileName: string;
  action: 'UPLOAD' | 'REPLACE';
};

type PendingMutation = {
  productDocumentId: string;
  productCode: string;
  productName: string;
  action: 'UPLOAD' | 'REPLACE' | 'REMOVE';
  storagePath: string | null;
  downloadUrl: string | null;
  previousImageUrl: string | null;
  previousImageStoragePath: string | null;
  actorUid: string;
  actorEmail: string | null;
  timestamp: any;
};

function isAdminOnlyRole(role?: string | null): boolean {
  return role === 'ADMIN';
}

function countCoverage(items: FinishedGoodRecord[]) {
  const total = items.length;
  const withImage = items.filter((item) => !!getCurrentProductImage(item).imageUrl).length;
  const missingImage = Math.max(0, total - withImage);
  const coverage = total > 0 ? Math.round((withImage / total) * 100) : 0;
  return { total, withImage, missingImage, coverage };
}

function fileInputAccept(): string {
  return ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].join(',');
}

function previewTitle(action: PreviewState['action'], product: FinishedGoodRecord) {
  return `${action === 'UPLOAD' ? 'Upload' : 'Replace'} preview for ${product.name}`;
}

function firebaseErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.trim() ? code : 'unknown';
}

async function readWithContext<T>(step: string, path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error('product-images-read-failed', {
      step,
      path,
      code: firebaseErrorCode(error),
      message: error instanceof Error ? error.message : 'Unknown Firestore read error',
    });
    throw error;
  }
}

export default function ProductImages() {
  const { staffProfile } = useAuth();
  const isAdmin = isAdminOnlyRole(staffProfile?.role);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGoodRecord[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [rawIngredients, setRawIngredients] = useState<RawIngredient[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [storeStock, setStoreStock] = useState<(StoreStock & Record<string, unknown>)[]>([]);
  const [auditRows, setAuditRows] = useState<ProductImageAudit[]>([]);
  const [selectedProductCode, setSelectedProductCode] = useState<string>('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [activeFilter, setActiveFilter] = useState<FiniteFilter>('all');
  const [imageFilter, setImageFilter] = useState<ImageFilter>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [errorTitle, setErrorTitle] = useState('Product image issue');
  const [auditWarning, setAuditWarning] = useState('');
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const sellableFinishedGoods = useMemo(
    () => finishedGoods.filter((item) => item.isSellable !== false),
    [finishedGoods],
  );

  const selectedProduct = useMemo(
    () => sellableFinishedGoods.find((item) => item.code === selectedProductCode) || null,
    [sellableFinishedGoods, selectedProductCode],
  );

  const productCategories = useMemo(() => {
    const names = Array.from(new Set(sellableFinishedGoods.map((item) => item.posCategoryName || 'Other'))).sort((a, b) => a.localeCompare(b));
    return ['ALL', ...names];
  }, [sellableFinishedGoods]);

  const visibleProducts = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return sellableFinishedGoods
      .filter((item) => {
        const matchesSearch = !searchText
          || `${item.name} ${item.code} ${item.displayName || ''} ${item.posCategoryName || ''}`.toLowerCase().includes(searchText);
        const matchesCategory = categoryFilter === 'ALL' || (item.posCategoryName || 'Other') === categoryFilter;
        const isActive = item.isActive !== false;
        const matchesActive = activeFilter === 'all'
          || (activeFilter === 'active' && isActive)
          || (activeFilter === 'inactive' && !isActive);
        const hasImage = !!getCurrentProductImage(item).imageUrl;
        const matchesImage = imageFilter === 'all'
          || (imageFilter === 'with-image' && hasImage)
          || (imageFilter === 'missing-image' && !hasImage);
        return matchesSearch && matchesCategory && matchesActive && matchesImage;
      })
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
  }, [activeFilter, categoryFilter, imageFilter, search, sellableFinishedGoods]);

  const coverage = useMemo(() => countCoverage(sellableFinishedGoods), [sellableFinishedGoods]);
  const recentAudits = useMemo(() => auditRows.slice(0, 10), [auditRows]);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;

    async function loadData() {
      setLoading(true);
      setError('');
      setAuditWarning('');
      try {
        const [finishedSnap, storesSnap, rawSnap, prepSnap, stockSnap] = await Promise.all([
          readWithContext('LOAD_FINISHED_GOODS', 'finishedGoods', () => getDocs(query(collection(db, 'finishedGoods'), orderBy('name', 'asc')))),
          readWithContext('LOAD_STORES', 'stores', () => getDocs(query(collection(db, 'stores')))),
          readWithContext('LOAD_RAW_INGREDIENTS', 'rawIngredients', () => getDocs(query(collection(db, 'rawIngredients')))),
          readWithContext('LOAD_PREP_ITEMS', 'prepItems', () => getDocs(query(collection(db, 'prepItems')))),
          readWithContext('LOAD_STORE_STOCK', 'storeStock', () => getDocs(query(collection(db, 'storeStock')))),
        ]);

        const auditSnap = await readWithContext(
          'LOAD_PRODUCT_IMAGE_AUDIT',
          'productImageAudit',
          () => getDocs(query(collection(db, 'productImageAudit'), orderBy('timestamp', 'desc'), limit(10))),
        ).catch((auditError) => {
          if (active) {
            setAuditWarning(`Recent image history is unavailable (${firebaseErrorCode(auditError)}). Product management remains available.`);
          }
          return null;
        });

        if (!active) return;
        const nextFinishedGoods = finishedSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as FinishedGoodRecord));
        const nextSellableFinishedGoods = nextFinishedGoods.filter((item) => item.isSellable !== false);
        setFinishedGoods(nextFinishedGoods);
        setStores(storesSnap.docs
          .map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as StoreRecord))
          .filter((store) => store.isActive !== false)
          .sort((a, b) => a.name.localeCompare(b.name)));
        setRawIngredients(rawSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as RawIngredient)));
        setPrepItems(prepSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as PrepItem)));
        setStoreStock(stockSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as StoreStock & Record<string, unknown>)));
        setAuditRows(auditSnap
          ? auditSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) } as ProductImageAudit))
          : []);
        setSelectedProductCode((current) => (
          nextSellableFinishedGoods.some((item) => item.code === current)
            ? current
            : nextSellableFinishedGoods[0]?.code || ''
        ));
      } catch (err) {
        console.error('Failed to load product images', err);
        if (active) {
          setErrorTitle('Product catalog unavailable');
          setError(`We could not load sellable products (${firebaseErrorCode(err)}). Check the console for the failed Firestore path.`);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadData();
    return () => {
      active = false;
    };
  }, [isAdmin]);

  const openPreview = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const clearPreview = () => {
    if (preview?.previewUrl) URL.revokeObjectURL(preview.previewUrl);
    setPreview(null);
    setPendingMutation(null);
    setUploadProgress(0);
  };

  useEffect(() => () => {
    if (preview?.previewUrl) URL.revokeObjectURL(preview.previewUrl);
  }, [preview?.previewUrl]);

  const createPreviewFromFile = async (file: File, action: PreviewState['action']) => {
    setPreviewBusy(true);
    setError('');
    setErrorTitle('Image preview failed');
    try {
      const blob = await prepareProductImageForUpload(file);
      const previewUrl = URL.createObjectURL(blob);
      if (preview?.previewUrl) URL.revokeObjectURL(preview.previewUrl);
      setPreview({
        file,
        blob,
        previewUrl,
        fileName: file.name,
        action,
      });
    } catch (err) {
      console.error('Product image preview failed', err);
      setError(err instanceof Error ? err.message : 'Unable to prepare image preview.');
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleFilePicked = async (file: File, action: PreviewState['action']) => {
    const validation = validateProductImageFile(file);
    if (!validation.ok) {
      setError(validation.message || 'Unsupported image.');
      setErrorTitle('Image validation failed');
      return;
    }
    if (!selectedProduct) {
      setError('Choose a product first.');
      setErrorTitle('Product selection required');
      return;
    }
    await createPreviewFromFile(file, action);
  };

  const finalizeFirestoreWrite = async (mutation: PendingMutation) => {
    if (!selectedProduct) throw new Error('Select a product first.');

    const nextFinishedGoods = finishedGoods.map((item) => {
      if (item.id !== mutation.productDocumentId) return item;
      return {
        ...item,
        ...buildProductImagePatch({
          product: item,
          action: mutation.action,
          newImageUrl: mutation.downloadUrl,
          newStoragePath: mutation.storagePath,
          actorUid: mutation.actorUid,
          actorEmail: mutation.actorEmail,
          timestamp: mutation.timestamp,
        }),
      };
    });

    const updatedProduct = nextFinishedGoods.find((item) => item.id === mutation.productDocumentId);
    if (!updatedProduct) throw new Error('The selected product could not be found after the image update.');

    const batch = writeBatch(db);
    batch.update(
      doc(db, 'finishedGoods', mutation.productDocumentId),
      buildProductImagePatch({
        product: selectedProduct,
        action: mutation.action,
        newImageUrl: mutation.downloadUrl,
        newStoragePath: mutation.storagePath,
        actorUid: mutation.actorUid,
        actorEmail: mutation.actorEmail,
        timestamp: mutation.timestamp,
      }),
    );
    batch.set(
      doc(collection(db, 'productImageAudit')),
      buildProductImageAuditRecord({
        product: selectedProduct,
        action: mutation.action,
        newImageUrl: mutation.downloadUrl,
        newStoragePath: mutation.storagePath,
        actorUid: mutation.actorUid,
        actorEmail: mutation.actorEmail,
        timestamp: mutation.timestamp,
      }),
    );

    const snapshotStores = stores.length > 0 ? stores : [];
    for (const store of snapshotStores) {
      const snapshot = buildPublicMenuAvailabilitySnapshot({
        store,
        finishedGoods: nextFinishedGoods,
        storeStock,
        rawIngredients,
        prepItems,
      });
      batch.set(doc(db, 'publicMenuAvailability', store.code), {
        ...snapshot,
        updatedAt: mutation.timestamp,
        updatedBy: mutation.actorUid,
      });
    }

    await batch.commit();
    setFinishedGoods(nextFinishedGoods);
    setMessage(`Saved image for ${selectedProduct.name}. Public menu snapshots refreshed.`);
    setAuditRows((rows) => [buildProductImageAuditRecord({
      product: selectedProduct,
      action: mutation.action,
      newImageUrl: mutation.downloadUrl,
      newStoragePath: mutation.storagePath,
      actorUid: mutation.actorUid,
      actorEmail: mutation.actorEmail,
      timestamp: mutation.timestamp,
    }), ...rows]);
  };

  const submitUpload = async () => {
    if (!selectedProduct) return;
    if (!preview) {
      setError('Choose an image before uploading.');
      setErrorTitle('Image required');
      return;
    }
    if (!isAdmin) {
      setError('Only Admin users can manage product images.');
      setErrorTitle('Admin access required');
      return;
    }

    setSaving(true);
    setError('');
    setUploadProgress(0);

    const storagePath = buildNextProductImageStoragePath(
      selectedProduct.code,
      getCurrentProductImage(selectedProduct).imageStoragePath,
      new Date(),
    );
    const downloadMeta = buildProductImageUploadMetadata(
      selectedProduct.code,
      selectedProduct.name,
      'admin-product-images',
    );

    try {
      const targetRef = storageRef(storage, storagePath);
      const uploadTask = uploadBytesResumable(targetRef, preview.blob, downloadMeta);
      await new Promise<void>((resolve, reject) => {
        uploadTask.on(
          'state_changed',
          (snapshot) => {
            const progress = snapshot.totalBytes
              ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
              : 0;
            setUploadProgress(progress);
          },
          reject,
          () => resolve(),
        );
      });

      const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
      const mutation: PendingMutation = {
        productDocumentId: selectedProduct.id,
        productCode: selectedProduct.code,
        productName: selectedProduct.name,
        action: preview.action,
        storagePath,
        downloadUrl,
        previousImageUrl: getCurrentProductImage(selectedProduct).imageUrl,
        previousImageStoragePath: getCurrentProductImage(selectedProduct).imageStoragePath,
        actorUid: staffProfile?.uid || '',
        actorEmail: staffProfile?.email || null,
        timestamp: serverTimestamp(),
      };
      setPendingMutation(mutation);
      await finalizeFirestoreWrite(mutation);
      clearPreview();
      setPendingMutation(null);
    } catch (err) {
      console.error('Product image upload failed', err);
      setErrorTitle('Image update failed');
      const messageText = err instanceof Error ? err.message : 'Image upload failed.';
      setError(messageText);
      setMessage(`Storage upload finished at ${storagePath}, but Firestore sync needs retry.`);
    } finally {
      setSaving(false);
      setUploadProgress(0);
    }
  };

  const retryFinalize = async () => {
    if (!pendingMutation) return;
    setSaving(true);
    setError('');
    try {
      await finalizeFirestoreWrite(pendingMutation);
      clearPreview();
      setPendingMutation(null);
    } catch (err) {
      console.error('Product image Firestore retry failed', err);
      setErrorTitle('Image sync failed');
      setError(err instanceof Error ? err.message : 'Firestore sync failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!selectedProduct) return;
    if (!isAdmin) {
      setError('Only Admin users can manage product images.');
      setErrorTitle('Admin access required');
      return;
    }
    const confirmed = window.confirm(`Remove the image for “${selectedProduct.name}”? The product will use the default placeholder on the customer menu.`);
    if (!confirmed) return;

    setSaving(true);
    setError('');
    try {
      const mutation: PendingMutation = {
        productDocumentId: selectedProduct.id,
        productCode: selectedProduct.code,
        productName: selectedProduct.name,
        action: 'REMOVE',
        storagePath: null,
        downloadUrl: null,
        previousImageUrl: getCurrentProductImage(selectedProduct).imageUrl,
        previousImageStoragePath: getCurrentProductImage(selectedProduct).imageStoragePath,
        actorUid: staffProfile?.uid || '',
        actorEmail: staffProfile?.email || null,
        timestamp: serverTimestamp(),
      };
      await finalizeFirestoreWrite(mutation);
      clearPreview();
      setPendingMutation(null);
    } catch (err) {
      console.error('Product image removal failed', err);
      setErrorTitle('Image removal failed');
      setError(err instanceof Error ? err.message : 'Image removal failed.');
    } finally {
      setSaving(false);
    }
  };

  const currentImage = selectedProduct ? getCurrentProductImage(selectedProduct) : { imageUrl: null, imageStoragePath: null };

  if (!isAdmin) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center rounded-3xl border border-dashed border-amber-300 bg-white px-6 py-16 text-center shadow-sm">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
          <ImageOff size={30} />
        </div>
        <p className="text-xl font-black text-[#4b2d22]">Admin access required</p>
        <p className="mt-2 max-w-md text-sm text-neutral-600">
          Product image management is restricted to Coffee Bond Admin users so menu images stay consistent across the customer ordering app.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-5 p-4 md:p-6">
      <div className="rounded-[28px] border border-amber-200 bg-gradient-to-br from-white to-[#fff8f0] p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-amber-700">Admin Tool</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-[#3e2723]">Product Images</h1>
            <p className="mt-2 max-w-3xl text-sm text-neutral-600">
              Upload, replace and remove sellable item photos. The tool centre-crops to a 4:3 card and refreshes the public customer menu snapshots automatically.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <SummaryCard label="Total products" value={coverage.total} />
            <SummaryCard label="With images" value={coverage.withImage} />
            <SummaryCard label="Missing images" value={coverage.missingImage} />
            <SummaryCard label="Coverage" value={`${coverage.coverage}%`} />
          </div>
        </div>
      </div>

      {error && (
        <Banner tone="error" title={errorTitle} body={error} />
      )}
      {auditWarning && (
        <Banner tone="warning" title="Audit history unavailable" body={auditWarning} />
      )}
      {message && (
        <Banner tone="success" title="Saved" body={message} />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <section className="rounded-[28px] border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by product name or code"
                className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 py-3 pl-10 pr-4 text-sm font-medium text-neutral-800 outline-none ring-0 focus:border-[#5c4033]"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <FilterPill label="All" active={activeFilter === 'all'} onClick={() => setActiveFilter('all')} />
              <FilterPill label="Active" active={activeFilter === 'active'} onClick={() => setActiveFilter('active')} />
              <FilterPill label="Inactive" active={activeFilter === 'inactive'} onClick={() => setActiveFilter('inactive')} />
              <FilterPill label="With image" active={imageFilter === 'with-image'} onClick={() => setImageFilter('with-image')} />
              <FilterPill label="Missing image" active={imageFilter === 'missing-image'} onClick={() => setImageFilter('missing-image')} />
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {productCategories.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setCategoryFilter(category)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                  categoryFilter === category
                    ? 'bg-[#5c4033] text-white'
                    : 'bg-[#f8f2eb] text-[#5c4033] hover:bg-[#f1e5d8]'
                }`}
              >
                {category === 'ALL' ? 'All categories' : category}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {loading ? (
              <LoadingState label="Loading products..." />
            ) : visibleProducts.length === 0 ? (
              <EmptyState />
            ) : (
              visibleProducts.map((item) => {
                const image = getCurrentProductImage(item);
                const hasImage = !!image.imageUrl;
                const isActive = item.isActive !== false;
                const selected = item.code === selectedProductCode;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedProductCode(item.code)}
                    className={`w-full rounded-[24px] border p-3 text-left transition-shadow ${
                      selected ? 'border-[#5c4033] bg-[#fffaf4] shadow-md' : 'border-neutral-200 bg-white hover:border-[#d7c2b0]'
                    }`}
                  >
                    <div className="flex min-w-0 gap-3">
                      <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-[#f7eee3]">
                        {hasImage ? (
                          <img
                            src={image.imageUrl || ''}
                            alt={item.name}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            decoding="async"
                            onError={(event) => {
                              event.currentTarget.style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[#a37551]">
                            <ImageOff size={24} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-amber-700">{item.posCategoryName || 'Other'}</p>
                          <StatusBadge tone={isActive ? 'success' : 'muted'} label={isActive ? 'Active' : 'Inactive'} />
                          <StatusBadge tone={hasImage ? 'success' : 'warning'} label={hasImage ? 'Has image' : 'Missing image'} />
                        </div>
                        <h3 className="mt-1 line-clamp-1 text-lg font-black text-[#2c1c17]">{item.name}</h3>
                        <p className="mt-0.5 text-sm font-semibold text-neutral-500">{item.code}</p>
                        <p className="mt-1 line-clamp-2 text-sm text-neutral-600">
                          {item.description || 'No description provided.'}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-neutral-500">
                          <span className="rounded-full bg-neutral-100 px-3 py-1">{item.prepStation}</span>
                          <span className="rounded-full bg-neutral-100 px-3 py-1">{item.itemType}</span>
                          <span className="rounded-full bg-neutral-100 px-3 py-1">{formatMoney(item.salePrice)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <aside className="space-y-5">
          <section className="rounded-[28px] border border-neutral-200 bg-white p-4 shadow-sm">
            {selectedProduct ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-700">Selected product</p>
                    <h2 className="mt-1 text-2xl font-black text-[#2c1c17]">{selectedProduct.name}</h2>
                    <p className="text-sm font-semibold text-neutral-500">{selectedProduct.code} • {selectedProduct.posCategoryName || 'Other'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectedProduct.imageUrl ? openPreview(selectedProduct.imageUrl) : undefined}
                    disabled={!selectedProduct.imageUrl}
                    className="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-2 text-sm font-bold text-[#5c4033] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ExternalLink size={14} />
                    Preview
                  </button>
                </div>

                <div className="mt-4 rounded-[28px] border border-dashed border-neutral-300 bg-[#fbf7f2] p-4">
                  <div className="overflow-hidden rounded-[24px] bg-[#f3e6d8]">
                    <div className="aspect-[4/3] w-full overflow-hidden bg-[#f3e6d8]">
                      {preview ? (
                        <img src={preview.previewUrl} alt={previewTitle(preview.action, selectedProduct)} className="h-full w-full object-cover" />
                      ) : selectedProduct.imageUrl ? (
                        <img
                          src={selectedProduct.imageUrl}
                          alt={selectedProduct.name}
                          className="h-full w-full object-cover"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-[#8e6a4e]">
                          <ImageIcon size={34} />
                          <p className="text-sm font-semibold">No image uploaded yet</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={saving || previewBusy}
                      className="inline-flex items-center gap-2 rounded-2xl bg-[#5c4033] px-4 py-2.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Upload size={16} />
                      {selectedProduct.imageUrl ? 'Replace image' : 'Upload image'}
                    </button>
                    <button
                      type="button"
                      onClick={handleRemove}
                      disabled={saving || previewBusy || !selectedProduct.imageUrl}
                      className="inline-flex items-center gap-2 rounded-2xl border border-red-200 bg-white px-4 py-2.5 text-sm font-black text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 size={16} />
                      Remove image
                    </button>
                    {pendingMutation && (
                      <button
                        type="button"
                        onClick={retryFinalize}
                        disabled={saving}
                        className="inline-flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-black text-amber-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RefreshCw size={16} />
                        Retry Firestore sync
                      </button>
                    )}
                    <input
                      ref={uploadInputRef}
                      type="file"
                      accept={fileInputAccept()}
                      className="hidden"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        await handleFilePicked(file, selectedProduct.imageUrl ? 'REPLACE' : 'UPLOAD');
                      }}
                    />
                  </div>

                  <div className="mt-3 text-sm text-neutral-600">
                    <p>Uploaded images are centre-cropped to a 4:3 card and exported as WebP for the customer ordering menu.</p>
                    <p className="mt-1 break-all text-xs text-neutral-500">
                      Current storage path: {currentImage.imageStoragePath || 'Not set yet'}
                    </p>
                  </div>

                  {preview && (
                    <div className="mt-4 space-y-2 rounded-2xl border border-neutral-200 bg-white p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-bold text-neutral-900">Ready for upload</p>
                          <p className="text-xs text-neutral-500">{preview.fileName}</p>
                        </div>
                        <button type="button" onClick={clearPreview} className="text-sm font-bold text-neutral-500">Clear</button>
                      </div>
                      <img src={preview.previewUrl} alt={previewTitle(preview.action, selectedProduct)} className="h-auto w-full rounded-2xl border border-neutral-200 object-cover" />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-neutral-500">1200 × 900 WebP card preview</p>
                        <button
                          type="button"
                          onClick={submitUpload}
                          disabled={saving || previewBusy}
                          className="inline-flex items-center gap-2 rounded-2xl bg-[#2d2019] px-4 py-2.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                          Save to menu
                        </button>
                      </div>
                      {uploadProgress > 0 && uploadProgress < 100 && (
                        <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
                          <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${uploadProgress}%` }} />
                        </div>
                      )}
                      {pendingMutation?.storagePath && (
                        <p className="text-xs font-semibold text-amber-700">
                          Upload stored at {pendingMutation.storagePath}. You can retry Firestore sync if the snapshot write fails.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 grid gap-3 rounded-[24px] border border-neutral-200 bg-neutral-50 p-4 text-sm sm:grid-cols-2">
                  <Detail label="Image status" value={selectedProduct.imageUrl ? 'Has image' : 'Missing image'} />
                  <Detail label="Image source" value={selectedProduct.imageSource || '—'} />
                  <Detail label="Updated by" value={selectedProduct.imageUpdatedBy || '—'} />
                  <Detail label="Updated at" value={selectedProduct.imageUpdatedAt ? 'Saved' : '—'} />
                  <Detail label="Previous URL" value={selectedProduct.previousImageUrl || '—'} />
                  <Detail label="Previous path" value={selectedProduct.previousImageStoragePath || '—'} />
                </div>
              </>
            ) : (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[24px] border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
                <ImageOff size={36} className="text-neutral-400" />
                <p className="mt-3 text-lg font-black text-neutral-800">Select a product</p>
                <p className="mt-1 max-w-sm text-sm text-neutral-600">
                  Pick a sellable item on the left to upload, replace or remove its customer menu image.
                </p>
              </div>
            )}
          </section>

          <section className="rounded-[28px] border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-700">Recent actions</p>
                <h2 className="text-xl font-black text-[#2c1c17]">Product image audit</h2>
              </div>
              <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-bold text-neutral-500">
                {recentAudits.length} shown
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {recentAudits.length === 0 ? (
                <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-500">
                  No image audit records yet.
                </div>
              ) : (
                recentAudits.map((row) => (
                  <div key={row.id} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-black text-[#2c1c17]">{row.productName}</p>
                        <p className="text-xs font-semibold text-neutral-500">{row.productCode} • {row.action}</p>
                      </div>
                      <StatusBadge
                        tone={row.action === 'REMOVE' ? 'warning' : 'success'}
                        label={row.action}
                      />
                    </div>
                    <div className="mt-2 grid gap-2 text-xs text-neutral-500 sm:grid-cols-2">
                      <Detail label="New image" value={row.newImageUrl || 'Removed'} />
                      <Detail label="Storage path" value={row.newStoragePath || 'Removed'} />
                      <Detail label="By" value={row.performedByEmail || row.performedByUid} />
                      <Detail label="Timestamp" value="Recorded" />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-amber-100 bg-white px-3 py-2 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">{label}</p>
      <p className="mt-1 text-lg font-black text-[#2c1c17]">{value}</p>
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-bold transition-colors ${
        active ? 'bg-[#5c4033] text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
      }`}
    >
      {label}
    </button>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: 'success' | 'warning' | 'muted' }) {
  const toneClass = tone === 'success'
    ? 'bg-emerald-100 text-emerald-800'
    : tone === 'warning'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-neutral-200 text-neutral-600';
  return <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${toneClass}`}>{label}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-400">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-neutral-700">{value}</p>
    </div>
  );
}

function Banner({ tone, title, body }: { tone: 'success' | 'warning' | 'error'; title: string; body: string }) {
  const styles = tone === 'success'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-red-200 bg-red-50 text-red-800';
  return (
    <div className={`rounded-[24px] border px-4 py-3 shadow-sm ${styles}`}>
      <p className="text-sm font-black">{title}</p>
      <p className="mt-1 text-sm font-medium">{body}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-neutral-50 px-4 py-5 text-sm font-semibold text-neutral-600">
      <Loader2 className="animate-spin text-[#5c4033]" size={18} />
      {label}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-3xl border border-dashed border-neutral-300 bg-neutral-50 px-6 py-12 text-center">
      <ImageOff className="mx-auto text-neutral-400" size={32} />
      <p className="mt-3 text-lg font-black text-neutral-800">No products match these filters</p>
      <p className="mt-1 text-sm text-neutral-600">Try a different search, category or image filter.</p>
    </div>
  );
}

function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}
