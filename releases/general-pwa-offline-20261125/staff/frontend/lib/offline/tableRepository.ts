import { tableTotals, tableLineTotals } from '../tables/domain';
import type { TableDraftLine } from '../tables/drafts';
import { SECTOR51_TABLE_STORE, validPosStoreId } from '../tables/api';
import type { Entry, Snapshot } from './journal';

export const isTableStep = (entry: Entry) => ['TABLE_OPEN','TABLE_ROUND','TABLE_CASH'].includes(entry.payload.kind);
export const isCashEntry = (entry: Entry) => entry.payload.paymentMethod === 'CASH';

export function supportedOfflineSnapshot(snapshot?:Snapshot|null) {
  return !!snapshot && validPosStoreId(snapshot.storeId) && (snapshot.offlinePolicyVersion===2 || snapshot.storeId===SECTOR51_TABLE_STORE);
}

export function hasTableAuthority(snapshot?: Snapshot | null) {
  return !!snapshot && snapshot.tableWorkflowVersion === 1 && snapshot.tableBoard?.complete === true
    && Array.isArray(snapshot.tableBoard.tables) && Array.isArray(snapshot.tableSessions)
    && snapshot.tableOwnership?.deviceId === snapshot.deviceId && snapshot.tableOwnership?.storeId === snapshot.storeId;
}

export function approvedRoundLines(snapshot: Snapshot, draft: TableDraftLine[], roundId: string) {
  if (!draft.length || draft.length > 30 || new Set(draft.map(line => line.orderItemId)).size !== draft.length) {
    throw Error('A round needs 1–30 distinct item lines.');
  }
  return draft.map(line => {
    const item = snapshot.menu.find(p => p.id === line.parentProductId);
    const canonical = item?.canonical;
    if (!canonical || !line.orderItemId || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) {
      throw Error('This round contains an item or quantity outside the approved offline menu.');
    }
    if (line.selectedAddOns?.length || canonical.addOns?.length || item.request?.selectedAddOns?.length) {
      throw Error('This item needs its online options. Its selections and draft have been kept.');
    }
    const saved = {id:line.orderItemId, roundId, parentProductId:item.id, itemName:item.name,
      itemCode:canonical.parentProductCode || item.request?.parentProductCode || line.parentProductCode,
      baseUnitPrice:canonical.baseUnitPrice, taxRate:canonical.taxRate, addOns:[], quantity:line.quantity,
      prepStation:canonical.prepStation || item.printTasks?.[0]?.station || '', cancelled:false};
    if (!Number.isFinite(saved.baseUnitPrice) || !Number.isFinite(saved.taxRate)) throw Error('Missing approved price or GST for ' + item.name);
    return {...saved, ...tableLineTotals(saved,0)};
  });
}

function sessionView(snapshot: Snapshot, value:any) {
  const lines = value.lines || [];
  const cash = value.localCash;
  const totals = cash?.totals || tableTotals(lines,0);
  const order = {id:value.orderId,storeId:snapshot.storeId,storeName:snapshot.storeName,tableSessionId:value.id,tableNumber:value.tableLabel,
    orderNumber:value.orderNumber || value.saved?.order?.orderNumber || value.orderId, orderType:'DINE_IN',
    createdAt:value.openedAt,receiptLegalDetails:value.legal || snapshot.legal,gstTreatmentSnapshot:value.gst || snapshot.gst,
    commercialStatus:'SALE',...totals, paymentStatus:cash ? 'PAID' : 'UNPAID',paymentMethod:cash ? 'CASH':'PAY_AT_COUNTER'};
  return {...value, storeId:snapshot.storeId,lines,rounds:value.rounds || [],kitchen:[],kitchenUnavailable:true,
    saved:value.orderId ? {order,items:lines.filter((l:any)=>!l.cancelled),payments:cash?[{method:'CASH',amount:cash.totals.grandTotal}]:[]} : null};
}

/** Rebuild the visible board from a single signed board plus immutable local operations. */
export function projectTables(snapshot: Snapshot | null, entries: Entry[]) {
  if (!hasTableAuthority(snapshot) || !snapshot) return null;
  const sessions = new Map<string,any>();
  const slots = new Map<string,any>(snapshot.tableBoard.tables.map((t:any) => [t.tableId,{...t,id:t.tableId}]));
  for (const item of snapshot.tableSessions || []) sessions.set(item.id,sessionView(snapshot,item));
  const rows = entries.filter(e => e.payload.storeId === snapshot.storeId && e.payload.deviceId === snapshot.deviceId && isTableStep(e))
    .sort((a,b)=>a.payload.createdAt-b.payload.createdAt || a.payload.table.version-b.payload.table.version);
  for (const entry of rows) {
    const p=entry.payload, ref=p.table;
    const slot=slots.get(ref.tableId);
    if(!slot) continue;
    let current=sessions.get(ref.id);
    // A fresh board may already reflect an older, fully synchronized operation.
    if(entry.status==='SYNCED' && (current?.version > ref.version ||
      (!current && entry.payload.snapshotId!==snapshot.id && entry.payload.createdAt<=snapshot.issuedAt))) continue;
    if(entry.status==='CONFLICT'){slot.localConflict=true;if(current)current.localConflict=true;}
    if((current && current.version!==ref.version)
       || (slot.activeSessionId && slot.activeSessionId!==ref.id)) {
      slot.localConflict=true;
      if(current) current.localConflict=true;
      continue;
    }
    if(p.kind==='TABLE_OPEN'){
      if(ref.version!==0 || current || slot.activeSessionId){slot.localConflict=true;continue;}
      current={id:ref.id,tableId:slot.tableId,tableLabel:slot.label,orderId:null,lines:[],rounds:[],openedAt:p.createdAt,
        outstanding:0,total:0,guestCount:p.guestCount,offlineEligible:true,status:'OCCUPIED'};
    }
    if(!current){slot.localConflict=true;continue;}
    if(p.kind==='TABLE_ROUND'){
      const lines=[...current.lines,...p.roundLines];
      const amount=(tableTotals(lines,0) as Record<string,number>).grandTotal;
      current={...current,orderId:ref.orderId,lines,rounds:[...current.rounds,{id:p.id,sentAt:p.createdAt}],
        total:amount,outstanding:amount,status:'OCCUPIED'};
    }
    if(p.kind==='TABLE_CASH'){
      current={...current,localCash:p,status:'PAID_AWAITING_CLEAR',total:p.totals.grandTotal,outstanding:0,offlineEligible:false};
    }
    current={...current,version:ref.version+1,localConflict:slot.localConflict||current.localConflict,predecessorId:entry.id,localPending:entry.status!=='SYNCED'||current.localPending};
    sessions.set(current.id,sessionView(snapshot,current));
    slot.activeSessionId=current.id;
  }
  const tables=[...slots.values()].map(slot=>{
    const detail=sessions.get(slot.activeSessionId);
    return {...slot,session:detail || (slot.activeSessionId ? {id:slot.activeSessionId,status:'DETAILS_UNAVAILABLE',
      tableLabel:slot.label,offlineEligible:false,outstanding:null} : null)};
  });
  return {board:{...snapshot.tableBoard,storeId:snapshot.storeId,enableNewSessions:snapshot.tableBoard.enableNewSessions===true && snapshot.tableBoard.enabled!==false,tables},sessions};
}
