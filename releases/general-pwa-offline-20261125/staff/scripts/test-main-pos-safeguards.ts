import assert from 'node:assert/strict';
import {draftKey,readLocalDraft,readTableDraft,writeLocalDraft,sanitizeDraft,draftStatus,assertCounterContext} from '../frontend/lib/tables/drafts';
import {setUpdateAccount,registerPosUpdateBoundary,beginCriticalOperation,blockAppUpdate,updatesAreSafe,requireOnlineAction} from '../frontend/lib/connectivity';
const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)||null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}};
const key=draftKey('synthetic-privacy','store-a',null),item={id:'line',menuItemId:'COFFEE',quantity:2,addOns:[{groupId:'EXTRA',optionId:'shot',quantity:1,optionName:'not persisted'}],name:'free text excluded',price:1,paymentToken:'never'};
const legacy={cart:[item],orderType:'TAKEAWAY',customerName:'Synthetic private',customerPhone:'9999999999',tableNumber:'free text',token:'never',payments:[{amount:1}]};
data.set(key,JSON.stringify(legacy));data.set('held-bills','preserve');data.set('pending-payment','preserve');
const restored:any=readLocalDraft(key,null,storage);assert.equal(restored.schemaVersion,2);assert.equal(restored.cart[0].quantity,2);assert.deepEqual(Object.keys(restored).sort(),['cart','orderType','schemaVersion']);assert.deepEqual(Object.keys(restored.cart[0]).sort(),['addOns','id','menuItemId','quantity']);
for(const prohibited of ['Synthetic private','9999999999','free text','paymentToken','token','payments','price'])assert(!data.get(key)!.includes(prohibited));assert.equal(data.get('held-bills'),'preserve');assert.equal(data.get('pending-payment'),'preserve');
assert.equal(readLocalDraft(draftKey('another-account','store-a',null),null,storage),null);assert.equal(readLocalDraft(draftKey('synthetic-privacy','store-b',null),null,storage),null);
const table=draftKey('synthetic-privacy','store-a','session-a');assert(writeLocalDraft(table,{id:'round',items:[{orderItemId:'l',parentProductId:'COFFEE',parentProductCode:'COFFEE',quantity:1,selectedAddOns:[],label:'name must not persist',price:100}]},storage));assert(!data.get(table)!.includes('label'));assert(!data.get(table)!.includes('price'));assert.equal(readTableDraft(table).items[0].parentProductId,'COFFEE');assert.equal(readTableDraft(draftKey('synthetic-privacy','store-a','session-b')).items.length,0);
const full={setItem(){throw new DOMException('Full','QuotaExceededError')}};assert.equal(writeLocalDraft(key,legacy,full),false);assert.equal(draftStatus(key),'memory-only');assert.equal((readLocalDraft<any>(key,null)).cart[0].quantity,2);
const bad=draftKey('corrupt','store',null);data.set(bad,'{broken');assert.equal(readLocalDraft(bad,null,storage),null);assert.equal(draftStatus(bad),'corrupt');assert.equal(data.get(bad),'{broken');assert.throws(()=>sanitizeDraft({cart:[{...item,quantity:0}]}));assert.throws(()=>writeLocalDraft('unrelated',legacy,storage));
assert.throws(()=>assertCounterContext(true));assert.doesNotThrow(()=>assertCounterContext(false));
// Real update/action boundary functions, with only the device connection fixture.
const events:Event[]=[];(globalThis as any).window={dispatchEvent:(e:Event)=>{events.push(e);return true}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});assert.equal(updatesAreSafe(),false);setUpdateAccount(null);assert.equal(updatesAreSafe(),true);
const end=beginCriticalOperation();assert.equal(updatesAreSafe(),false);end();end();assert.equal(updatesAreSafe(),true);const unblock=blockAppUpdate();assert.equal(updatesAreSafe(),false);unblock();assert.equal(updatesAreSafe(),true);
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:false}});assert.equal(requireOnlineAction(),false);assert.equal(updatesAreSafe(),false);assert(events.length>0);
console.log('PASS: versioned legacy sanitization; reference allowlist; account/store/session isolation; unrelated storage preserved; corrupt/full handling; local-only continuation; critical/draft/offline update guards; command boundary');

Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
(globalThis as any).window.location={pathname:'/pos'};(globalThis as any).window.localStorage=storage;
setUpdateAccount('synthetic-privacy');assert.equal(updatesAreSafe(),false);const leave=registerPosUpdateBoundary();assert.equal(updatesAreSafe(),true);
storage.setItem('coffee-bond-table-command:synthetic-privacy','{"opId":"original"}');assert.equal(updatesAreSafe(),false);storage.removeItem('coffee-bond-table-command:synthetic-privacy');assert.equal(updatesAreSafe(),true);leave();assert.equal(updatesAreSafe(),false);
console.log('PASS: unknown-auth, unloaded POS route and persisted original-operation update guards');
