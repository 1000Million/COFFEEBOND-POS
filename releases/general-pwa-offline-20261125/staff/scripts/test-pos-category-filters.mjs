import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';
const root = new URL('../', import.meta.url).pathname;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pos-category-filters.baseline.json', import.meta.url)));
function load(file) {
 const code=esbuild.buildSync({entryPoints:[root+file],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
 const context={module:{exports:{}},exports:{}};vm.runInNewContext(code,context);return context.module.exports;
}
const nav=load('frontend/lib/posMenuNavigation.ts');
const context={...nav,module:{exports:{}}};
vm.runInNewContext(esbuild.transformSync(Object.values(fixture.declarations).join('\n')+'\nmodule.exports={'+Object.keys(fixture.declarations).join(',')+'};',{loader:'ts',format:'cjs'}).code,context);
const before=context.module.exports;
const beforeMode=process.argv.includes('--before');
if(beforeMode) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(root+'frontend/pages/pos/POSHome.tsx')).digest('hex'),fixture.sourceSha256);
const after=beforeMode?before:load('frontend/lib/pos/posCategoryFilters.ts');
const clean=v=>JSON.parse(JSON.stringify(v,(_k,x)=>Object.prototype.toString.call(x)==='[object Map]'?[...x]:x));
let cases=0;
function parity(name,args,expected) {const original=clean(before[name](...args));const actual=clean(after[name](...args));assert.deepEqual(actual,original,name);if(expected!==undefined)assert.deepEqual(actual,expected,name+' expected');cases++;return after[name](...args);}
const cat=[...nav.POS_MENU_CATEGORIES,{code:'ADD_ON',name:'Add On',sortOrder:200,subcategories:[]}];
const item=(id,category,name=id,extra={})=>({id,name,category,code:id,price:100,...extra});
const examples=[['COFFEE','BLACK_COFFEE','ESPRESSO_BAR'],['COLD_COFFEE','ICED_COFFEES','ICED_COFFEES'],['MATCHA','MATCHA','MATCHA_MANUAL_BREWS'],['TEA','HERBAL_TEA','HERBAL_TEA'],['FOOD','PIZZA','PIZZA_PIDE'],['DESSERT','BAKED','BAKED_BAKERY_ICE_CREAM'],['ADD_ONS','ADD_ON','ADD_ON'],['UNKNOWN','mystery','NEEDS_CLASSIFICATION']];
const items=examples.map(([id,category])=>item(id,category));
const classifications=parity('classifyMenuItems',[items,cat]);
for(const [id,,expected] of examples) assert.equal(classifications.get(id).category.code,expected,id);
parity('countMenuCategories',[items,classifications]);
parity('countMenuCategories',[[item('absent','none')],new Map()],[['NEEDS_CLASSIFICATION',1]]);
for(const category of cat) {
 const explicit=[item(category.code,category.code)];
 for(const sub of category.subcategories) explicit.push(item(sub.code,category.code,sub.name,{posCategoryCode:category.code,posSubcategoryCode:sub.code}));
 const map=parity('classifyMenuItems',[explicit,cat]);
 for(const sub of ['ALL','NO_MATCH',...category.subcategories.map(x=>x.code)]) {
  const filtered=parity('filterMenuCategory',[explicit,map,category.code,sub,[]]);
  parity('groupMenuSections',[filtered,map,'',category.code,sub,category]);
 }
 parity('menuTileTone',[category.code]);
}
parity('menuTileTone',['unknown']);
parity('filterMenuCategory',[items,classifications,'NO_MATCH','ALL',[]],[]);
parity('filterMenuCategory',[items,classifications,'ALL','ALL',[]],clean(items));
parity('filterMenuCategory',[items,classifications,'QUICK_PICKS','ALL',[items[2]]],clean([items[2]]));
for(const query of ['','espresso']) for(const code of ['ALL','QUICK_PICKS','ESPRESSO_BAR']) parity('groupMenuSections',[items,classifications,query,code,'ALL',cat[0]]);
const ranking=[item('normal','x','A'),item('sales','x','Z',{salesCount:10}),item('popular','x','Z',{isPopular:true}),item('tieB','x','B',{sortOrder:1}),item('tieA','x','A',{sortOrder:1})];
assert.deepEqual(clean(parity('rankFastMenuItems',[ranking])).map(x=>x.id),['popular','sales','tieA','tieB','normal']);
assert.equal(parity('rankFastMenuItems',[Array.from({length:12},(_,i)=>item(String(i),'x','Item '+i))]).length,8);
const searchItems=[item('espresso','BLACK_COFFEE','Double Espresso'),item('cookie','BAKED','Anzac Cookie')];
// Execute the actual search-first POSHome branch; the shared search implementation remains unchanged.
const posSource=fs.readFileSync(root+'frontend/pages/pos/POSHome.tsx','utf8');
const body=posSource.split('  const filteredMenuItems = useMemo(() => {')[1].split('\n  }, [')[0];
const searchContext={...nav,...after,module:{exports:{}}};
vm.runInNewContext(esbuild.transformSync('function filter(availableMenuItems, searchQuery, posMenuCategories, selectedCategoryId, selectedSubcategoryId, classificationByItemId, topFeaturedItems) {'+body+'\n} module.exports=filter;',{loader:'ts',format:'cjs'}).code,searchContext);
for(const query of ['Double Espresso','espresso','DOUBLE ESPRESSO','EsPrEsSo','nonexistent','  espresso  ']) {
 const args=[searchItems,query,cat,'BAKED_BAKERY_ICE_CREAM','ALL',before.classifyMenuItems(searchItems,cat),[]];
 const result=searchContext.module.exports(...args);
 assert.deepEqual(clean(result),clean(nav.searchPosMenuItems(searchItems,query,cat)));
 assert.deepEqual(clean(result).map(x=>x.id),query==='nonexistent'?[]:['espresso']);cases++;
}
console.log(`POS category/search ${beforeMode?'BEFORE':'AFTER'}: PASS; ${cases} parity cases.`);
