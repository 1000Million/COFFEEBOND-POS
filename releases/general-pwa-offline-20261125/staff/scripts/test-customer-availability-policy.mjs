import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import Module from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {buildSync}=require('esbuild');
const root=resolve(import.meta.dirname,'..');
const baselineRoot=resolve(root,'../releases/bundle6-staff-source');
function load(base){const file=resolve(base,'frontend/lib/publicMenuAvailability.ts');const output=buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}).outputFiles[0].text;const mod=new Module(file);mod.filename=file;mod.paths=Module._nodeModulePaths(base);mod._compile(output,file);return mod.exports;}
const current=load(root),before=load(baselineRoot);
const store={id:'cJk69Ti1mveh603L4edw',code:'NOIDA_29',name:'Noida 29',isActive:true,customerOrderingEnabled:true,onlineOrderingEnabled:true,publicOrderingEnabled:true,acceptingOrders:true,isAcceptingOrders:true};
const almond={id:'ALMOND_MILK',code:'ALMOND_MILK',name:'Almond Milk',displayName:'Almond Milk',isActive:true,isAvailable:true,isSellable:true,salePrice:60,taxRate:5,itemType:'MADE_TO_ORDER',productionMode:'MADE_TO_ORDER',prepStation:'BARISTA',bom:[],availableStoreIds:[store.id],posCategoryCode:'NEW_CATEGORY_19',posCategoryName:'Add On',sortOrder:0};
const raw={code:'MILK',name:'Milk',usageUOM:'ML'};
const goodBom=[{componentType:'RAW_INGREDIENT',componentCode:'MILK',quantity:20,uom:'ML'}];
const tests=[];const test=(name,fn)=>tests.push({name,fn});
const make=(fg={},extra={},api=current)=>api.buildPublicMenuAvailabilitySnapshot({store,finishedGoods:[{...almond,...fg}],storeStock:[],rawIngredients:[raw],...extra});
const row=s=>s.items.ALMOND_MILK;
const orderable=s=>Boolean(s.menuItems.ALMOND_MILK?.isActive&&s.menuItems.ALMOND_MILK?.isSellable&&s.menuItems.ALMOND_MILK?.isAvailable&&row(s)?.available&&row(s)?.publicStatus==='AVAILABLE');
test('ALMOND_MILK_NOIDA_29_VISIBLE',()=>assert.ok(make().menuItems.ALMOND_MILK));
test('ALMOND_MILK_NOIDA_29_ORDERABLE',()=>assert.ok(orderable(make())));
for(const [name,bom]of [['MISSING_BOM_VISIBLE',[]],['MISSING_COMPONENT_VISIBLE',[{...goodBom[0],componentCode:'MISSING'}]],['INCOMPLETE_BOM_VISIBLE',[{...goodBom[0],quantity:0}]]])test(name,()=>assert.equal(row(make({bom})).available,true));
for(const [name,qty]of [['ZERO_STOCK_VISIBLE',0],['NEGATIVE_STOCK_VISIBLE',-5]])test(name,()=>assert.ok(orderable(make({bom:goodBom},{storeStock:[{storeId:store.id,stockItemCode:'MILK',currentStock:qty,uom:'ML'}]}))));
test('PENDING_BOM_VISIBLE',()=>assert.ok(orderable(make({inventoryConsumptionStatus:'PENDING_BOM'}))));
test('MANUALLY_INACTIVE_BLOCKED',()=>assert.equal(make({isActive:false}).menuItems.ALMOND_MILK,undefined));
test('MANUALLY_UNAVAILABLE_BLOCKED',()=>assert.equal(row(make({isAvailable:false})).available,false));
for(const flag of ['isActive','customerOrderingEnabled','onlineOrderingEnabled','publicOrderingEnabled','acceptingOrders','isAcceptingOrders'])test('STORE_DISABLED_BLOCKED '+flag,()=>assert.equal(row(make({bom:goodBom},{store:{...store,[flag]:false}})).available,false));
for(const flag of ['customerOrderingEnabled','onlineOrderingEnabled'])test('ITEM_ORDERING_DISABLED '+flag,()=>assert.equal(row(make({bom:goodBom,[flag]:false})).available,false));
test('STORE_ITEM_MANUAL_DISABLE',()=>assert.equal(row(make({},{storeItemConfigs:[{storeId:store.id,itemCode:'ALMOND_MILK',isAvailableOverride:false}]})).available,false));
test('MANUAL_MENU_HIDE',()=>assert.equal(make({},{storeItemConfigs:[{storeId:store.id,itemCode:'ALMOND_MILK',menuVisibilityOverride:false}]}).menuItems.ALMOND_MILK,undefined));
test('NORMAL_ITEM_MENU_PARITY',()=>assert.deepEqual(make({bom:goodBom}),make({bom:goodBom},{},before)));
for(const code of ['TR_SET_A','TR_SET_B'])test('TASTING_ROOM_MANUAL_DISABLE '+code,()=>{const tr={...store,id:'TASTING_ROOM_29',code:'TASTING_ROOM_29'};const result=current.buildPublicMenuAvailabilitySnapshot({store:tr,finishedGoods:[{...almond,id:code,code,availableStoreIds:[tr.id],isAvailable:true}],storeStock:[],storeItemConfigs:[{storeId:tr.id,itemCode:code,isAvailableOverride:false}]});assert.equal(result.items[code].publicStatus,'CURRENTLY_UNAVAILABLE');assert.equal(result.items[code].available,false);});

// Run only the existing legacy publisher's pure builder, never its admin initializer/main.
const legacySource=readFileSync(resolve(root,'scripts/refresh-public-menu-availability.mjs'),'utf8');
const legacy=vm.runInNewContext(legacySource.slice(legacySource.indexOf('function toNumber('),legacySource.indexOf('function snapshotCount('))+'; buildSnapshot',{});
function legacyMenu(item={},storeOverrides={}){return legacy({targetStore:{id:store.id,data:{...store,...storeOverrides}},sourceSnapshot:{items:{ALMOND_MILK:{available:false,publicStatus:'SETUP_INCOMPLETE'}}},currentSnapshot:{},finishedGoods:[{id:'ALMOND_MILK',data:{...almond,...item}}],addOnGroups:[]});}
test('LEGACY_PUBLISHER_MISSING_BOM_ORDERABLE',()=>assert.ok(orderable(legacyMenu())));
test('LEGACY_PUBLISHER_MANUAL_INACTIVE',()=>assert.equal(legacyMenu({isActive:false}).menuItems.ALMOND_MILK,undefined));
test('LEGACY_PUBLISHER_MANUAL_UNAVAILABLE',()=>assert.equal(legacyMenu({isAvailable:false}).menuItems.ALMOND_MILK,undefined));
test('LEGACY_PUBLISHER_STORE_DISABLED',()=>assert.equal(row(legacyMenu({},{customerOrderingEnabled:false})).available,false));
const fixturePath=resolve(root,'../evidence/bundle7b-validation/live-availability-fixtures.json');
const fixtures=JSON.parse(readFileSync(fixturePath,'utf8'));
test('LIVE_SNAPSHOT_ALMOND_MANUAL_FLAGS_PRESERVED',()=>{const s=current.buildPublicMenuAvailabilitySnapshot({store:fixtures.noidaStore,finishedGoods:[{id:'ALMOND_MILK',...fixtures.almond}],storeItemConfigs:fixtures.almondConfig?[fixtures.almondConfig]:[],storeStock:[]});assert.ok(orderable(s));assert.deepEqual(s.menuItems.ALMOND_MILK,before.buildPublicMenuAvailabilitySnapshot({store:fixtures.noidaStore,finishedGoods:[{id:'ALMOND_MILK',...fixtures.almond}],storeItemConfigs:fixtures.almondConfig?[fixtures.almondConfig]:[],storeStock:[]}).menuItems.ALMOND_MILK);});
for(const code of ['TR_SET_A','TR_SET_B'])test('LIVE_TASTING_SET_STAYS_BLOCKED_AND_EXPLICIT_DISABLE_WINS '+code,()=>{const tr={...store,id:'TASTING_ROOM_29',code:'TASTING_ROOM_29'};const input={store:tr,finishedGoods:[{id:code,...fixtures.tastingRoom[code].fg}],storeStock:[],storeItemConfigs:[]};const existing=current.buildPublicMenuAvailabilitySnapshot(input);assert.equal(existing.items[code].available,false);const disabled=current.buildPublicMenuAvailabilitySnapshot({...input,storeItemConfigs:[{storeId:tr.id,itemCode:code,isAvailableOverride:false}]});assert.equal(disabled.items[code].publicStatus,'CURRENTLY_UNAVAILABLE');assert.equal(disabled.items[code].available,false);});
let failures=0;for(const {name,fn}of tests){try{fn();console.log('PASS '+name);}catch(e){failures++;console.log('FAIL '+name+': '+e.message);}}console.log(JSON.stringify({tests:tests.length,passed:tests.length-failures,failed:failures}));process.exitCode=failures?1:0;
