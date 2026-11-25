import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  where,
  getDocs,
  setDoc,
  serverTimestamp,
  doc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../../../lib/firebase";
import {
  FinishedGood,
  RawIngredient,
  PrepItem,
} from "../../../types/menu-management";
import { Store } from "../../../types";
import {
  Edit2,
  Loader2,
  PackageSearch,
  Search,
  DatabaseZap,
  Utensils,
} from "lucide-react";
import FinishedGoodModal from "./FinishedGoodModal";
import { useAuth } from "../../../contexts/AuthContext";
import {
  shouldShowNeedsClassificationBadge,
  type PosMenuCategoryDefinition,
} from "../../../lib/posMenuNavigation";
import {
  assessPosClassificationRecovery,
  assertPosVisibilityRepairPatch,
  planPosVisibilityRepair,
} from "../../../lib/posVisibilityRepair";

function formatRepairValue(value: unknown): string {
  if (value === undefined) return "Missing";
  if (value === null) return "Null";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "No stores";
  return String(value);
}

function parseCSV(text: string) {
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += c;
    }
  }
  if (
    currentCell ||
    currentRow.length > 0 ||
    text.endsWith(",") ||
    text.endsWith("\n")
  ) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }
  return rows;
}

interface Props {
  posMenuCategories: PosMenuCategoryDefinition[];
}

export default function FinishedGoodsTab({ posMenuCategories }: Props) {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === "ADMIN" && staffProfile?.isActive !== false;

  const [items, setItems] = useState<FinishedGood[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<FinishedGood | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [productionModeFilter, setProductionModeFilter] = useState("");
  const [isSeeding, setIsSeeding] = useState(false);
  const [repairInspectionItems, setRepairInspectionItems] = useState<
    Array<Record<string, unknown>> | null
  >(null);
  const [includeExplicitActivation, setIncludeExplicitActivation] =
    useState(false);
  const [repairError, setRepairError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stores, setStores] = useState<Store[]>([]);
  const repairStoreIds = useMemo(
    () =>
      stores
        .filter((store) => store.isActive !== false)
        .map((store) => store.id),
    [stores],
  );

  const repairPreviewPlans = useMemo(
    () =>
      (repairInspectionItems || []).map((item) =>
        planPosVisibilityRepair(
          item,
          repairStoreIds,
          posMenuCategories,
          { includeExplicitActivation },
        ),
      ),
    [
      includeExplicitActivation,
      posMenuCategories,
      repairInspectionItems,
      repairStoreIds,
    ],
  );

  const visibilityIssuePlans = useMemo(
    () =>
      items
        .map((item) =>
          planPosVisibilityRepair(
            item as unknown as Record<string, unknown>,
            repairStoreIds,
            posMenuCategories,
          ),
        )
        .filter(
          (plan) =>
            plan.changes.length > 0 || plan.visibilityWarnings.length > 0,
        ),
    [items, posMenuCategories, repairStoreIds],
  );

  const classificationRecovery = useMemo(
    () =>
      items
        .map((item) =>
          assessPosClassificationRecovery(
            item as unknown as Record<string, unknown>,
            posMenuCategories,
          ),
        )
        .filter((entry) => entry !== null),
    [items, posMenuCategories],
  );

  useEffect(() => {
    const fetchStores = async () => {
      const snap = await getDocs(collection(db, "stores"));
      setStores(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Store));
    };
    fetchStores();
  }, []);

  const [importPreview, setImportPreview] = useState<{
    total: number;
    valid: number;
    invalid: number;
    invalidRows: { row: number; code: string; name: string; error: string }[];
    itemsToImport: any[];
  } | null>(null);

  useEffect(() => {
    const q = query(collection(db, "finishedGoods"), orderBy("name", "asc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setItems(
        snapshot.docs.map(
          (doc) => ({ ...doc.data(), id: doc.id }) as FinishedGood,
        ),
      );
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleEdit = (item: FinishedGood) => {
    if (!isAdmin) return;
    setEditingItem(item);
    setIsModalOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const csv = event.target?.result as string;
        console.log("[FG IMPORT] CSV selected");
        await processCSV(csv);
      } catch (err) {
        console.error(err);
        alert("Failed to parse CSV");
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset
  };

  const processCSV = async (csvStr: string) => {
    const rows = parseCSV(csvStr);
    if (rows.length < 2) {
      alert("CSV is empty or missing data rows");
      return;
    }

    console.log(`[FG IMPORT] Parsed ${rows.length - 1} rows`);

    const headers = rows[0].map((h: string | undefined) => (h ? h.trim() : ""));
    const requiredHeaders = [
      "fgCode",
      "fgName",
      "posCategoryCode",
      "posCategoryName",
      "salePrice",
      "itemType",
      "prepStation",
    ];
    const missingHeaders = requiredHeaders.filter((h) => !headers.includes(h));

    if (missingHeaders.length > 0) {
      alert(`CSV headers missing: ${missingHeaders.join(", ")}`);
      return;
    }

    setIsSeeding(true); // show loading state while fetching dependencies
    let rawIngredients: RawIngredient[] = [];
    let prepItems: PrepItem[] = [];
    let existingFGs: FinishedGood[] = [];
    try {
      const [rawSnap, prepSnap, fgSnap] = await Promise.all([
        getDocs(query(collection(db, "rawIngredients"))),
        getDocs(query(collection(db, "prepItems"))),
        getDocs(query(collection(db, "finishedGoods"))),
      ]);
      rawIngredients = rawSnap.docs.map(
        (d) => ({ ...d.data(), id: d.id }) as RawIngredient,
      );
      prepItems = prepSnap.docs.map(
        (d) => ({ ...d.data(), id: d.id }) as PrepItem,
      );
      existingFGs = fgSnap.docs.map(
        (d) => ({ ...d.data(), id: d.id }) as FinishedGood,
      );
    } catch (err) {
      console.error("Error fetching dependencies for import", err);
      alert("Failed to fetch dependencies for import.");
      setIsSeeding(false);
      return;
    }
    setIsSeeding(false);

    const getComponentCost = (type: string, code: string) => {
      if (type === "RAW_INGREDIENT") {
        const raw = rawIngredients.find((r) => r.code === code);
        return raw ? raw.costPerUsageUnit || 0 : 0;
      }
      if (type === "PREP_ITEM") {
        const prep = prepItems.find((p) => p.code === code);
        return prep ? prep.costPerUnit || 0 : 0;
      }
      if (type === "FINISHED_GOOD") {
        const fg = existingFGs.find((f) => f.code === code);
        return fg ? fg.recipeCost || 0 : 0;
      }
      return 0;
    };

    const validRows: any[] = [];
    const invalidRows: any[] = [];

    const itemsMap = new Map<string, any>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length === 1 && (!row[0] || !row[0].trim())) continue;

      const obj: any = {};
      headers.forEach((h: string, idx: number) => {
        obj[h] = row[idx]?.trim() || "";
      });

      const code = obj.fgCode;
      const name = obj.fgName;

      if (!code) {
        invalidRows.push({
          row: i + 1,
          code: "N/A",
          name: name || "N/A",
          error: "fgCode required",
        });
        continue;
      }
      if (!name) {
        invalidRows.push({
          row: i + 1,
          code,
          name: "N/A",
          error: "fgName required",
        });
        continue;
      }

      const snakeCaseRegex = /^[A-Z0-9_]+$/;
      if (!snakeCaseRegex.test(code)) {
        invalidRows.push({
          row: i + 1,
          code,
          name,
          error: "fgCode must be uppercase snake case",
        });
        continue;
      }

      if (!obj.posCategoryCode) {
        invalidRows.push({
          row: i + 1,
          code,
          name,
          error: "posCategoryCode required",
        });
        continue;
      }

      if (!obj.posCategoryName) {
        invalidRows.push({
          row: i + 1,
          code,
          name,
          error: "posCategoryName required",
        });
        continue;
      }

      const salePrice = Number(obj.salePrice);
      if (isNaN(salePrice) || salePrice < 0) {
        invalidRows.push({
          row: i + 1,
          code,
          name,
          error: "salePrice >= 0 required",
        });
        continue;
      }

      const validItemTypes = ["MADE_TO_ORDER", "DIRECT_STOCK", "NO_STOCK"];
      let itemType = obj.itemType?.toUpperCase();
      if (!validItemTypes.includes(itemType)) {
        itemType = "NO_STOCK";
      }

      const validPrepStations = ["BARISTA", "KITCHEN", "BOTH", "NONE"];
      let prepStation = obj.prepStation?.toUpperCase();
      if (!validPrepStations.includes(prepStation)) {
        prepStation = "NONE";
      }

      let taxRate = Number(obj.taxRate);
      if (isNaN(taxRate)) taxRate = 5;

      let isSellable = true;
      if (obj.isSellable !== undefined && obj.isSellable !== "") {
        const lower = String(obj.isSellable).toLowerCase();
        if (["false", "no", "0"].includes(lower)) isSellable = false;
      }

      let isActive = true;
      if (obj.isActive !== undefined && obj.isActive !== "") {
        const lower = String(obj.isActive).toLowerCase();
        if (["false", "no", "0"].includes(lower)) isActive = false;
      }

      let isAvailable = true;
      if (obj.isAvailable !== undefined && obj.isAvailable !== "") {
        const lower = String(obj.isAvailable).toLowerCase();
        if (["false", "no", "0"].includes(lower)) isAvailable = false;
      }

      let availableStoreIds: string[] = [];
      const allStoreIds = stores.map((s) => s.id);
      const rawStoreIds = obj.availableStoreIds
        ? String(obj.availableStoreIds).trim()
        : "";
      if (!rawStoreIds || rawStoreIds.toUpperCase() === "ALL") {
        availableStoreIds = [...allStoreIds];
      } else {
        availableStoreIds = rawStoreIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const sortOrder = obj.sortOrder ? Number(obj.sortOrder) : 999;

      if (!itemsMap.has(code)) {
        itemsMap.set(code, {
          code,
          name,
          displayName: obj.displayName || name,
          description: obj.description || "",
          posCategoryCode:
            obj.posCategoryCode || name.substring(0, 3).toUpperCase(),
          posCategoryName: obj.posCategoryName || "Uncategorized",
          salePrice: isNaN(salePrice) ? 0 : salePrice,
          itemType,
          prepStation,
          taxRate,
          isSellable,
          isActive,
          isAvailable,
          availableStoreIds,
          bom: [],
          bomVersion: 1,
          recipeCost: 0,
          grossMargin: 100,
          cogsPercent: 0,
          sortOrder,
        });
      }

      const item = itemsMap.get(code);

      // Add BOM Component if exists
      const bomComponentType = obj.bomComponentType?.toUpperCase();
      const bomComponentCode = obj.bomComponentCode;

      if (bomComponentType && bomComponentCode) {
        if (
          ![
            "RAW",
            "RAW_INGREDIENT",
            "PREP",
            "PREP_ITEM",
            "PACKAGING",
            "FINISHED_GOOD",
          ].includes(bomComponentType)
        ) {
          invalidRows.push({
            row: i + 1,
            code,
            name,
            error: "bomComponentType invalid",
          });
          continue;
        }

        let componentTypeNormalized = bomComponentType;
        if (bomComponentType === "RAW")
          componentTypeNormalized = "RAW_INGREDIENT";
        if (bomComponentType === "PREP") componentTypeNormalized = "PREP_ITEM";

        const bName = obj.bomComponentName || bomComponentCode;
        const bQty = Number(obj.bomQuantity);
        if (isNaN(bQty) || bQty <= 0) {
          invalidRows.push({
            row: i + 1,
            code,
            name,
            error: "bomQuantity > 0 required",
          });
          continue;
        }

        const bUOM = obj.bomUOM;
        if (!bUOM) {
          invalidRows.push({
            row: i + 1,
            code,
            name,
            error: "bomUOM required",
          });
          continue;
        }

        const unitCost =
          Math.round(
            (getComponentCost(componentTypeNormalized, bomComponentCode) +
              Number.EPSILON) *
              10000,
          ) / 10000;
        const lineCost =
          Math.round((unitCost * bQty + Number.EPSILON) * 10000) / 10000;

        item.bom.push({
          componentType: componentTypeNormalized,
          componentCode: bomComponentCode,
          componentName: bName,
          quantity: bQty,
          uom: bUOM,
          costPerUnit: unitCost,
          lineCost: lineCost,
        });
      }
    }

    const itemsToImport = Array.from(itemsMap.values()).map((fg: any) => {
      let recipeCost = 0;
      fg.bom.forEach((b: any) => {
        recipeCost += b.lineCost;
      });
      recipeCost = Math.round((recipeCost + Number.EPSILON) * 100) / 100;

      let grossMargin = 100;
      let cogsPercent = 0;
      if (fg.salePrice > 0) {
        const netPrice = fg.salePrice / (1 + fg.taxRate / 100);
        const gp = netPrice - recipeCost;
        grossMargin = Math.round((gp / netPrice) * 10000) / 100;
        cogsPercent = Math.round((recipeCost / netPrice) * 10000) / 100;
      }

      return {
        ...fg,
        recipeCost,
        grossMargin,
        cogsPercent,
      };
    });
    const totalErrors = invalidRows.length;

    console.log(`[FG IMPORT] Valid items: ${itemsToImport.length}`);
    console.log(`[FG IMPORT] Invalid rows: ${totalErrors}`);

    setImportPreview({
      total: rows.length - 1,
      valid: itemsToImport.length,
      invalid: totalErrors,
      invalidRows,
      itemsToImport,
    });
  };

  const executeImport = async () => {
    if (!isAdmin || !importPreview) return;
    setIsSeeding(true);

    try {
      const chunks = [];
      for (let i = 0; i < importPreview.itemsToImport.length; i += 300) {
        chunks.push(importPreview.itemsToImport.slice(i, i + 300));
      }

      for (const chunk of chunks) {
        const batch = writeBatch(db);
        for (const item of chunk) {
          console.log(`[FG IMPORT] Importing row ${item.code}`);
          const ref = doc(db, "finishedGoods", item.code);
          batch.set(
            ref,
            {
              ...item,
              updatedAt: serverTimestamp(),
              createdAt: serverTimestamp(), // merge will keep original if exists
            },
            { merge: true },
          );
        }
        await batch.commit();
      }

      console.log(`[FG IMPORT] Import complete`);
      alert(`Imported ${importPreview.valid} menu items successfully.`);
      setImportPreview(null);
    } catch (err: any) {
      console.error("Import failed:", err);
      alert(
        `Import Failed\nCode: ${err.code || "UNKNOWN"}\nMessage: ${err.message || err.toString()}\nCollection: finishedGoods\nRole: ${staffProfile?.role}\nUID: ${staffProfile?.uid}`,
      );
    } finally {
      setIsSeeding(false);
    }
  };

  const handleRepair = async () => {
    if (!isAdmin) return;
    setIsSeeding(true);
    setRepairError("");
    try {
      const fgSnap = await getDocs(query(collection(db, "finishedGoods")));
      setRepairInspectionItems(
        fgSnap.docs.map((snapshot) => ({
          ...snapshot.data(),
          id: snapshot.id,
        })),
      );
      setIncludeExplicitActivation(false);
    } catch (err: any) {
      console.error("Visibility repair inspection failed", err);
      setRepairError(`Inspection failed: ${err.message}`);
    } finally {
      setIsSeeding(false);
    }
  };

  const executeVisibilityRepair = async () => {
    if (!isAdmin || !repairInspectionItems) return;
    const plansWithChanges = repairPreviewPlans.filter(
      (plan) => plan.changes.length > 0,
    );
    setRepairError("");

    try {
      // Validate every plan before constructing or committing any write batch.
      for (const plan of plansWithChanges) {
        if (!plan.documentId) {
          throw new Error(`Missing document ID for ${plan.productCode || plan.productName}`);
        }
        assertPosVisibilityRepairPatch(plan.patch);
      }
    } catch (err: any) {
      console.error("Visibility repair protected-field guard blocked all writes", err);
      setRepairError(err.message);
      return;
    }

    if (plansWithChanges.length === 0) {
      setRepairError("No approved visibility changes are proposed.");
      return;
    }

    const includesActivation = plansWithChanges.some((plan) =>
      plan.changes.some((change) => change.requiresExplicitActivation),
    );
    const confirmed = window.confirm(
      `${includesActivation ? "This will explicitly activate visibility for selected disabled or unassigned items. " : ""}`
        + `Apply ${plansWithChanges.length} visibility-only repair(s)? `
        + "POS category and subcategory placement will not be changed.",
    );
    if (!confirmed) return;

    setIsSeeding(true);
    try {
      for (let index = 0; index < plansWithChanges.length; index += 300) {
        const batch = writeBatch(db);
        for (const plan of plansWithChanges.slice(index, index + 300)) {
          assertPosVisibilityRepairPatch(plan.patch);
          batch.update(
            doc(db, "finishedGoods", plan.documentId),
            plan.patch,
          );
        }
        await batch.commit();
      }
      alert(`Repaired visibility fields for ${plansWithChanges.length} item(s).`);
      setRepairInspectionItems(null);
      setIncludeExplicitActivation(false);
    } catch (err: any) {
      console.error("Visibility repair failed", err);
      setRepairError(`Repair failed: ${err.message}`);
    } finally {
      setIsSeeding(false);
    }
  };

  const handleAddNew = () => {
    if (!isAdmin) return;
    setEditingItem(null);
    setIsModalOpen(true);
  };

  const seedFinishedGoods = async () => {
    if (!isAdmin) return;
    setIsSeeding(true);
    try {
      const rawQuery = query(collection(db, "rawIngredients"));
      const rawSnap = await getDocs(rawQuery);
      const rawIngredients = rawSnap.docs.map(
        (d) => ({ ...d.data(), id: d.id }) as RawIngredient,
      );

      const prepQuery = query(collection(db, "prepItems"));
      const prepSnap = await getDocs(prepQuery);
      const prepItems = prepSnap.docs.map(
        (d) => ({ ...d.data(), id: d.id }) as PrepItem,
      );

      const getRaw = (code: string) =>
        rawIngredients.find((r) => r.code === code);
      const getPrep = (code: string) => prepItems.find((p) => p.code === code);

      const beans = getRaw("ROASTED_COFFEE_BEANS");
      const milk = getRaw("FRESH_MILK");
      const cup = getRaw("PAPER_CUP_8OZ");
      const lid = getRaw("LID_8OZ");
      const coldFoam = getPrep("COLD_FOAM");

      if (!beans || !milk || !cup || !lid) {
        alert(
          "Please ensure ROASTED_COFFEE_BEANS, FRESH_MILK, PAPER_CUP_8OZ, and LID_8OZ are seeded first.",
        );
        setIsSeeding(false);
        return;
      }

      if (!coldFoam) {
        alert(
          "Cannot seed Cloud Black because COLD_FOAM prep item is missing.",
        );
        setIsSeeding(false);
        return;
      }

      const seedData: Partial<FinishedGood>[] = [
        {
          code: "HOT_MILK_COFFEE",
          name: "Hot Milk Coffee",
          displayName: "Hot White",
          posCategoryCode: "HOT_COFFEE",
          posCategoryName: "Hot Coffee",
          salePrice: 180,
          itemType: "MADE_TO_ORDER",
          prepStation: "BARISTA",
          taxRate: 0,
          bom: [
            {
              componentType: "RAW_INGREDIENT",
              componentCode: "ROASTED_COFFEE_BEANS",
              componentName: beans.name,
              quantity: 18,
              uom: beans.usageUOM,
              costPerUnit: beans.costPerUsageUnit,
              lineCost: 18 * beans.costPerUsageUnit,
            },
            {
              componentType: "RAW_INGREDIENT",
              componentCode: "FRESH_MILK",
              componentName: milk.name,
              quantity: 180,
              uom: milk.usageUOM,
              costPerUnit: milk.costPerUsageUnit,
              lineCost: 180 * milk.costPerUsageUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "PAPER_CUP_8OZ",
              componentName: cup.name,
              quantity: 1,
              uom: cup.usageUOM,
              costPerUnit: cup.costPerUsageUnit,
              lineCost: 1 * cup.costPerUsageUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "LID_8OZ",
              componentName: lid.name,
              quantity: 1,
              uom: lid.usageUOM,
              costPerUnit: lid.costPerUsageUnit,
              lineCost: 1 * lid.costPerUsageUnit,
            },
          ],
        },
        {
          code: "AMERICANO",
          name: "Americano",
          displayName: "Long Black",
          posCategoryCode: "HOT_COFFEE",
          posCategoryName: "Hot Coffee",
          salePrice: 160,
          itemType: "MADE_TO_ORDER",
          prepStation: "BARISTA",
          taxRate: 0,
          bom: [
            {
              componentType: "RAW_INGREDIENT",
              componentCode: "ROASTED_COFFEE_BEANS",
              componentName: beans.name,
              quantity: 18,
              uom: beans.usageUOM,
              costPerUnit: beans.costPerUsageUnit,
              lineCost: 18 * beans.costPerUsageUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "PAPER_CUP_8OZ",
              componentName: cup.name,
              quantity: 1,
              uom: cup.usageUOM,
              costPerUnit: cup.costPerUsageUnit,
              lineCost: 1 * cup.costPerUsageUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "LID_8OZ",
              componentName: lid.name,
              quantity: 1,
              uom: lid.usageUOM,
              costPerUnit: lid.costPerUsageUnit,
              lineCost: 1 * lid.costPerUsageUnit,
            },
          ],
        },
        {
          code: "CLOUD_BLACK",
          name: "Cloud Black",
          displayName: "Cloud Black",
          posCategoryCode: "COLD_COFFEE",
          posCategoryName: "Cold Coffee",
          salePrice: 260,
          itemType: "MADE_TO_ORDER",
          prepStation: "BARISTA",
          taxRate: 0,
          bom: [
            {
              componentType: "RAW_INGREDIENT",
              componentCode: "ROASTED_COFFEE_BEANS",
              componentName: beans.name,
              quantity: 18,
              uom: beans.usageUOM,
              costPerUnit: beans.costPerUsageUnit,
              lineCost: 18 * beans.costPerUsageUnit,
            },
            {
              componentType: "PREP_ITEM",
              componentCode: "COLD_FOAM",
              componentName: coldFoam.name,
              quantity: 30,
              uom: coldFoam.outputUOM,
              costPerUnit: coldFoam.costPerUnit,
              lineCost: 30 * coldFoam.costPerUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "PAPER_CUP_8OZ",
              componentName: cup.name,
              quantity: 1,
              uom: cup.usageUOM,
              costPerUnit: cup.costPerUsageUnit,
              lineCost: 1 * cup.costPerUsageUnit,
            },
            {
              componentType: "PACKAGING",
              componentCode: "LID_8OZ",
              componentName: lid.name,
              quantity: 1,
              uom: lid.usageUOM,
              costPerUnit: lid.costPerUsageUnit,
              lineCost: 1 * lid.costPerUsageUnit,
            },
          ],
        },
        {
          code: "DOUBLE_CHOCOLATE_COOKIE",
          name: "Double Chocolate Cookie",
          displayName: "DC Cookie",
          posCategoryCode: "COOKIES",
          posCategoryName: "Cookies",
          salePrice: 160,
          itemType: "DIRECT_STOCK",
          prepStation: "KITCHEN",
          taxRate: 0,
          bom: [],
        },
        {
          code: "HOUSE_BLEND_BEANS_250G",
          name: "House Blend Beans 250g",
          displayName: "House Blend Beans",
          posCategoryCode: "RETAIL_COFFEE",
          posCategoryName: "Retail Coffee",
          salePrice: 650,
          itemType: "DIRECT_STOCK",
          prepStation: "NONE",
          taxRate: 0,
          bom: [],
        },
      ];

      for (const item of seedData) {
        const recipeCost = item.bom
          ? item.bom.reduce((sum, line) => sum + (line.lineCost || 0), 0)
          : 0;
        const grossMargin = (item.salePrice || 0) - recipeCost;
        const cogsPercent =
          (item.salePrice || 0) > 0
            ? (recipeCost / (item.salePrice || 1)) * 100
            : 0;

        await setDoc(
          doc(db, "finishedGoods", item.code!),
          {
            ...item,
            bomVersion: 1,
            recipeCost,
            grossMargin,
            cogsPercent,
            sortOrder: 0,
            availableStoreIds: [],
            isSellable: true,
            isAvailable: true,
            isActive: true,
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          },
          { merge: true },
        );
      }
    } catch (err) {
      console.error("Failed to seed:", err);
      alert("Failed to seed finished goods.");
    } finally {
      setIsSeeding(false);
    }
  };

  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.posCategoryName))),
    [items],
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.posCategoryName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = categoryFilter
        ? item.posCategoryName === categoryFilter
        : true;
      const matchesType = typeFilter ? item.itemType === typeFilter : true;
      const matchesProductionMode = productionModeFilter
        ? item.productionMode === productionModeFilter
        : true;
      return (
        matchesSearch && matchesCategory && matchesType && matchesProductionMode
      );
    });
  }, [items, searchTerm, categoryFilter, typeFilter, productionModeFilter]);

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#5c4033]" />
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-full">
      <div className="flex flex-col gap-4 mb-6 w-full min-w-0">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 w-full">
          <h3 className="text-lg font-bold text-neutral-800 flex items-center gap-2 shrink-0">
            <Utensils size={20} className="text-[#5c4033]" /> Sellable Items
          </h3>

          <div className="flex flex-wrap items-center justify-start xl:justify-end gap-3 min-w-0 w-full">
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto shrink-0">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] text-sm font-medium text-neutral-600 w-full lg:w-auto"
              >
                <option value="">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={productionModeFilter}
                onChange={(e) => setProductionModeFilter(e.target.value)}
                className="px-3 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] text-sm font-medium text-neutral-600 w-full lg:w-auto"
              >
                <option value="">All Production Modes</option>
                <option value="MADE_TO_ORDER">Made to Order</option>
                <option value="ASSEMBLED_TO_ORDER">Assembled to Order</option>
                <option value="BOUGHT_AND_SOLD">Bought & Sold</option>
                <option value="NO_STOCK">No Stock</option>
              </select>
            </div>

            <div className="relative w-full lg:w-auto">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
                size={18}
              />
              <input
                type="text"
                placeholder="Search items..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 border border-neutral-200 rounded-xl bg-white focus:ring-2 focus:ring-[#5c4033] focus:border-[#5c4033] w-full lg:min-w-[200px]"
              />
            </div>

            {isAdmin && (
              <>
                <input
                  type="file"
                  accept=".csv"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  onClick={() => {
                    const csv = `fgCode,fgName,posCategoryCode,posCategoryName,salePrice,itemType,prepStation,taxRate,isSellable,isActive,bomComponentType,bomComponentCode,bomComponentName,bomQuantity,bomUOM
HOT_MILK_COFFEE,Hot Milk Coffee,HOT_COFFEE,Hot Coffee,180,MADE_TO_ORDER,BARISTA,0,TRUE,TRUE,RAW,ROASTED_COFFEE_BEANS,Roasted Coffee Beans,18,g
HOT_MILK_COFFEE,Hot Milk Coffee,HOT_COFFEE,Hot Coffee,180,MADE_TO_ORDER,BARISTA,0,TRUE,TRUE,RAW,FRESH_MILK,Fresh Milk,180,ml
HOT_MILK_COFFEE,Hot Milk Coffee,HOT_COFFEE,Hot Coffee,180,MADE_TO_ORDER,BARISTA,0,TRUE,TRUE,PACKAGING,PAPER_CUP_8OZ,Paper Cup 8oz,1,pcs
HOT_MILK_COFFEE,Hot Milk Coffee,HOT_COFFEE,Hot Coffee,180,MADE_TO_ORDER,BARISTA,0,TRUE,TRUE,PACKAGING,LID_8OZ,Lid 8oz,1,pcs
AMERICANO,Americano,HOT_COFFEE,Hot Coffee,160,MADE_TO_ORDER,BARISTA,0,TRUE,TRUE,RAW,ROASTED_COFFEE_BEANS,Roasted Coffee Beans,18,g
COLD_FOAM,Cold Foam,ADDON,Addon,50,NO_STOCK,BARISTA,0,TRUE,TRUE,PREP,COLD_FOAM_BATCH,Cold Foam Batch,60,g`;
                    const blob = new Blob([csv], {
                      type: "text/csv;charset=utf-8;",
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "Menu_Items_BOM_Import_Template.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="w-full lg:w-auto px-4 py-2 bg-neutral-100 text-neutral-800 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-neutral-200 transition-colors text-sm border border-neutral-300 whitespace-nowrap"
                >
                  Download CSV Template
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSeeding || !!importPreview}
                  className="w-full lg:w-auto px-4 py-2 bg-amber-100 text-amber-800 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-amber-200 transition-colors text-sm border border-amber-300 whitespace-nowrap disabled:opacity-50"
                >
                  {isSeeding ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <DatabaseZap size={16} />
                  )}
                  Import CSV
                </button>
                <button
                  onClick={handleAddNew}
                  className="w-full lg:w-auto px-4 py-2 bg-[#5c4033] text-white font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-[#3e2723] transition-colors text-sm whitespace-nowrap"
                >
                  Create New
                </button>
                <button
                  onClick={handleRepair}
                  disabled={isSeeding}
                  className="w-full lg:w-auto px-4 py-2 bg-blue-100 text-blue-800 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-blue-200 transition-colors text-sm whitespace-nowrap disabled:opacity-50"
                >
                  {isSeeding ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  Repair POS Visibility
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {repairError && !repairInspectionItems && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
          {repairError}
        </div>
      )}

      {visibilityIssuePlans.length > 0 && (
        <div className="mb-6 w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-blue-200 bg-blue-50">
          <div className="border-b border-blue-200 bg-blue-100/50 p-4">
            <h4 className="font-bold text-blue-900">VISIBILITY ISSUE</h4>
            <p className="text-sm text-blue-800">
              Review POS eligibility fields below. Repair first shows a preview;
              disabled states are warnings unless an Admin explicitly includes
              activation. POS category and subcategory placement will not be
              changed.
            </p>
          </div>
          <div className="w-full overflow-x-auto p-4">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="text-blue-800">
                  <th className="pb-2 font-bold">Item Name</th>
                  <th className="pb-2 font-bold">Code</th>
                  <th className="pb-2 font-bold">Visibility Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-blue-200/50">
                {visibilityIssuePlans.map((plan) => (
                  <tr key={plan.documentId || plan.productCode}>
                    <td className="py-2 font-medium text-blue-900">
                      {plan.productName}
                    </td>
                    <td className="py-2 font-mono text-xs text-blue-800">
                      {plan.productCode}
                    </td>
                    <td className="py-2 font-medium text-blue-900">
                      {[
                        ...plan.changes.map((change) => change.reason),
                        ...plan.visibilityWarnings,
                      ].join(" ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {classificationRecovery.length > 0 && (
        <div className="mb-6 w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-amber-200 bg-amber-50">
          <div className="border-b border-amber-200 bg-amber-100/50 p-4">
            <h4 className="font-bold text-amber-900">
              NEEDS CLASSIFICATION ({classificationRecovery.length})
            </h4>
            <p className="text-sm font-medium text-amber-800">
              Assign a POS Category in the item editor. Visibility repair does
              not classify products. Recovery suggestions below are read-only
              and never use product-name inference.
            </p>
          </div>
          <div className="w-full overflow-x-auto p-4">
            <table className="w-full min-w-[1500px] text-left text-xs">
              <thead>
                <tr className="text-amber-800">
                  <th className="pb-2 pr-4 font-bold">Document ID</th>
                  <th className="pb-2 pr-4 font-bold">Code / Name</th>
                  <th className="pb-2 pr-4 font-bold">Current POS Category</th>
                  <th className="pb-2 pr-4 font-bold">Current POS Subcategory</th>
                  <th className="pb-2 pr-4 font-bold">Legacy Category</th>
                  <th className="pb-2 pr-4 font-bold">Proposed Recovery</th>
                  <th className="pb-2 pr-4 font-bold">Confidence</th>
                  <th className="pb-2 font-bold">Assessment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-200/50">
                {classificationRecovery.map((entry) => (
                  <tr key={entry.documentId || entry.productCode}>
                    <td className="py-2 pr-4 font-mono text-amber-900">
                      {entry.documentId || "—"}
                    </td>
                    <td className="py-2 pr-4 text-amber-900">
                      <span className="block font-mono font-bold">
                        {entry.productCode || "—"}
                      </span>
                      <span>{entry.productName || "—"}</span>
                    </td>
                    <td className="py-2 pr-4 text-amber-900">
                      {entry.currentPosCategoryCode || "—"} / {entry.currentPosCategoryName || "—"}
                    </td>
                    <td className="py-2 pr-4 text-amber-900">
                      {entry.currentPosSubcategoryCode || "—"} / {entry.currentPosSubcategoryName || "—"}
                    </td>
                    <td className="py-2 pr-4 text-amber-900">
                      {entry.legacyCategoryCode || "—"} / {entry.legacyCategory || "—"}
                    </td>
                    <td className="py-2 pr-4 text-amber-900">
                      {entry.proposedCategoryCode || "—"} / {entry.proposedCategoryName || "—"}
                      <br />
                      {entry.proposedSubcategoryCode || "—"} / {entry.proposedSubcategoryName || "—"}
                    </td>
                    <td className="py-2 pr-4 font-black text-amber-900">
                      {entry.confidence}
                    </td>
                    <td className="py-2 text-amber-900">{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 bg-neutral-50 border border-dashed border-neutral-300 rounded-2xl">
          <PackageSearch size={48} className="mb-4 opacity-30 text-[#5c4033]" />
          <p className="font-bold text-lg text-neutral-600 mb-2">
            No sellable items found
          </p>
          <p className="text-sm max-w-md text-center">
            {items.length === 0
              ? "Add your first Finished Good to make it available for sale."
              : "No items match your search filters."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full min-w-0 max-w-full">
          {filteredItems.map((item) => (
            <div
              key={item.code}
              className="bg-white border border-neutral-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col"
            >
              <div className="flex justify-between items-start mb-4 gap-4">
                <div className="min-w-0 flex-1">
                  <h4 className="font-bold text-neutral-800 text-lg truncate">
                    {item.name}
                  </h4>
                  <p className="text-xs text-neutral-500 font-mono truncate mt-0.5">
                    {item.code}
                  </p>
                  {shouldShowNeedsClassificationBadge(item, posMenuCategories) && (
                    <span className="mt-2 inline-flex rounded-md bg-amber-100 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-amber-800">
                      Needs Classification
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <button
                    onClick={() => handleEdit(item)}
                    className="p-2 -mt-1 -mr-2 text-neutral-400 hover:text-[#5c4033] hover:bg-neutral-100 rounded-xl transition-colors shrink-0"
                  >
                    <Edit2 size={16} />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-y-3 gap-x-4 mb-4 text-sm bg-neutral-50/50 rounded-xl p-3 border border-neutral-100">
                <div>
                  <span className="text-xs font-bold text-neutral-400 block uppercase tracking-wider mb-1">
                    Category
                  </span>
                  <span className="font-bold text-neutral-700">
                    {item.posCategoryName}
                  </span>
                </div>
                <div>
                  <span className="text-xs font-bold text-neutral-400 block uppercase tracking-wider mb-1">
                    Mode / Station
                  </span>
                  <div className="font-semibold text-neutral-700 leading-tight">
                    {item.productionMode === "MADE_TO_ORDER"
                      ? "Made to Order"
                      : item.productionMode === "ASSEMBLED_TO_ORDER"
                        ? "Assembled"
                        : item.productionMode === "BOUGHT_AND_SOLD"
                          ? "Bought & Sold"
                          : item.productionMode === "NO_STOCK"
                            ? "No Stock"
                            : item.itemType === "DIRECT_STOCK"
                              ? "Bought & Sold"
                              : item.itemType.replace(/_/g, " ")}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {item.prepStation}
                  </div>
                </div>
                <div className="col-span-2 pt-2 border-t border-neutral-200">
                  <span className="text-xs font-bold text-neutral-400 block uppercase tracking-wider mb-1">
                    Sale Price
                  </span>
                  <span className="font-black text-[#5c4033] text-xl">
                    ${item.salePrice?.toFixed(2)}
                  </span>
                </div>
                <div className="col-span-2 pt-2 border-t border-neutral-200">
                  <span className="text-xs font-bold text-neutral-400 block uppercase tracking-wider mb-1">
                    Stock Strategy
                  </span>
                  <span className="font-bold text-neutral-700">
                    {item.productionMode === "ASSEMBLED_TO_ORDER"
                      ? "Assembly BOM"
                      : item.productionMode === "MADE_TO_ORDER"
                        ? "Recipe BOM"
                        : item.productionMode === "BOUGHT_AND_SOLD"
                          ? "Direct Stock"
                          : item.productionMode === "NO_STOCK"
                            ? "No Stock Deduction"
                            : "Recipe BOM"}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-4 mt-auto">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-neutral-400 uppercase tracking-wider">
                    Cost & Margin
                  </span>
                  <span className="font-bold text-neutral-700 text-sm">
                    Cost: ${item.recipeCost?.toFixed(4) || "0.0000"}
                  </span>
                  <span className="text-sm">
                    <span
                      className={`font-bold ${item.cogsPercent > 35 ? "text-amber-600" : "text-emerald-600"}`}
                    >
                      {item.cogsPercent?.toFixed(1)}% COGS
                    </span>
                    <span className="text-neutral-500 font-medium ml-2 border-l border-neutral-300 pl-2">
                      Margin: ${item.grossMargin?.toFixed(2)}
                    </span>
                  </span>
                </div>

                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${item.isSellable ? "bg-indigo-100 text-indigo-800" : "bg-neutral-100 text-neutral-500"}`}
                  >
                    {item.isSellable ? "Sellable" : "Hidden"}
                  </span>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${item.isAvailable ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}
                  >
                    {item.isAvailable ? "Available" : "Out of Stock"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {repairInspectionItems && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-black text-neutral-900">
              POS Visibility Repair Preview
            </h2>
            <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-black text-emerald-900">
              POS category and subcategory placement will not be changed.
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              This preview is inspection-only. No Firestore write occurs until
              you press Confirm visibility repair and accept the final
              confirmation.
            </p>

            <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <input
                type="checkbox"
                checked={includeExplicitActivation}
                onChange={(event) =>
                  setIncludeExplicitActivation(event.target.checked)
                }
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="block font-bold text-amber-900">
                  Explicitly include activation and missing store assignment
                </span>
                <span className="text-sm text-amber-800">
                  Off by default. When enabled, inactive, non-sellable,
                  unavailable, or unassigned items may be proposed as active and
                  assigned to all active configured stores. Review every row
                  before confirming.
                </span>
              </span>
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                <div className="text-xs font-bold uppercase text-blue-700">
                  Items with proposed changes
                </div>
                <div className="text-2xl font-black text-blue-900">
                  {
                    repairPreviewPlans.filter((plan) => plan.changes.length > 0)
                      .length
                  }
                </div>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs font-bold uppercase text-amber-700">
                  Items requiring review
                </div>
                <div className="text-2xl font-black text-amber-900">
                  {
                    repairPreviewPlans.filter(
                      (plan) => plan.visibilityWarnings.length > 0,
                    ).length
                  }
                </div>
              </div>
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <div className="text-xs font-bold uppercase text-neutral-600">
                  Needs Classification (not repaired)
                </div>
                <div className="text-2xl font-black text-neutral-900">
                  {
                    repairPreviewPlans.filter((plan) => plan.needsClassification)
                      .length
                  }
                </div>
              </div>
            </div>

            {repairError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
                {repairError}
              </div>
            )}

            <div className="mt-5 w-full overflow-x-auto rounded-xl border border-neutral-200">
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead className="border-b border-neutral-200 bg-neutral-50 text-neutral-700">
                  <tr>
                    <th className="p-3 font-bold">Item Name</th>
                    <th className="p-3 font-bold">Code</th>
                    <th className="p-3 font-bold">Visibility Field</th>
                    <th className="p-3 font-bold">Current</th>
                    <th className="p-3 font-bold">Proposed</th>
                    <th className="p-3 font-bold">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {repairPreviewPlans.flatMap((plan) =>
                    plan.changes.map((change) => (
                      <tr key={`${plan.documentId}-${change.field}`}>
                        <td className="p-3 font-medium text-neutral-900">
                          {plan.productName}
                        </td>
                        <td className="p-3 font-mono text-xs text-neutral-700">
                          {plan.productCode}
                        </td>
                        <td className="p-3 font-mono text-xs font-bold text-blue-800">
                          {change.field}
                        </td>
                        <td className="p-3 text-neutral-700">
                          {formatRepairValue(change.currentValue)}
                        </td>
                        <td className="p-3 font-bold text-emerald-800">
                          {formatRepairValue(change.proposedValue)}
                        </td>
                        <td className="p-3 text-neutral-700">
                          {change.reason}
                        </td>
                      </tr>
                    )),
                  )}
                  {repairPreviewPlans.every(
                    (plan) => plan.changes.length === 0,
                  ) && (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-neutral-500">
                        No approved visibility changes are proposed.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {repairPreviewPlans.some(
              (plan) => plan.visibilityWarnings.length > 0,
            ) && (
              <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <h3 className="font-black text-amber-900">
                  Visibility warnings (not silently changed)
                </h3>
                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-amber-900">
                  {repairPreviewPlans.flatMap((plan) =>
                    plan.visibilityWarnings.map((warning, index) => (
                      <li key={`${plan.documentId}-warning-${index}`}>
                        <strong>{plan.productCode || plan.productName}:</strong>{" "}
                        {warning}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            )}

            {repairPreviewPlans.some((plan) => plan.needsClassification) && (
              <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <h3 className="font-black">NEEDS CLASSIFICATION</h3>
                <p>
                  These items remain outside classification repair. Assign a POS
                  Category in the item editor.
                </p>
                <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
                  {repairPreviewPlans
                    .filter((plan) => plan.needsClassification)
                    .map((plan) => (
                      <li key={`${plan.documentId}-classification`}>
                        <strong>{plan.productCode || plan.productName}:</strong>{" "}
                        {plan.classificationReason || "Invalid POS placement"}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <div className="mt-6 flex flex-col-reverse justify-end gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  setRepairInspectionItems(null);
                  setIncludeExplicitActivation(false);
                  setRepairError("");
                }}
                disabled={isSeeding}
                className="rounded-xl bg-neutral-100 px-6 py-2 font-bold text-neutral-700 hover:bg-neutral-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeVisibilityRepair}
                disabled={
                  isSeeding ||
                  repairPreviewPlans.every((plan) => plan.changes.length === 0)
                }
                className="flex items-center justify-center gap-2 rounded-xl bg-blue-700 px-6 py-2 font-bold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {isSeeding ? <Loader2 size={16} className="animate-spin" /> : null}
                Confirm visibility repair
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <FinishedGoodModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          item={editingItem}
          posMenuCategories={posMenuCategories}
        />
      )}

      {importPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl p-6 shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-black text-neutral-900 mb-4">
              Import Preview
            </h2>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-200">
                <div className="text-xs text-neutral-500 uppercase font-bold">
                  Total Rows Parsed
                </div>
                <div className="text-2xl font-black text-neutral-800">
                  {importPreview.total}
                </div>
              </div>
              <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200">
                <div className="text-xs text-emerald-800 uppercase font-bold">
                  Valid Menu Items
                </div>
                <div className="text-2xl font-black text-emerald-600">
                  {importPreview.valid}
                </div>
              </div>
              <div className="bg-red-50 p-4 rounded-xl border border-red-200">
                <div className="text-xs text-red-800 uppercase font-bold">
                  Invalid Rows (Skipped)
                </div>
                <div className="text-2xl font-black text-red-600">
                  {importPreview.invalid}
                </div>
              </div>
            </div>

            {importPreview.invalidRows.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-bold text-red-800 mb-2">
                  Invalid Rows
                </h3>
                <div className="w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-red-200">
                  <div className="w-full overflow-x-auto">
                    <table className="w-full text-left text-sm min-w-[600px]">
                      <thead className="bg-red-50 text-red-800 border-b border-red-200">
                        <tr>
                          <th className="p-3 font-bold">Row</th>
                          <th className="p-3 font-bold">Code</th>
                          <th className="p-3 font-bold">Name</th>
                          <th className="p-3 font-bold">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100">
                        {importPreview.invalidRows.map((ir, idx) => (
                          <tr key={idx} className="bg-white">
                            <td className="p-3">{ir.row}</td>
                            <td className="p-3 font-mono text-xs">{ir.code}</td>
                            <td className="p-3">{ir.name}</td>
                            <td className="p-3 text-red-600 font-medium">
                              {ir.error}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-end mt-8">
              <button
                onClick={() => setImportPreview(null)}
                disabled={isSeeding}
                className="px-6 py-2 bg-neutral-100 text-neutral-700 font-bold rounded-xl hover:bg-neutral-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeImport}
                disabled={isSeeding || importPreview.valid === 0}
                className="px-6 py-2 bg-[#5c4033] text-white font-bold rounded-xl hover:bg-[#3e2723] transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isSeeding ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : null}
                Confirm Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
