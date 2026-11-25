import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {usePosOfflineCash} from '../staff/frontend/lib/offline/usePosOfflineCash';
import {useTableOrder} from '../staff/frontend/lib/tables/useTableOrder';
const storeId='fixture-general-store-42';
import TableSelector from '../staff/frontend/components/tables/TableSelector';
import TableOrderPanel from '../staff/frontend/components/tables/TableOrderPanel';
import PosOfflineCashPayment from '../staff/frontend/components/pos/PosOfflineCashPayment';
import * as journal from '../staff/frontend/lib/offline/journal';
import * as repo from '../staff/frontend/lib/offline/tableRepository';
import {tableTotals} from '../staff/frontend/lib/tables/domain';

const profile={uid:'fixture',role:'CASHIER',isActive:true,assignedStoreIds:[storeId]};
const product={id:'fixture-cake',name:'Fixture Cake',code:'CAKE',price:100,tableProductId:'fixture-cake'};
const board={enabled:true,enableNewSessions:true,recoveryMode:false,complete:true,tables:[
 {tableId:'t1',label:'Openable',activeSessionId:null},{tableId:'t2',label:'Uncertain',activeSessionId:'frozen'},
 {tableId:'t3',label:'Incomplete',activeSessionId:'missing'}, {tableId:'t4',label:'Online policy',activeSessionId:'online-test'}]};
const frozen={id:'frozen',orderId:'existing-frozen',tableId:'t2',tableLabel:'Uncertain',status:'PAYMENT_PENDING',version:3,
 lines:[],rounds:[],total:200,outstanding:200,openedAt:Date.now(),paymentAttempt:{id:'fixture-attempt',amount:200},offlineEligible:false,unavailableReason:'Previous payment is unconfirmed.'};
const fixture=window.fixture={journal,repo,calls:[],storeId};
window.fake=async(method,input)=>{
 fixture.calls.push({method,action:input.action});
 if(method==='tableService'){
  if(input.action==='BOARD')return {...board,storeId,tables:board.tables.map(s=>({...s,id:s.tableId,session:s.activeSessionId?{id:s.activeSessionId,version:3}:null}))};
  if(input.action==='DETAIL' && input.sessionId==='online-test')return {...frozen,id:'online-test',storeId,
   tableId:'t4',tableLabel:'Online policy',orderId:'online-order',status:'OCCUPIED',paymentAttempt:null,
   kitchen:[],saved:{order:{id:'online-order',orderNumber:'SYNTHETIC-ONLY',paymentStatus:'UNPAID',commercialStatus:'SALE',subtotal:200,taxTotal:0,grandTotal:200},payments:[],items:[]}};
  throw Error('Unplanned server read');
 }
 if(input.action!=='PREPARE')throw Error('Unplanned server operation');
 const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const issuedAt=Date.now(),snapshot={id:crypto.randomUUID(),storeId,uid:profile.uid,role:profile.role,deviceId:input.deviceId,
  issuedAt,expiresAt:issuedAt+3600000,offlinePolicyVersion:2,tableWorkflowVersion:1,tableOwnership:{deviceId:input.deviceId,storeId},storeName:'Fixture store',legal:{tradeName:'Fixture'},gst:{},
  tableBoard:board,tableSessions:[frozen],tables:[],discountLimit:10,excluded:[],menu:[{id:product.id,name:product.name,
   request:{parentProductCode:product.code,selectedAddOns:[]},canonical:{parentProductCode:product.code,baseUnitPrice:100,taxRate:5,addOns:[],addOnTotal:0}}]};
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(journal.stable(snapshot)));
 return {snapshot,publicKey:await crypto.subtle.exportKey('jwk',key.publicKey),signature:btoa(String.fromCharCode(...new Uint8Array(signature)))};
};
function App(){
 const [online,setOnline]=useState(!sessionStorage.getItem('outage'));
 const [currentStore,setStore]=useState(storeId),[currentUid,setUid]=useState('fixture');
 const cash=usePosOfflineCash({store:{id:currentStore,isActive:true},staffProfile:{...profile,uid:currentUid},online});
 fixture.setStore=setStore;fixture.setUid=setUid;
 const table=useTableOrder(currentUid,currentStore,'DINE_IN',false,!online,online,false,cash);
 Object.assign(fixture,{cash,table});
 return <main><button onClick={()=>{sessionStorage.setItem('outage','true');setOnline(false);}}>Simulate outage</button>
 <output>{online?'Online':'Offline'} {cash.tableReady?'ready':'unavailable'}</output>
 <TableSelector table={table} blocked={false}/>
 <TableOrderPanel table={table} search={q=>product.name.toLowerCase().includes(q.toLowerCase())?[product]:[]} onAdd={i=>table.addItem(i,[])}
 describeLine={l=>({name:l.label,options:'',totals:tableTotals([{baseUnitPrice:100,quantity:l.quantity,taxRate:5,addOns:[]}])})}
 onViewMenu={()=>{}} offlinePayment={!online?discount=>cash.tableReady&&table.operationalReady&&table.session?.orderId&&!table.locked?
 <PosOfflineCashPayment total={table.session.outstanding} busy={false} onSave={async received=>{await journal.saveCash(cash.snapshot,[],discount,received,table.session);await cash.refresh();}}/>:null:undefined}/></main>;
}
async function start(){if(!await journal.getMeta('device') && !sessionStorage.getItem('outage'))await journal.device();createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);}
void start();
