import React, { useState, useEffect, useMemo } from "react";
import { X, Save, Loader2, Plus, Trash2, AlertCircle } from "lucide-react";
import {
  FinishedGood,
  BOMComponent,
  RawIngredient,
  PrepItem,
  BOMComponentType,
} from "../../../types/menu-management";
import {
  collection,
  doc,
  setDoc,
  getDocs,
  serverTimestamp,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../../lib/firebase";
import { validateBOM } from "../../../lib/bomValidation";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  item: FinishedGood | null;
}

const DEFAULT_ITEM: Partial<FinishedGood> = {
  code: "",
  name: "",
  displayName: "",
  description: "",
  posCategoryCode: "",
  posCategoryName: "",
  salePrice: 0,
  productionMode: "MADE_TO_ORDER",
  itemType: "MADE_TO_ORDER",
  prepStation: "BARISTA",
  taxRate: 0,
  bom: [],
  bomVersion: 1,
  recipeCost: 0,
  grossMargin: 0,
  cogsPercent: 0,
  sortOrder: 0,
  availableStoreIds: [],
  isSellable: true,
  isAvailable: true,
  isActive: true,
};

export default function FinishedGoodModal({ isOpen, onClose, item }: Props) {
  const [formData, setFormData] = useState<Partial<FinishedGood>>(DEFAULT_ITEM);
  const [bom, setBom] = useState<BOMComponent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [rawIngredients, setRawIngredients] = useState<RawIngredient[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoadingLookups(true);
      Promise.all([
        getDocs(
          query(
            collection(db, "rawIngredients"),
            where("isActive", "==", true),
          ),
        ),
        getDocs(
          query(collection(db, "prepItems"), where("isActive", "==", true)),
        ),
        getDocs(
          query(collection(db, "finishedGoods"), where("isActive", "==", true)),
        ),
      ])
        .then(([rawSnap, prepSnap, fgSnap]) => {
          setRawIngredients(
            rawSnap.docs.map(
              (d) => ({ ...d.data(), id: d.id }) as RawIngredient,
            ),
          );
          setPrepItems(
            prepSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as PrepItem),
          );
          setFinishedGoods(
            fgSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as FinishedGood),
          );
        })
        .catch((err) => {
          console.error("Failed to load component list", err);
          setError("Failed to load components for BOM.");
        })
        .finally(() => {
          setLoadingLookups(false);
        });
    }
  }, [isOpen]);

  useEffect(() => {
    if (item) {
      setFormData(item);
      setBom(item.bom || []);
    } else {
      setFormData(DEFAULT_ITEM);
      setBom([]);
    }
    setError("");
  }, [item, isOpen]);

  const availableComponents = useMemo(() => {
    const raw: {
      type: BOMComponentType;
      code: string;
      name: string;
      uom: string;
      cost: number;
    }[] = rawIngredients.map((r) => ({
      type: r.category.toUpperCase().includes("PACKAGING")
        ? "PACKAGING"
        : "RAW_INGREDIENT",
      code: r.code,
      name: r.name,
      uom: r.usageUOM,
      cost: r.costPerUsageUnit || 0,
    }));
    const prep: {
      type: BOMComponentType;
      code: string;
      name: string;
      uom: string;
      cost: number;
    }[] = prepItems.map((p) => ({
      type: "PREP_ITEM",
      code: p.code,
      name: p.name,
      uom: p.outputUOM,
      cost: p.costPerUnit || 0,
    }));
    const fg: {
      type: BOMComponentType;
      code: string;
      name: string;
      uom: string;
      cost: number;
    }[] = finishedGoods
      .filter(
        (f) =>
          f.itemType === "DIRECT_STOCK" &&
          (!formData.code || f.code !== formData.code),
      )
      .map((f) => ({
        type: "FINISHED_GOOD",
        code: f.code,
        name: f.name,
        uom: "pcs",
        cost: f.recipeCost || 0,
      }));

    const all = [...raw, ...prep, ...fg].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    if (formData.productionMode === "MADE_TO_ORDER") {
      return all.filter(
        (c) =>
          c.type === "RAW_INGREDIENT" ||
          c.type === "PREP_ITEM" ||
          c.type === "PACKAGING",
      );
    }

    return all;
  }, [
    rawIngredients,
    prepItems,
    finishedGoods,
    formData.code,
    formData.productionMode,
  ]);

  if (!isOpen) return null;

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value, type } = e.target as HTMLInputElement;
    let finalValue: any = value;
    if (type === "number") {
      finalValue = value === "" ? 0 : parseFloat(value);
    } else if (type === "checkbox") {
      finalValue = (e.target as HTMLInputElement).checked;
    }

    setFormData((prev) => {
      const updated = { ...prev, [name]: finalValue };
      if (name === "productionMode") {
        if (value === "BOUGHT_AND_SOLD") updated.itemType = "DIRECT_STOCK";
        else if (value === "NO_STOCK") updated.itemType = "NO_STOCK";
        else updated.itemType = "MADE_TO_ORDER"; // MADE_TO_ORDER or ASSEMBLED_TO_ORDER
      }
      return updated;
    });
  };

  const handleAddBomLine = () => {
    setBom((prev) => [
      ...prev,
      {
        componentType: "RAW_INGREDIENT",
        componentCode: "",
        componentName: "",
        quantity: 0,
        uom: "",
        costPerUnit: 0,
        lineCost: 0,
      },
    ]);
  };

  const handleRemoveBomLine = (index: number) => {
    setBom((prev) => prev.filter((_, i) => i !== index));
  };

  const handleBomChange = (
    index: number,
    field: keyof BOMComponent,
    value: any,
  ) => {
    setBom((prev) => {
      const updated = [...prev];
      const line = { ...updated[index], [field]: value };

      if (field === "componentCode") {
        const comp = availableComponents.find((c) => c.code === value);
        if (comp) {
          line.componentType = comp.type;
          line.componentCode = comp.code;
          line.componentName = comp.name;
          line.uom = comp.uom;
          line.costPerUnit = comp.cost;
        } else {
          line.componentName = "";
          line.uom = "";
          line.costPerUnit = 0;
        }
      }

      line.lineCost = (line.quantity || 0) * (line.costPerUnit || 0);
      updated[index] = line;
      return updated;
    });
  };

  const checkCircularParams = (
    targetCode: string,
    components: BOMComponent[],
  ): boolean => {
    for (const line of components) {
      if (line.componentType === "FINISHED_GOOD") {
        if (line.componentCode === targetCode) return true;
        const subFg = finishedGoods.find((f) => f.code === line.componentCode);
        if (subFg && subFg.bom) {
          if (checkCircularParams(targetCode, subFg.bom)) return true;
        }
      }
    }
    return false;
  };

  const recipeCost = bom.reduce((sum, line) => sum + (line.lineCost || 0), 0);
  const salePrice = Number(formData.salePrice) || 0;
  const grossMargin = salePrice - recipeCost;
  const cogsPercent = salePrice > 0 ? (recipeCost / salePrice) * 100 : 0;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!formData.name) {
      setError("Name is required.");
      return;
    }

    const finalCode = formData.code
      ? formData.code
          .toUpperCase()
          .replace(/\s+/g, "_")
          .replace(/[^A-Z0-9_]/g, "")
      : formData.name
          .toUpperCase()
          .replace(/\s+/g, "_")
          .replace(/[^A-Z0-9_]/g, "");

    if (!finalCode) {
      setError("Code is required.");
      return;
    }

    if (!formData.posCategoryName) {
      setError("POS Category Name is required.");
      return;
    }

    if (salePrice < 0) {
      setError("Sale Price cannot be negative.");
      return;
    }

    if ((formData.taxRate || 0) < 0) {
      setError("Tax Rate cannot be negative.");
      return;
    }

    if (!formData.itemType) {
      setError("Item Type is required.");
      return;
    }

    if (!formData.prepStation) {
      setError("Prep Station is required.");
      return;
    }

    if (
      formData.productionMode === "MADE_TO_ORDER" ||
      formData.productionMode === "ASSEMBLED_TO_ORDER"
    ) {
      if (bom.length === 0) {
        if (
          !window.confirm(
            `${formData.productionMode.replace(/_/g, " ")} item typically requires a BOM. Do you want to proceed without one?`,
          )
        ) {
          return;
        }
      }
    }

    let bomDataToSave = [...bom];
    if (
      formData.productionMode === "BOUGHT_AND_SOLD" ||
      formData.productionMode === "NO_STOCK"
    ) {
      bomDataToSave = [];
    } else if (bomDataToSave.length > 0) {
      const bomErrors = validateBOM(bomDataToSave, finalCode);
      if (bomErrors.length > 0) {
        setError(bomErrors[0]);
        return;
      }

      if (checkCircularParams(finalCode, bomDataToSave)) {
        setError("Circular dependency detected in BOM.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        name: formData.name,
        code: finalCode,
        displayName: formData.displayName || formData.name,
        description: formData.description || "",
        posCategoryCode:
          formData.posCategoryCode ||
          formData.posCategoryName.toUpperCase().replace(/\s+/g, "_"),
        posCategoryName: formData.posCategoryName,
        salePrice: salePrice,
        productionMode: formData.productionMode || "MADE_TO_ORDER",
        itemType: formData.itemType || "MADE_TO_ORDER",
        prepStation: formData.prepStation,
        taxRate: formData.taxRate || 0,
        bom: bomDataToSave,
        bomVersion: (item?.bomVersion || 0) + 1,
        recipeCost,
        grossMargin,
        cogsPercent,
        sortOrder: formData.sortOrder || 0,
        availableStoreIds: formData.availableStoreIds || [],
        isSellable: formData.isSellable ?? true,
        isAvailable: formData.isAvailable ?? true,
        isActive: formData.isActive ?? true,
        updatedAt: serverTimestamp(),
      };

      if (!item) {
        payload.createdAt = serverTimestamp();
      }

      // Remove undefined fields
      Object.keys(payload).forEach(
        (key) => payload[key] === undefined && delete payload[key],
      );

      await setDoc(doc(db, "finishedGoods", finalCode), payload, {
        merge: true,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <h2 className="text-xl font-bold text-neutral-800">
            {item ? "Edit Finished Good" : "New Finished Good"}
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-full transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 bg-white">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100 flex gap-3 items-start">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}

          <form id="fg-form" onSubmit={handleSave} className="space-y-8">
            <section>
              <h3 className="text-lg font-black text-neutral-800 mb-4">
                Basic Details
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                    placeholder="e.g. Hot Milk Coffee"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Code{" "}
                    <span className="text-neutral-400 font-normal">
                      (Auto-generated if empty)
                    </span>
                  </label>
                  <input
                    type="text"
                    name="code"
                    value={formData.code}
                    onChange={handleChange}
                    disabled={!!item}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] disabled:opacity-50"
                    placeholder="e.g. HOT_MILK_COFFEE"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Display Name
                  </label>
                  <input
                    type="text"
                    name="displayName"
                    value={formData.displayName}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    placeholder="e.g. Hot Latte"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    POS Category Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    name="posCategoryName"
                    value={formData.posCategoryName}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                    placeholder="e.g. Hot Coffee"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Description
                  </label>
                  <textarea
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] resize-none h-24"
                    placeholder="Optional description..."
                  />
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-lg font-black text-neutral-800 mb-4">
                Properties & Pricing
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Production Mode <span className="text-red-500">*</span>
                  </label>
                  <select
                    name="productionMode"
                    value={
                      formData.productionMode ||
                      (formData.itemType === "DIRECT_STOCK"
                        ? "BOUGHT_AND_SOLD"
                        : formData.itemType)
                    }
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  >
                    <option value="MADE_TO_ORDER">Made to Order</option>
                    <option value="ASSEMBLED_TO_ORDER">
                      Assembled to Order
                    </option>
                    <option value="BOUGHT_AND_SOLD">Bought & Sold</option>
                    <option value="NO_STOCK">No Stock</option>
                  </select>
                  <div className="mt-2 text-xs text-neutral-500">
                    {formData.productionMode === "MADE_TO_ORDER" &&
                      "Prepared directly from raw or prep components at order time. Example: Latte, Cloud Black."}
                    {formData.productionMode === "ASSEMBLED_TO_ORDER" &&
                      "Assembled from bought/prepped components at order time. Example: Pizza, Pasta, Zaffle, Salad."}
                    {formData.productionMode === "BOUGHT_AND_SOLD" &&
                      "Purchased as finished stock and sold directly. Example: Protein bar, ice cream, retail products."}
                    {formData.productionMode === "NO_STOCK" &&
                      "No inventory deduction required."}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Prep Station <span className="text-red-500">*</span>
                  </label>
                  <select
                    name="prepStation"
                    value={formData.prepStation}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  >
                    <option value="BARISTA">Barista</option>
                    <option value="KITCHEN">Kitchen</option>
                    <option value="BOTH">Both</option>
                    <option value="NONE">None</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Sale Price ($) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    name="salePrice"
                    value={formData.salePrice}
                    onChange={handleChange}
                    min="0"
                    step="0.01"
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Tax Rate (%)
                  </label>
                  <input
                    type="number"
                    name="taxRate"
                    value={formData.taxRate}
                    onChange={handleChange}
                    min="0"
                    step="0.01"
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-neutral-700 mb-2">
                    Sort Order
                  </label>
                  <input
                    type="number"
                    name="sortOrder"
                    value={formData.sortOrder}
                    onChange={handleChange}
                    className="w-full p-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                  />
                </div>
              </div>
            </section>

            {formData.itemType !== "NO_STOCK" && (
              <section>
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-black text-neutral-800">
                    {formData.productionMode === "ASSEMBLED_TO_ORDER"
                      ? "Assembly BOM"
                      : formData.productionMode === "BOUGHT_AND_SOLD"
                        ? "Direct Stock (No BOM Required)"
                        : "Recipe BOM"}
                  </h3>
                  {formData.productionMode !== "BOUGHT_AND_SOLD" && (
                    <button
                      type="button"
                      onClick={handleAddBomLine}
                      className="px-3 py-1.5 bg-[#5c4033]/10 text-[#5c4033] font-bold rounded-lg flex items-center gap-1.5 hover:bg-[#5c4033]/20 transition-colors text-sm"
                    >
                      <Plus size={16} /> Add Component
                    </button>
                  )}
                </div>

                {loadingLookups ? (
                  <div className="p-8 text-center text-neutral-400">
                    Loading components...
                  </div>
                ) : formData.productionMode === "BOUGHT_AND_SOLD" ? (
                  <div className="bg-neutral-50 border border-neutral-200 rounded-2xl overflow-hidden p-8 text-center text-neutral-500 font-medium">
                    Store Stock tracks physical inventory for this item. Selling
                    1 unit will decrement its stock by 1.
                  </div>
                ) : (
                  <div className="bg-neutral-50 border border-neutral-200 rounded-2xl overflow-hidden">
                    {bom.length === 0 ? (
                      <div className="p-8 text-center text-neutral-400 font-medium">
                        {formData.itemType === "DIRECT_STOCK"
                          ? "No BOM defined (1 unit deduction will apply)"
                          : "No components added to BOM yet."}
                      </div>
                    ) : (
                      <div className="overflow-x-auto w-full">
                        <table className="w-full text-left border-collapse min-w-[600px]">
                          <thead>
                            <tr className="bg-neutral-100 border-b border-neutral-200">
                              <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider">
                                Component
                              </th>
                              <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-32">
                                Quantity
                              </th>
                              <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-24">
                                UOM
                              </th>
                              <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider text-right w-32">
                                Line Cost
                              </th>
                              <th className="p-3 font-bold text-xs text-neutral-500 uppercase tracking-wider w-16"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100">
                            {bom.map((line, idx) => (
                              <tr key={idx} className="bg-white">
                                <td className="p-3">
                                  <select
                                    value={line.componentCode}
                                    onChange={(e) =>
                                      handleBomChange(
                                        idx,
                                        "componentCode",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full p-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                                    required
                                  >
                                    <option value="">
                                      Select a component...
                                    </option>
                                    {availableComponents.map((c) => (
                                      <option key={c.code} value={c.code}>
                                        {c.name} ({c.type.replace("_", " ")})
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="p-3">
                                  <input
                                    type="number"
                                    min="0.001"
                                    step="0.001"
                                    value={line.quantity || ""}
                                    onChange={(e) =>
                                      handleBomChange(
                                        idx,
                                        "quantity",
                                        parseFloat(e.target.value) || 0,
                                      )
                                    }
                                    className="w-full p-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033]"
                                    required
                                  />
                                </td>
                                <td className="p-3 text-sm font-medium text-neutral-600">
                                  {line.uom || "-"}
                                </td>
                                <td className="p-3 text-sm font-bold text-neutral-800 text-right">
                                  ${line.lineCost?.toFixed(4) || "0.0000"}
                                </td>
                                <td className="p-3 text-center">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveBomLine(idx)}
                                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            <section className="bg-neutral-50 p-6 rounded-2xl border border-neutral-200">
              <h3 className="text-lg font-black text-neutral-800 mb-4">
                Costing & Profitability
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">
                    Recipe Cost
                  </label>
                  <div className="text-xl font-bold text-neutral-800">
                    ${recipeCost.toFixed(4)}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">
                    Sale Price
                  </label>
                  <div className="text-xl font-bold text-neutral-800">
                    ${salePrice.toFixed(2)}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">
                    Gross Margin
                  </label>
                  <div
                    className={`text-xl font-bold ${grossMargin > 0 ? "text-emerald-600" : "text-red-500"}`}
                  >
                    ${grossMargin.toFixed(2)}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase mb-1">
                    COGS %
                  </label>
                  <div
                    className={`text-xl font-bold ${cogsPercent > 35 ? "text-amber-600" : "text-emerald-600"}`}
                  >
                    {cogsPercent.toFixed(1)}%
                  </div>
                </div>
              </div>
            </section>

            <section className="flex flex-wrap gap-8 pt-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="isSellable"
                  checked={formData.isSellable}
                  onChange={handleChange}
                  className="w-5 h-5 text-[#5c4033] rounded focus:ring-[#5c4033]"
                />
                <span className="font-bold text-sm text-neutral-700">
                  Sellable
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="isAvailable"
                  checked={formData.isAvailable}
                  onChange={handleChange}
                  className="w-5 h-5 text-[#5c4033] rounded focus:ring-[#5c4033]"
                />
                <span className="font-bold text-sm text-neutral-700">
                  Available
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="isActive"
                  checked={formData.isActive}
                  onChange={handleChange}
                  className="w-5 h-5 text-[#5c4033] rounded focus:ring-[#5c4033]"
                />
                <span className="font-bold text-sm text-neutral-700">
                  Active
                </span>
              </label>
            </section>
          </form>
        </div>

        <div className="p-6 border-t border-neutral-100 bg-neutral-50/50 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 font-bold text-neutral-600 bg-white border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="fg-form"
            disabled={submitting}
            className="px-6 py-2.5 font-bold text-white bg-[#5c4033] rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Save size={18} />
            )}
            {item ? "Save Changes" : "Create Finished Good"}
          </button>
        </div>
      </div>
    </div>
  );
}
