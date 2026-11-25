// Local-only React screen fixture. Firebase imports are replaced at build time.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const root = new URL('../', import.meta.url).pathname;
const output = path.resolve(root, '../evidence/browser');
fs.mkdirSync(output,{recursive:true});
const mock = `
export const db={}, functions={}, auth={}, firebaseConfig={}, inMemoryPersistence={};
export const getApp=()=>({}),getApps=()=>[],initializeApp=()=>({}),getAuth=()=>({}),setPersistence=async()=>{},signOut=async()=>{},deleteApp=async()=>{};
const stamp=()=>({toDate:()=>new Date(),toMillis:()=>Date.now()});
const store={id:'QA_STORE',name:'Synthetic Cafe',code:'QA_STORE',isActive:true};
let role='ADMIN', signedIn=true;
export const useAuth=()=>({staffProfile:profile,authStatus:signedIn?'ready':'signed-out',firebaseUser:signedIn?{uid:'QA_STAFF'}:null,logout:async()=>{}});
const profile={uid:'QA_STAFF',name:'Synthetic Staff',role:'ADMIN'};
export const accessiblePosStores=rows=>rows;
export const assignedStoreIdentifiers=()=>[store.id];
export const beginCriticalOperation=()=>()=>{};
export const requireOnlineAction=()=>true;
export const OFFLINE_ACTION_MESSAGE='Offline';
export const publicStatusMessage=()=>'';
export const updatePublicOrderTracking=async()=>{};
export const isOnlineOrderAcceptError=()=>false;
export const collection=(_,name)=>name;
export const doc=(_,name,id)=>({name,id});
export const where=(field,op,value)=>({field,op,value});
export const query=(name,...filters)=>({name,filters});
export const serverTimestamp=stamp;
let records=JSON.parse(sessionStorage.getItem('coffee-bond-alert-qa')||'null')||seed();
let disconnected=false, denied=false;
const listeners=new Set();
function seed(){return {onlineOrders:[],kotItems:[]};}
function order(id,paid){return {id,storeId:store.id,storeName:store.name,status:paid?'PAID_PENDING_ACCEPTANCE':'PENDING',paymentProvider:paid?'RAZORPAY':'COUNTER',customerName:id,customerPhone:'',publicOrderReference:id,orderType:'TAKEAWAY',trackingToken:'SYNTHETIC',items:[{finishedGoodCode:'QA',itemName:'Synthetic menu item',quantity:1,lineTotal:100}],grandTotal:100};}
function kot(id){return {id,storeId:store.id,storeName:store.name,station:'KITCHEN',status:'PENDING',orderNumber:id,orderType:'TAKEAWAY',itemName:'Synthetic kitchen item '+id,itemCode:'QA',quantity:1};}
const docs=rows=>rows.map(row=>({id:row.id,data:()=>({...row,createdAt:stamp()}),exists:()=>true}));
export const getDocs=async q=>({docs:docs((q.name||q)==='stores'?[store]:(q.name||q)==='finishedGoods'?[{id:'QA_COFFEE',code:'QA_COFFEE',name:'Synthetic Coffee',isActive:true,isAvailable:true,isSellable:true,salePrice:100,category:'Coffee',itemType:'FINISHED_GOOD',prepStation:'BARISTA'}]:[])});
export const getDoc=async ref=>ref.name==='stores'?docs([store])[0]:{exists:()=>false,data:()=>({})};
export const Timestamp={fromDate:date=>date,now:()=>new Date()};
export const orderBy=(...args)=>({orderBy:args});
export const limit=(...args)=>({limit:args});
export const documentId=()=> 'id';
export const increment=()=>{throw Error('Unexpected fixture increment');};
export const deleteField=()=>{throw Error('Unexpected fixture deleteField');};
export const writeBatch=()=>{throw Error('Unexpected fixture batch');};
export const runTransaction=()=>{throw Error('Unexpected fixture transaction');};
export const setDoc=()=>{throw Error('Unexpected fixture setDoc');};
export const deleteDoc=()=>{throw Error('Unexpected fixture deleteDoc');};
export const RecaptchaVerifier=class {};
export const signInWithPhoneNumber=()=>{throw Error('Unexpected OTP');};
let createdOnline=0,peakOnline=0,writes=0;
export const diagnostics=()=>({online:listeners.size?[...listeners].filter(l=>l.q.name==='onlineOrders').length:0,kot:[...listeners].filter(l=>l.q.name==='kotItems').length,createdOnline,peakOnline,writes});
function notify(){window.dispatchEvent(new Event('qa-audio'));}
export function onSnapshot(q,opts,ok,error){if(typeof opts==='function'){error=ok;ok=opts;}const l={q,ok,error};listeners.add(l);if(q.name==='onlineOrders')createdOnline++;peakOnline=Math.max(peakOnline,diagnostics().online);queueMicrotask(()=>{emit();notify();});return ()=>{listeners.delete(l);notify();};}
function emit(){if(disconnected)return;for(const l of listeners){if(l.q.id){l.ok({exists:()=>false,data:()=>({})});continue;}const rows=(records[l.q.name]||[]).filter(row=>l.q.filters.every(f=>f.op==='in'?f.value.includes(row[f.field]):row[f.field]===f.value));l.ok({metadata:{hasPendingWrites:false},docs:docs(rows)});}}
function save(){sessionStorage.setItem('coffee-bond-alert-qa',JSON.stringify(records));emit();}
export async function updateDoc(ref,data){if(denied)throw Error('Synthetic write failure');writes++;Object.assign(records[ref.name].find(row=>row.id===ref.id),data);save();}
export async function acceptOnlineOrder(id){if(id.startsWith('LEGACY-MALFORMED'))throw Error('The stored online-order price snapshot is malformed.');if(id.startsWith('LEGACY-UNAVAILABLE'))throw Error('One or more products are no longer available at this store.');await updateDoc({name:'onlineOrders',id},{status:'CONVERTED'});return {orderNumber:id,kotCount:1,stockMovementCount:1};}
export const httpsCallable=(_,name)=>async ({onlineOrderId,reason})=> {if(name==='rejectCustomerOrder'){if(!reason?.trim())throw Error('Rejection reason required');return {data:await updateDoc({name:'onlineOrders',id:onlineOrderId},{status:'REJECTED'})};}return name==='acceptPaidRazorpayOrder'?{data:await acceptOnlineOrder(onlineOrderId)}:{data:await updateDoc({name:'onlineOrders',id:onlineOrderId},{status:'REFUND_PENDING'})};};
export function control(action){if(action==='Reset fixtures'){records=seed();disconnected=false;denied=false;save();}if(action==='Sign out'){signedIn=false;notify();}if(action==='Sign in'){signedIn=true;notify();}if(action==='Add malformed legacy'){const row=order('LEGACY-MALFORMED-'+Date.now(),false);delete row.paymentProvider;records.onlineOrders.push(row);save();}if(action==='Add unavailable legacy'){const row=order('LEGACY-UNAVAILABLE-'+Date.now(),false);delete row.paymentProvider;row.status='NEEDS_ATTENTION';row.attentionReason='Finished good unavailable';records.onlineOrders.push(row);save();}if(action==='Add online order'){records.onlineOrders.push(order('QA-NEW-'+Date.now(),true));save();}if(action==='Add KOT'){records.kotItems.push(kot('QA-NEW-'+Date.now()));save();}if(action==='Disconnect'){disconnected=true;for(const l of listeners)l.error(Error('Synthetic disconnect'));}if(action==='Reconnect'){disconnected=false;emit();}if(action==='Fail actions')denied=true;if(action==='Allow actions')denied=false;}
`;
const entry=`
import React,{useState,useEffect,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,Link,Navigate} from 'react-router-dom';
import Online from './frontend/pages/pos/IncomingOnlineOrders.tsx';
import Kitchen from './frontend/pages/kot/KOTScreen.tsx';
import POS from './frontend/pages/pos/POSHome.tsx';
import Reports from './frontend/pages/reports/ReportsHome.tsx';
import Layout from './frontend/components/Layout.tsx';
import {OnlineOrderAlertsProvider} from './frontend/lib/OnlineOrderAlerts.tsx';
import {useOrderAlertAudioUnlock} from './frontend/lib/orderAlerts.tsx';
import {control,diagnostics} from 'qa-mock';
let starts=0,active=0,period=0,contexts=0;
const RealAudio=window.AudioContext||window.webkitAudioContext;
if(RealAudio)window.AudioContext=class extends RealAudio {
 constructor(...args){super(...args);contexts++;}
 createBufferSource(){const source=super.createBufferSource(),start=source.start.bind(source),stop=source.stop.bind(source);source.start=(...args)=>{start(...args);starts++;active++;period=source.buffer.duration;window.dispatchEvent(new Event('qa-audio'));};source.stop=(...args)=>{stop(...args);active--;window.dispatchEvent(new Event('qa-audio'));};return source;}
};
function Fixture(){useOrderAlertAudioUnlock();const [audio,setAudio]=useState('starts=0 active=0'),[revision,setRevision]=useState(0);useEffect(()=>{const update=()=>{setAudio(JSON.stringify({starts,active,period,contexts,...diagnostics()}));};window.addEventListener('qa-audio',update);return()=>window.removeEventListener('qa-audio',update);},[]);return <BrowserRouter><aside className="border-b p-2 text-xs"><p>LOCAL SYNTHETIC QA — NO FIREBASE CONNECTION</p><output aria-label="Audio diagnostics">{audio}</output><div className="flex flex-wrap gap-2">{['Reset fixtures','Add malformed legacy','Add unavailable legacy','Add online order','Add KOT','Disconnect','Reconnect','Fail actions','Allow actions','Sign out','Sign in'].map(name=><button className="min-h-[32px] border p-1" key={name} onClick={()=>{control(name);setRevision(v=>v+1);}}>{name}</button>)}<Link to="/kot/kitchen">Kitchen fixture</Link></div></aside><OnlineOrderAlertsProvider><Suspense fallback={<p>Loading route…</p>}><Routes><Route element={<Layout/>}><Route path="/pos" element={<POS/>}/><Route path="/reports" element={<Reports/>}/><Route path="/pos/incoming-orders" element={<Online/>}/><Route path="/kot/kitchen" element={<Kitchen station="KITCHEN"/>}/><Route path="*" element={<Navigate to="/pos" replace/>}/></Route></Routes></Suspense></OnlineOrderAlertsProvider></BrowserRouter>};
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`;
const result=await build({stdin:{contents:entry,loader:'jsx',resolveDir:root},outfile:path.join(output,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',metafile:true,plugins:[{name:'isolate-firebase',setup(b){b.onResolve({filter:/^(qa-mock|firebase\/|.*\/(firebase|AuthContext|onlineOrderConversion|publicOrderTracking|connectivity|posStoreAccess)$)/},()=>({path:'mock',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:mock,loader:'js'}));}}]});
if(Object.keys(result.metafile.inputs).some(p=>p.includes('node_modules/@firebase')||p.endsWith('/lib/firebase.ts')))throw Error('Real Firebase included in fixture');
const css=fs.readdirSync(path.join(root,'dist/assets')).find(p=>p.endsWith('.css'));
fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coffee Bond alert QA</title><link rel="stylesheet" href="/assets/${css}"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const file=url.pathname.startsWith('/assets/')?path.join(root,'dist',url.pathname):path.join(output,url.pathname==='/'||!path.extname(url.pathname)?'index.html':url.pathname);if(!file.startsWith(output+'/')&&!file.startsWith(path.join(root,'dist/assets')+'/')){res.writeHead(403).end();return;}try{res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
server.listen(4317,'127.0.0.1',()=>console.log('ISOLATED_ALERT_QA=http://127.0.0.1:4317'));
