import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../lib/firebase';
import { collection, getDocs, doc, setDoc, writeBatch, serverTimestamp, query, where } from 'firebase/firestore';
import { Download, Upload, AlertCircle, Loader2, FileSpreadsheet, FileCheck2, FileSearch } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import * as XLSX from 'xlsx';

export default function DataManagement() {
  const { staffProfile } = useAuth();
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<{message: string, type: 'info'|'success'|'error', time: string}[]>([]);

  const addLog = (message: string, type: 'info'|'success'|'error' = 'info') => {
    setLogs(prev => [...prev, { message, type, time: new Date().toLocaleTimeString() }]);
  };

  const parseStoreIds = (value: any, fallbackStoreIds: string[]) => {
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
    if (typeof value === 'string' && value.trim() !== '') {
      return value.split(',').map(id => id.trim()).filter(Boolean);
    }
    return fallbackStoreIds;
  };

  const handleExportExcel = async () => {
    setIsRunning(true);
    setLogs([]);
    addLog('Starting Excel export...', 'info');

    try {
      const wb = XLSX.utils.book_new();

      // 1. Categories
      addLog('Fetching categories...', 'info');
      const catSnap = await getDocs(collection(db, 'categories'));
      const catData = catSnap.docs.map(d => ({
        code: d.data().code,
        name: d.data().name,
        index: d.data().index,
        isActive: d.data().isActive
      }));
      const catSheet = XLSX.utils.json_to_sheet(catData.length ? catData : [{ code: '', name: '', index: 0, isActive: true }]);
      XLSX.utils.book_append_sheet(wb, catSheet, 'Categories');

      // 2. Menu Items
      addLog('Fetching menu items...', 'info');
      const menuSnap = await getDocs(collection(db, 'menuItems'));
      const menuData = menuSnap.docs.map(d => ({
        code: d.data().code,
        name: d.data().name,
        categoryCode: d.data().categoryCode,
        price: d.data().price,
        prepStation: d.data().prepStation || 'NONE',
        isActive: d.data().isActive
      }));
      const menuSheet = XLSX.utils.json_to_sheet(menuData.length ? menuData : [{ code: '', name: '', categoryCode: '', price: 0, prepStation: 'NONE', isActive: true }]);
      XLSX.utils.book_append_sheet(wb, menuSheet, 'MenuItems');

      // 3. Global Inventory (inventoryItems)
      addLog('Fetching global inventory...', 'info');
      const invSnap = await getDocs(collection(db, 'inventoryItems'));
      const invData = invSnap.docs.map(d => ({
        code: d.data().code,
        name: d.data().name,
        category: d.data().category,
        unit: d.data().unit,
        defaultCost: d.data().defaultCost,
        isActive: d.data().isActive
      }));
      const invSheet = XLSX.utils.json_to_sheet(invData.length ? invData : [{ code: '', name: '', category: '', unit: '', defaultCost: 0, isActive: true }]);
      XLSX.utils.book_append_sheet(wb, invSheet, 'GlobalInventory');

      // 4. Store Inventory
      addLog('Fetching store inventory...', 'info');
      const storeInvSnap = await getDocs(collection(db, 'storeInventory'));
      const storeInvData = storeInvSnap.docs.map(d => ({
        storeId: d.data().storeId,
        inventoryItemCode: d.data().inventoryItemCode,
        currentStock: d.data().currentStock,
        minimumStock: d.data().minimumStock
      }));
      const storeInvSheet = XLSX.utils.json_to_sheet(storeInvData.length ? storeInvData : [{ storeId: '', inventoryItemCode: '', currentStock: 0, minimumStock: 0 }]);
      XLSX.utils.book_append_sheet(wb, storeInvSheet, 'StoreInventory');

      // 5. Recipes
      addLog('Fetching recipes...', 'info');
      const recSnap = await getDocs(collection(db, 'recipes'));
      
      const recData: any[] = [];
      const recLinesData: any[] = [];
      
      recSnap.docs.forEach(d => {
        const r = d.data();
        recData.push({
          code: r.code,
          menuItemCode: r.menuItemCode,
          menuItemName: r.menuItemName,
          station: r.station,
          isActive: r.isActive
        });
        if (Array.isArray(r.recipeItems)) {
          r.recipeItems.forEach((ri: any) => {
            recLinesData.push({
              recipeCode: r.code,
              inventoryItemCode: ri.inventoryItemCode,
              inventoryItemName: ri.inventoryItemName,
              quantity: ri.quantity,
              unit: ri.unit
            });
          });
        }
      });

      const recSheet = XLSX.utils.json_to_sheet(recData.length ? recData : [{ code: '', menuItemCode: '', menuItemName: '', station: '', isActive: true }]);
      XLSX.utils.book_append_sheet(wb, recSheet, 'Recipes');

      const recLinesSheet = XLSX.utils.json_to_sheet(recLinesData.length ? recLinesData : [{ recipeCode: '', inventoryItemCode: '', inventoryItemName: '', quantity: 0, unit: '' }]);
      XLSX.utils.book_append_sheet(wb, recLinesSheet, 'RecipeLines');

      XLSX.writeFile(wb, 'POS_Data_Export.xlsx');
      addLog('Export completed.', 'success');
    } catch (e: any) {
      addLog(`Export failed: ${e.message}`, 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const handleImportExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (staffProfile?.role !== 'ADMIN') {
      addLog('Unauthorized: Admin access required', 'error');
      return;
    }

    if (!window.confirm(`Import Excel data\n\nThis will merge spreadsheet rows into Firestore collections. New menu items without availableStoreIds will be assigned to all active stores so they are visible in POS.\n\nContinue?`)) {
      e.target.value = '';
      return;
    }

    setIsRunning(true);
    setLogs([]);
    addLog(`Reading file ${file.name}...`, 'info');

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const activeStoresSnap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        const defaultStoreIds = activeStoresSnap.docs.map(docSnap => docSnap.id);

        const processSheet = async (sheetName: string, collectionName: string, idField: string | ((row: any) => string), processRow?: (row: any) => any) => {
          if (!wb.SheetNames.includes(sheetName)) {
            addLog(`Sheet ${sheetName} not found. Skipping.`, 'info');
            return;
          }
          addLog(`Processing ${sheetName}...`, 'info');
          const sheet = wb.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(sheet);
          
          let count = 0;
          for (const row of data as any[]) {
            const docId = typeof idField === 'function' ? idField(row) : row[idField];
            if (!docId) continue;
            
            try {
              const payload = processRow ? processRow(row) : row;
              payload.updatedAt = serverTimestamp();
              if (payload.createdAt === undefined) payload.createdAt = serverTimestamp();
              
              await setDoc(doc(db, collectionName, docId), payload, { merge: true });
              count++;
            } catch (err: any) {
              addLog(`Error saving ${docId} to ${collectionName}: ${err.message}`, 'error');
            }
          }
          addLog(`Successfully processed ${count} rows from ${sheetName}.`, 'success');
        };

        // 1. Categories
        await processSheet('Categories', 'categories', 'code', (row) => ({
          code: row.code,
          name: row.name || '',
          index: parseInt(row.index, 10) || 999,
          isActive: row.isActive !== false && row.isActive !== 'FALSE' && row.isActive !== 'false'
        }));

        // 2. Menu Items
        await processSheet('MenuItems', 'menuItems', 'code', (row) => ({
          code: row.code,
          name: row.name || '',
          categoryCode: row.categoryCode || 'UNCATEGORISED',
          price: parseFloat(row.price) || 0,
          prepStation: row.prepStation || 'NONE',
          availableStoreIds: parseStoreIds(row.availableStoreIds, defaultStoreIds),
          isActive: row.isActive !== false && row.isActive !== 'FALSE' && row.isActive !== 'false'
        }));

        // 3. Global Inventory
        await processSheet('GlobalInventory', 'inventoryItems', 'code', (row) => ({
          code: row.code,
          name: row.name || '',
          category: row.category || 'OTHER',
          unit: row.unit || 'pcs',
          defaultCost: parseFloat(row.defaultCost) || 0,
          isActive: row.isActive !== false && row.isActive !== 'FALSE' && row.isActive !== 'false'
        }));

        // 4. Store Inventory
        await processSheet('StoreInventory', 'storeInventory', (row) => {
          if (!row.storeId || !row.inventoryItemCode) return '';
          return `${row.storeId}_${row.inventoryItemCode}`;
        }, (row) => ({
          storeId: row.storeId,
          inventoryItemId: row.inventoryItemCode,
          inventoryItemCode: row.inventoryItemCode,
          currentStock: parseFloat(row.currentStock) || 0,
          minimumStock: parseFloat(row.minimumStock) || 0
        }));

        // 5. Recipes (more complex because it has recipe lines)
        if (wb.SheetNames.includes('Recipes') && wb.SheetNames.includes('RecipeLines')) {
          addLog('Processing Recipes and RecipeLines...', 'info');
          const recipesSheet = XLSX.utils.sheet_to_json(wb.Sheets['Recipes']) as any[];
          const linesSheet = XLSX.utils.sheet_to_json(wb.Sheets['RecipeLines']) as any[];
          
          const linesByRecipe: Record<string, any[]> = {};
          linesSheet.forEach(l => {
            const rCode = l.recipeCode;
            if (!rCode) return;
            if (!linesByRecipe[rCode]) linesByRecipe[rCode] = [];
            linesByRecipe[rCode].push({
              inventoryItemCode: l.inventoryItemCode,
              inventoryItemName: l.inventoryItemName,
              quantity: parseFloat(l.quantity) || 0,
              unit: l.unit
            });
          });

          let rCount = 0;
          for (const r of recipesSheet) {
            if (!r.code) continue;
            try {
              const payload = {
                code: r.code,
                menuItemCode: r.menuItemCode || '',
                menuItemName: r.menuItemName || '',
                station: r.station || 'NONE',
                isActive: r.isActive !== false && r.isActive !== 'FALSE' && r.isActive !== 'false',
                recipeItems: linesByRecipe[r.code] || [],
                updatedAt: serverTimestamp(),
                createdAt: serverTimestamp() // if merge=true and missing, won't overwrite existing
              };
              await setDoc(doc(db, 'recipes', r.code), payload, { merge: true });
              rCount++;
            } catch (err: any) {
              addLog(`Error saving recipe ${r.code}: ${err.message}`, 'error');
            }
          }
          addLog(`Successfully processed ${rCount} recipes with their lines.`, 'success');
        }

        addLog('Excel import completed.', 'success');
      } catch (e: any) {
        addLog(`Import failed: ${e.message}`, 'error');
      } finally {
        setIsRunning(false);
      }
    };
    reader.onerror = (e) => {
      addLog('Failed to read file', 'error');
      setIsRunning(false);
    };
    reader.readAsBinaryString(file);
    
    // reset input so we can upload the same file again if needed
    e.target.value = '';
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link to="/admin/phase-7a-validation" className="block bg-amber-50 border border-amber-200 rounded-2xl p-5 hover:border-amber-400 transition-colors">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-white text-amber-700 rounded-xl flex items-center justify-center border border-amber-200 shrink-0">
              <FileCheck2 size={22} />
            </div>
            <div>
              <h2 className="text-lg font-black text-amber-900">Phase 7A Validation</h2>
              <p className="text-sm text-amber-800 mt-1">
                Run the Coffee Bond menu, inventory, and BOM preflight before importing any production data.
              </p>
            </div>
          </div>
        </Link>

        <Link to="/admin/phase-7f-dry-run-import" className="block bg-red-50 border border-red-200 rounded-2xl p-5 hover:border-red-400 transition-colors">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-white text-red-700 rounded-xl flex items-center justify-center border border-red-200 shrink-0">
              <FileSearch size={22} />
            </div>
            <div>
              <h2 className="text-lg font-black text-red-900">Phase 7F Dry-Run Import</h2>
              <p className="text-sm text-red-800 mt-1">
                Compare final import payloads against Firestore with no writes, no imports, and no rollout switch.
              </p>
            </div>
          </div>
        </Link>

        <Link to="/admin/phase-7h-stock-costing" className="block bg-amber-50 border border-amber-200 rounded-2xl p-5 hover:border-amber-400 transition-colors">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-white text-amber-700 rounded-xl flex items-center justify-center border border-amber-200 shrink-0">
              <FileSpreadsheet size={22} />
            </div>
            <div>
              <h2 className="text-lg font-black text-amber-900">Phase 7H Stock + Costing</h2>
              <p className="text-sm text-amber-800 mt-1">
                Export, validate, and upload raw ingredient costs and opening stock before any Finished Goods rollout.
              </p>
            </div>
          </div>
        </Link>

        <Link to="/admin/phase-7i-bom-alias-correction" className="block bg-amber-50 border border-amber-200 rounded-2xl p-5 hover:border-amber-400 transition-colors">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 bg-white text-amber-700 rounded-xl flex items-center justify-center border border-amber-200 shrink-0">
              <FileSearch size={22} />
            </div>
            <div>
              <h2 className="text-lg font-black text-amber-900">Phase 7I BOM Alias Correction</h2>
              <p className="text-sm text-amber-800 mt-1">
                Dry-run and guarded correction for V2 BOM alias component codes before Finished Goods pilot readiness.
              </p>
            </div>
          </div>
        </Link>
      </div>

      <div className="bg-white p-8 rounded-2xl shadow-sm border border-neutral-200">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center">
            <FileSpreadsheet size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-neutral-800">Excel Import / Export</h2>
            <p className="text-sm font-medium text-neutral-500">Download Excel templates or upload data</p>
          </div>
        </div>

        <div className="bg-blue-50 text-blue-800 p-4 rounded-xl flex gap-3 text-sm mb-6 border border-blue-200">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold mb-1">How to use this tool</p>
            <p className="opacity-90">Click <strong>Export to Excel</strong> to download the current database structure as a template with data. You can edit this file and import it back. The import process will merge data based on the unique code.</p>
          </div>
        </div>
        
        <div className="flex flex-col md:flex-row gap-4 mb-6 pb-6 border-b border-neutral-200">
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={isRunning}
            className="flex-1 py-3 px-4 bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-bold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed border border-indigo-300"
          >
            {isRunning ? (
              <><Loader2 size={18} className="animate-spin" /> Exporting...</>
            ) : (
              <><Download size={18} /> Export Data to Excel</>
            )}
          </button>
          
          <div className="flex-1 relative">
            <input
              type="file"
              accept=".xlsx, .xls"
              onChange={handleImportExcel}
              disabled={isRunning}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
            />
            <div className={`w-full py-3 px-4 flex items-center justify-center gap-2 font-bold rounded-xl transition-colors border ${isRunning ? 'bg-neutral-100 text-neutral-400 border-neutral-200' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border-emerald-300'}`}>
              {isRunning ? (
                <><Loader2 size={18} className="animate-spin" /> Importing...</>
              ) : (
                <><Upload size={18} /> Import from Excel</>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold">Execution Logs</h3>
          <button
            type="button"
            onClick={() => setLogs([])}
            disabled={isRunning || logs.length === 0}
            className="px-4 py-1.5 border border-neutral-300 text-neutral-600 font-bold rounded-xl transition-colors hover:bg-neutral-50 text-xs disabled:opacity-50"
          >
             Clear Logs
          </button>
        </div>

        <div className="bg-neutral-900 flex flex-col-reverse text-neutral-300 font-mono text-xs p-4 rounded-xl h-[400px] overflow-y-auto space-y-1.5 space-y-reverse custom-scrollbar">
          {logs.slice().reverse().map((log, i) => (
            <div key={i} className="flex gap-2 shrink-0">
              <span className="opacity-50 min-w-max">[{log.time}]</span>
              <span className={`
                ${log.type === 'success' ? 'text-green-400' : ''}
                ${log.type === 'error' ? 'text-red-400' : ''}
              `}>
                {log.message}
              </span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="opacity-50 text-center py-4">Waiting for process...</div>
          )}
        </div>
      </div>
    </div>
  );
}
