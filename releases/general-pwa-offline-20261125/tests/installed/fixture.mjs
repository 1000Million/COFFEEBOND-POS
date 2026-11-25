import path from 'node:path';

export const assignedStore = 'QA_DESIGNATED_CAFE';
export const otherStore = 'QA_OTHER_CAFE';
export const sessionId = 'QA_INSTALLED_ORDER_SESSION';
export const tableId = 'QA_OCCUPIED';
const products = [
  ['PREVIEW_CAPPUCCINO', 'Cappuccino', 185, 'Coffee'],
  ['PREVIEW_FLAT_WHITE', 'Flat White', 195, 'Coffee'],
  ['PREVIEW_ESPRESSO', 'Double Espresso', 140, 'Coffee'],
  ['PREVIEW_COLD_BREW', 'Cold Brew', 225, 'Coffee'],
  ['PREVIEW_HOT_CHOC', 'Hot Chocolate', 235, 'Coffee'],
  ['PREVIEW_PESTO', 'Pesto Cottage Cheese Sandwich', 325, 'Kitchen'],
  ['PREVIEW_NACHOS', 'Protein Nachos', 295, 'Kitchen'],
  ['PREVIEW_HUMMUS', 'Hummus & Greens', 315, 'Kitchen'],
  ['PREVIEW_CROISSANT', 'Butter Croissant', 165, 'Kitchen'],
  ['PREVIEW_BROWNIE', 'Chocolate Brownie', 175, 'Kitchen'],
];
const storeRecord = {isActive:true,posEnabled:true,gstTreatment:{mode:'STORE_WIDE',rate:5,revision:1},gstRegistered:true,gstin:'SYNTHETIC-LOCAL-GST',stateCode:'09',legalName:'Coffee Bond Local Preview',tradeName:'Coffee Bond',legalAddress:'Synthetic data'};
const assigned = [assignedStore,otherStore,'B_SYNTH_STORE'];

export async function seed(runtime){
  const { db } = runtime;
  await db.doc('users/SYNTH_ADMIN').update({name:'Preview Admin',displayName:'Preview Admin',assignedStoreIds:assigned,storeIds:assigned});
  await db.doc('users/SYNTH_CASHIER').update({name:'Preview Cashier',displayName:'Preview Cashier',assignedStoreIds:assigned,storeIds:assigned});
  await db.doc('users/SYNTH_MANAGER').update({assignedStoreIds:assigned,storeIds:assigned});
  await db.doc('stores/'+assignedStore).set({...storeRecord,code:'QA_CAFE',name:'Synthetic Market Street Cafe'});
  await db.doc('stores/'+otherStore).set({...storeRecord,code:'QA_OTHER',name:'Synthetic Junction Cafe'});
  await Promise.all(['Coffee','Kitchen'].map((name,index)=>db.doc('categories/PREVIEW_'+name.toUpperCase()).set({name,isActive:true,sortOrder:index+1})));
  await db.doc('appSettings/gstConfig').set({defaultGstRate:5});
  for (const [id,name,price,category] of products){
    const taxonomy=id==='PREVIEW_COLD_BREW' ? ['COLD_BREW_VIETNAMESE_STYLE','COLD_BREW_BASED']
      : id==='PREVIEW_HOT_CHOC' ? ['SPECIALTY_DRINKS',null]
      : ['PREVIEW_CROISSANT','PREVIEW_BROWNIE'].includes(id) ? ['BAKED_BAKERY_ICE_CREAM','BAKED']
      : category==='Kitchen' ? ['JAFFLE_BITES_SALADS',id==='PREVIEW_HUMMUS'?'SALADS':'JAFFLE_BITES']
      : ['ESPRESSO_BAR',id==='PREVIEW_ESPRESSO'?'BLACK_COFFEE':'MILK_BASED'];
    await db.doc('finishedGoods/'+id).set({code:id,name,displayName:name,price,salePrice:price,taxRate:5,isActive:true,isSellable:true,isAvailable:true,availableStoreIds:[assignedStore,otherStore],addOnGroupIds:[],category,categoryName:category,categoryId:'PREVIEW_'+category.toUpperCase(),posCategoryCode:taxonomy[0],posSubcategoryCode:taxonomy[1],prepStation:category==='Kitchen'?'KITCHEN':'BARISTA',itemType:'DIRECT_STOCK',recipeCost:12});
    await db.doc('storeStock/'+assignedStore+'_FINISHED_GOOD_'+id).set({storeId:assignedStore,stockItemType:'FINISHED_GOOD',stockItemCode:id,stockItemName:name,currentStock:1000,uom:'PCS',costPerUnit:12});
  }
  await db.doc('tableServiceConfig/'+assignedStore).set({enabled:true,enableNewSessions:true});
  for (const [id,label] of [[tableId,'Fixture patio'],['QA_EMPTY','Fixture empty']]) {
    await db.doc('tables/'+assignedStore+'_'+id).set({storeId:assignedStore,tableId:id,label,capacity:4,activeSessionId:null});
  }
  const {createRequire}=await import('node:module');
  const loader=createRequire(path.join(runtime.backend,'package.json'));
  process.env.NODE_PATH=path.join(runtime.backend,'node_modules')+':'+path.resolve(runtime.staff,'../../normal-browser-recovery-fix-20261116/candidate/backend/node_modules');
  loader('node:module').Module._initPaths();
  const table=loader(path.resolve(runtime.staff,'../backend/offlineCash/deployed-table/tableService.js')).createTableService({db,admin:runtime.admin});
  const run=(d)=>table.run({auth:{uid:'SYNTH_ADMIN'},data:{storeId:assignedStore,sessionId,...d}});
  await run({action:'OPEN',opId:'FIXTURE_INITIAL_OPEN',tableId,guestCount:2});
  await run({action:'SEND',opId:'FIXTURE_INITIAL_ROUND',version:1,items:[{parentProductId:'PREVIEW_CAPPUCCINO',parentProductCode:'PREVIEW_CAPPUCCINO',orderItemId:'FIXTURE_STARTED_LINE',quantity:1,selectedAddOns:[]}]});
  return runtime;
}

