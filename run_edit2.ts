import fs from 'fs';

let content = fs.readFileSync('frontend/pages/admin/MenuImport.tsx', 'utf8');

const oldExecuteBatch = `  const executeBatchWithProgress = async (writes: any[], stageName: string) => {
    if (writes.length === 0) return;
    setCurrentStage(stageName);
    console.log('[MENU IMPORT] Stage:', stageName);
    setProgress({ current: 0, total: writes.length });
    
    const BATCH_SIZE = 300;
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
      const chunk = writes.slice(i, i + BATCH_SIZE);
      const b = writeBatch(db);
      
      chunk.forEach(op => {
         const sanitizedData = sanitizeFirestoreData(op.data);
         b.set(op.ref, sanitizedData, { merge: op.merge });
      });
      
      try {
        const commitPromise = b.commit();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout at stage: ' + stageName)), 60000));
        await Promise.race([commitPromise, timeoutPromise]);
      } catch(batchErr) {
         console.error('Batch write failed at stage ' + stageName, batchErr);
         throw { 
           errorInfo: batchErr, 
           stageName, 
           failedChunkStart: i 
         };
      }
      setProgress({ current: Math.min(i + BATCH_SIZE, writes.length), total: writes.length });
    }
    console.log('[MENU IMPORT] Stage complete:', stageName);
  };`;

const newExecuteBatch = `  const executeBatchWithProgress = async (writes: any[], stageName: string) => {
    if (writes.length === 0) return;
    setCurrentStage(stageName);
    console.log('[MENU IMPORT] Stage:', stageName);
    setProgress({ current: 0, total: writes.length });
    
    const BATCH_SIZE = 300;
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
      const chunk = writes.slice(i, i + BATCH_SIZE);
      const b = writeBatch(db);
      
      chunk.forEach(op => {
         const sanitizedData = sanitizeFirestoreData(op.data);
         b.set(op.ref, sanitizedData, { merge: op.merge });
      });
      
      try {
        await b.commit();
      } catch(batchErr) {
         console.error('Batch write failed at stage ' + stageName, batchErr);
         throw { 
           errorInfo: batchErr, 
           stageName, 
           failedChunkStart: i 
         };
      }
      setProgress({ current: Math.min(i + BATCH_SIZE, writes.length), total: writes.length });
    }
    console.log('[MENU IMPORT] Stage complete:', stageName);
  };
  
  const handleTestWrite = async () => {
    try {
      if (!firebaseUser) throw new Error("No user");
      await setDoc(doc(db, 'importDiagnostics', 'latest'), {
        status: "started",
        uid: firebaseUser.uid,
        role: staffProfile?.role || 'unknown',
        startedAt: serverTimestamp()
      });
      alert('Firestore write test successful!');
    } catch (e: any) {
      console.error(e);
      alert('Firestore write test failed: ' + (e.message || JSON.stringify(e)));
    }
  };`;

content = content.replace(oldExecuteBatch, newExecuteBatch);


const oldImportCat = `      // 1. Categories
      const catWrites: any[] = [];
      cats.forEach((c) => {
        if (!c.categoryCode || !c.categoryName) {
           console.log('[MENU IMPORT] Skipped invalid row in categories:', c.categoryCode);
           setSkippedRows(prev => [...prev, { collection: 'categories', document: c.categoryCode || 'Unknown', field: 'categoryCode/categoryName', action: 'blocked' }]);
           return;
        }
        catWrites.push({
          ref: doc(db, 'categories', c.categoryCode),
          data: {
            code: c.categoryCode,
            name: c.categoryName,
            index: parseInt(c.index, 10) || 999,
            sortOrder: parseInt(c.index, 10) || 999,
            defaultPrepStation: 'NONE',
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          },
          merge: true
        });
      });
      await executeBatchWithProgress(catWrites, 'Importing categories');`;

const newImportCat = `      try {
        await setDoc(doc(db, 'importDiagnostics', 'latest'), {
          status: "started",
          uid: firebaseUser?.uid || 'unknown',
          role: staffProfile?.role || 'unknown',
          startedAt: serverTimestamp()
        });
      } catch (e: any) {
        throw {
          errorInfo: e,
          stageName: "Preparing import (Firestore write preflight failed)",
          failedChunkStart: 0
        };
      }

      // 1. Categories
      setCurrentStage('Importing categories');
      setProgress({ current: 0, total: cats.length });
      let catsImported = 0;
      for (const c of cats) {
        if (!c.categoryCode || !c.categoryName) {
           console.log('[MENU IMPORT] Skipped invalid row in categories:', c.categoryCode);
           setSkippedRows(prev => [...prev, { collection: 'categories', document: c.categoryCode || 'Unknown', field: 'categoryCode/categoryName', action: 'blocked' }]);
           continue;
        }
        try {
          console.log(\`[MENU IMPORT] Writing category: \${c.categoryCode}\`);
          const data = sanitizeFirestoreData({
            code: c.categoryCode,
            name: c.categoryName,
            index: parseInt(c.index, 10) || 999,
            sortOrder: parseInt(c.index, 10) || 999,
            defaultPrepStation: 'NONE',
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          await setDoc(doc(db, 'categories', c.categoryCode), data, { merge: true });
          console.log(\`[MENU IMPORT] Category written: \${c.categoryCode}\`);
          catsImported++;
          setProgress({ current: catsImported, total: cats.length });
        } catch (catErr: any) {
          console.error(\`[MENU IMPORT] Category failed: \${c.categoryCode}\`, catErr);
          throw {
            errorInfo: catErr,
            stageName: "categories",
            collectionName: "categories",
            documentCode: c.categoryCode,
            failedChunkStart: catsImported
          };
        }
      }
      console.log('[MENU IMPORT] Stage complete: Importing categories');`;

content = content.replace(oldImportCat, newImportCat);


const oldButtons = `          <div className="flex gap-3 mt-6">
            <button 
              onClick={handleConfirmImport} 
              disabled={isImporting}
              className={\`flex-1 py-3 rounded-xl font-bold flex items-center justify-center transition-colors \${isImporting ? 'bg-neutral-200 text-neutral-400 cursor-not-allowed' : 'bg-[#5c4033] hover:bg-[#3e2723] text-white'}\`}
            >
              {isImporting && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
              {isImporting ? 'Importing...' : 'Confirm Import'}
            </button>
            {(currentStage || errorDetails || success) && (
              <button 
                onClick={handleResetImport} 
                className="px-6 py-3 rounded-xl font-bold border border-neutral-300 text-neutral-600 hover:bg-neutral-50 transition-colors"
                title="Reset Import State"
              >
                Reset
              </button>
            )}
          </div>`;

const newButtons = `          <div className="flex flex-col gap-3 mt-6">
            <div className="flex gap-3 w-full">
              <button 
                onClick={handleConfirmImport} 
                disabled={isImporting}
                className={\`flex-1 py-3 rounded-xl font-bold flex items-center justify-center transition-colors \${isImporting ? 'bg-neutral-200 text-neutral-400 cursor-not-allowed' : 'bg-[#5c4033] hover:bg-[#3e2723] text-white'}\`}
              >
                {isImporting && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
                {isImporting ? 'Importing...' : 'Confirm Import'}
              </button>
              <button 
                onClick={handleResetImport} 
                className="px-6 py-3 rounded-xl font-bold border border-neutral-300 text-neutral-600 hover:bg-neutral-50 transition-colors"
                title="Reset Import State"
              >
                Reset
              </button>
            </div>
            
            <button 
              onClick={handleTestWrite} 
              className="py-2 px-4 rounded-lg font-bold border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors text-sm"
            >
              Test Firestore Write
            </button>
          </div>`;

content = content.replace(oldButtons, newButtons);

const oldCurrentStageCond = `            {(currentStage || errorDetails || success) && (`;
const newCurrentStageCond = `            {true && (`;
content = content.replace(oldCurrentStageCond, newCurrentStageCond);

fs.writeFileSync('frontend/pages/admin/MenuImport.tsx', content);
