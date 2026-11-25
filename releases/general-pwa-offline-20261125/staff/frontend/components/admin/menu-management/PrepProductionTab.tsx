import React, { useState, useEffect, useMemo } from "react";
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { db } from "../../../lib/firebase";
import {
  PrepProduction,
  PrepItem,
  StoreStock,
} from "../../../types/menu-management";
import { Store } from "../../../types";
import {
  Loader2,
  Store as StoreIcon,
  History,
  AlertCircle,
  PackagePlus,
  AlertTriangle,
  FilePlus,
} from "lucide-react";
import { useAuth } from "../../../contexts/AuthContext";
import { producePrepItem } from "../../../lib/production";

export default function PrepProductionTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === "ADMIN";
  const isManager = staffProfile?.role === "STORE_MANAGER";

  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");
  const [history, setHistory] = useState<PrepProduction[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [storeStock, setStoreStock] = useState<StoreStock[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedPrepCode, setSelectedPrepCode] = useState<string>("");
  const [outputQty, setOutputQty] = useState<string>("");
  const [producing, setProducing] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    const fetchStores = async () => {
      const q = query(collection(db, "stores"), orderBy("name", "asc"));
      const snap = await getDocs(q);
      const data = snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Store);

      let allowedStores = data;
      if (isManager && staffProfile?.storeIds) {
        allowedStores = data.filter((s) =>
          staffProfile.storeIds.includes(s.id),
        );
      } else if (!isAdmin && !isManager) {
        if (staffProfile?.storeIds) {
          allowedStores = data.filter((s) =>
            staffProfile.storeIds.includes(s.id),
          );
        } else {
          allowedStores = [];
        }
      }

      setStores(allowedStores);
      if (allowedStores.length > 0) {
        setSelectedStoreId(allowedStores[0].id);
      }
      setLoading(false);
    };
    fetchStores();
  }, [isAdmin, isManager, staffProfile]);

  useEffect(() => {
    const q = query(collection(db, "prepItems"), orderBy("name", "asc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map((doc) => ({ ...doc.data() }) as PrepItem)
        .filter((item) => item.isActive);
      setPrepItems(data);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedStoreId) {
      setHistory([]);
      setStoreStock([]);
      return;
    }

    // History
    const qHistory = query(collection(db, "prepProductions"));
    const unsubHistory = onSnapshot(qHistory, (snapshot) => {
      const data = snapshot.docs
        .map((doc) => ({ ...doc.data(), id: doc.id }) as PrepProduction)
        .filter((p) => p.storeId === selectedStoreId);

      data.sort((a, b) => {
        const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return tB - tA; // descending
      });
      setHistory(data);
    });

    // Store Stock
    const qStock = query(collection(db, "storeStock"));
    const unsubStock = onSnapshot(qStock, (snapshot) => {
      const data = snapshot.docs
        .map((doc) => ({ ...doc.data() }) as StoreStock)
        .filter((s) => s.storeId === selectedStoreId);
      setStoreStock(data);
    });

    return () => {
      unsubHistory();
      unsubStock();
    };
  }, [selectedStoreId]);

  const selectedItem = useMemo(
    () => prepItems.find((p) => p.code === selectedPrepCode),
    [prepItems, selectedPrepCode],
  );

  useEffect(() => {
    if (selectedItem) {
      setOutputQty(selectedItem.yieldQuantity?.toString() || "1");
    } else {
      setOutputQty("");
    }
  }, [selectedItem]);

  const handleProduce = async () => {
    if (!selectedStoreId || !selectedItem || !outputQty) return;
    const store = stores.find((s) => s.id === selectedStoreId);
    if (!store) return;

    const qty = parseFloat(outputQty);
    if (isNaN(qty) || qty <= 0) {
      setError("Please enter a valid output quantity.");
      return;
    }

    setProducing(true);
    setError("");
    setSuccessMsg("");

    try {
      await producePrepItem(
        store.id,
        store.name,
        selectedItem,
        qty,
        `Produced ${qty}${selectedItem.outputUOM} via Admin Portal`,
        staffProfile!.uid,
        staffProfile!.name,
      );
      setSuccessMsg(
        `Successfully produced ${qty}${selectedItem.outputUOM} of ${selectedItem.name}.`,
      );
      setSelectedPrepCode("");
      setOutputQty("");
      setTimeout(() => setSuccessMsg(""), 5000);
    } catch (err: any) {
      setError(err.message || "Failed to produce batch.");
    } finally {
      setProducing(false);
    }
  };

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#5c4033]" />
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
        <AlertCircle size={48} className="mb-4 opacity-30 text-amber-600" />
        <p className="font-bold text-lg text-neutral-600 mb-2">
          No Stores Found
        </p>
        <p className="text-sm max-w-md text-center">
          You don't have access to any stores to view production history.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full">
      <div className="bg-white p-4 rounded-xl shadow-sm border border-neutral-200 mb-6 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between w-full min-w-0">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="w-10 h-10 bg-[#5c4033]/10 text-[#5c4033] rounded-lg flex items-center justify-center shrink-0">
            <StoreIcon size={20} />
          </div>
          <div className="flex-1 md:w-64">
            <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">
              Select Store
            </label>
            <select
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="w-full bg-transparent font-bold text-neutral-800 focus:outline-none cursor-pointer"
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-6 w-full">
        <div>
          <h3 className="text-xl font-black text-neutral-800">
            Prep Production
          </h3>
          <p className="text-sm text-neutral-500 mt-1">
            Produce batch-prepped components and review production history by
            store.
          </p>
        </div>
      </div>

      {(isAdmin || isManager) && (
        <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm mb-8 overflow-hidden">
          <div className="bg-neutral-50 px-5 py-4 border-b border-neutral-200 flex items-center gap-3">
            <PackagePlus className="text-[#5c4033]" size={20} />
            <div>
              <h4 className="font-bold text-neutral-800">Produce Batch</h4>
              <p className="text-xs text-neutral-500">
                Select a batch-prepped component to produce.
              </p>
            </div>
          </div>

          <div className="p-5">
            {prepItems.length === 0 ? (
              <div className="bg-amber-50 text-amber-800 p-4 rounded-xl text-sm border border-amber-200 flex items-start gap-3">
                <AlertCircle size={18} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block mb-1">
                    No batch-prepped components found.
                  </span>
                  Please create active prep items in the Batch Prep tab before
                  producing items.
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-neutral-700 mb-1">
                      Batch Component
                    </label>
                    <select
                      value={selectedPrepCode}
                      onChange={(e) => setSelectedPrepCode(e.target.value)}
                      disabled={producing}
                      className="w-full bg-white border border-neutral-200 text-sm font-semibold text-neutral-800 px-3 py-2.5 rounded-lg outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                    >
                      <option value="">Select a prep item...</option>
                      {prepItems.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name} &mdash; {item.yieldQuantity}
                          {item.outputUOM} batch
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedItem && (
                    <div className="flex gap-4">
                      <div className="flex-1">
                        <label className="block text-sm font-bold text-neutral-700 mb-1">
                          Output Quantity
                        </label>
                        <div className="relative">
                          <input
                            type="number"
                            min="0.1"
                            step="any"
                            value={outputQty}
                            onChange={(e) => setOutputQty(e.target.value)}
                            disabled={producing}
                            className="w-full bg-white border border-neutral-200 font-bold text-neutral-800 px-3 py-2.5 rounded-lg outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
                            placeholder="Qty"
                          />
                          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-neutral-400 pointer-events-none">
                            {selectedItem.outputUOM}
                          </div>
                        </div>
                      </div>

                      <div className="flex-1">
                        <label className="block text-sm font-bold text-neutral-700 mb-1">
                          Scale Factor
                        </label>
                        <div className="h-[42px] bg-neutral-50 border border-neutral-200 rounded-lg px-3 flex items-center font-mono text-sm text-neutral-600 font-semibold">
                          {parseFloat(outputQty) > 0
                            ? (
                                parseFloat(outputQty) /
                                (selectedItem.yieldQuantity || 1)
                              ).toFixed(2)
                            : "0.00"}
                          x
                        </div>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm border border-red-100 flex items-start gap-2">
                      <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                      <span className="font-medium">{error}</span>
                    </div>
                  )}
                  {successMsg && (
                    <div className="bg-emerald-50 text-emerald-700 p-3 rounded-lg text-sm border border-emerald-100 flex items-start gap-2">
                      <PackagePlus size={16} className="shrink-0 mt-0.5" />
                      <span className="font-bold">{successMsg}</span>
                    </div>
                  )}

                  <button
                    onClick={handleProduce}
                    disabled={
                      !selectedItem ||
                      !outputQty ||
                      parseFloat(outputQty) <= 0 ||
                      producing
                    }
                    className="w-full py-3 bg-[#5c4033] hover:bg-[#4a332a] text-white font-bold rounded-xl disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                  >
                    {producing ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />{" "}
                        Producing...
                      </>
                    ) : (
                      <>
                        <FilePlus size={18} /> Produce Batch
                      </>
                    )}
                  </button>
                </div>

                <div className="bg-neutral-50 rounded-xl border border-neutral-200 p-4">
                  <h5 className="font-bold text-sm text-neutral-700 mb-3 border-b border-neutral-200 pb-2">
                    Component Usage Preview
                  </h5>

                  {!selectedItem ? (
                    <div className="text-neutral-400 text-sm font-medium text-center py-6">
                      Select a prep item to view component requirements.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {selectedItem.bom?.map((line, idx) => {
                        const scale =
                          parseFloat(outputQty) > 0
                            ? parseFloat(outputQty) /
                              (selectedItem.yieldQuantity || 1)
                            : 0;
                        const neededQty = line.quantity * scale;

                        // Available quantity
                        const legacyId = `${selectedStoreId}_${line.componentCode}`;
                        const newId = `${selectedStoreId}_${line.componentType}_${line.componentCode}`;

                        const availableStock =
                          storeStock.find(
                            (s) => s.id === legacyId || s.id === newId,
                          )?.currentStock || 0;
                        const isSufficient = availableStock >= neededQty;

                        return (
                          <div
                            key={idx}
                            className="flex justify-between items-center text-sm p-3 bg-white rounded-lg border border-neutral-200 shadow-sm"
                          >
                            <div className="font-medium text-neutral-700">
                              {line.componentName}
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-neutral-900">
                                {neededQty.toFixed(2)} {line.uom}{" "}
                                <span className="text-neutral-400 font-normal ml-1">
                                  required
                                </span>
                              </div>
                              <div
                                className={`text-xs font-bold ${isSufficient ? "text-emerald-600" : "text-red-500"}`}
                              >
                                {availableStock.toFixed(2)} {line.uom} available
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      <div className="pt-3 border-t border-neutral-200 mt-4 flex justify-between items-center">
                        <span className="font-bold text-neutral-600 text-sm">
                          Estimated Batch Cost
                        </span>
                        <span className="font-black text-[#5c4033] text-lg">
                          $
                          {(
                            selectedItem.costPerUnit *
                            parseFloat(outputQty || "0")
                          ).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-neutral-800">
          Production History
        </h3>
      </div>

      {history.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
          <History size={48} className="mb-4 opacity-30 text-[#5c4033]" />
          <p className="font-bold text-lg text-neutral-600 mb-2">
            No production history
          </p>
          <p className="text-sm max-w-md text-center">
            No batches produced yet for this store.
          </p>
        </div>
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <div className="w-full overflow-x-auto">
            <table className="min-w-[720px] w-full text-left border-collapse">
              <thead>
                <tr className="bg-neutral-50/50 border-b border-neutral-200">
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">
                    Date & Time
                  </th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">
                    Prep Item
                  </th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">
                    Output Qty
                  </th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right">
                    Total Cost
                  </th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">
                    Produced By
                  </th>
                  <th className="p-4 font-bold text-xs text-neutral-500 uppercase tracking-wider">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {history.map((prod) => {
                  const date = prod.createdAt?.toDate
                    ? prod.createdAt.toDate()
                    : new Date();
                  return (
                    <tr
                      key={prod.id}
                      className="hover:bg-neutral-50/50 transition-colors"
                    >
                      <td className="p-4 whitespace-nowrap">
                        <div className="font-bold text-neutral-800">
                          {date.toLocaleDateString()}
                        </div>
                        <div className="text-xs text-neutral-500 font-medium">
                          {date.toLocaleTimeString()}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="font-bold text-neutral-800">
                          {prod.prepItemName}
                        </div>
                        <div className="text-xs text-neutral-500 font-mono">
                          {prod.prepItemCode}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <span className="font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-lg">
                          +{prod.outputQuantity?.toFixed(2)}{" "}
                          <span className="text-xs opacity-75">
                            {prod.outputUOM}
                          </span>
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-bold text-neutral-800">
                          ${prod.totalCost?.toFixed(2)}
                        </div>
                        <div className="text-xs text-neutral-500 font-medium">
                          @ ${prod.costPerUnit?.toFixed(2)}/{prod.outputUOM}
                        </div>
                      </td>
                      <td className="p-4 whitespace-nowrap">
                        <div className="text-sm font-bold text-neutral-700">
                          {prod.createdByName}
                        </div>
                      </td>
                      <td className="p-4">
                        <div
                          className="text-sm text-neutral-600 max-w-xs truncate"
                          title={prod.notes}
                        >
                          {prod.notes || "-"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
