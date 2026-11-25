import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
export const work=path.resolve(import.meta.dirname,'../..');
export const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cb-till-emulators-')),root='/Users/narendrashukla/Documents/ChatGPT/POS-CB/normal-browser-recovery-fix-20261116';
export const staff=path.join(work,'staff');
const backend=path.join(root,'mixed-version-fix-20261116/candidate/backend');
const authorizationBackend=backend;
fs.cpSync(path.join(import.meta.dirname,'functions'),path.join(dir,'functions'),{recursive:true});
fs.symlinkSync(path.join(root,'candidate/backend/node_modules'),path.join(dir,'functions/node_modules'));
export const req=createRequire(path.join(root,'candidate/backend/package.json')),front=createRequire(path.join(staff,'package.json'));
export const project='demo-coffee-bond-offline',node='/opt/homebrew/opt/node@22/bin/node';
export const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const evidenceDir=process.env.QUAL_EVIDENCE_DIR || path.join(work,'evidence/installed-pwa');fs.mkdirSync(evidenceDir,{recursive:true});
export const write=(name,v)=>fs.writeFileSync(path.join(evidenceDir,name),JSON.stringify(v,null,2)+'\n');
export async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
export async function start(){
 assert.equal(process.version,'v22.22.0');
 fs.writeFileSync(path.join(dir,'functions/runtime-sources.json'),JSON.stringify({commit:backend,authorization:authorizationBackend,dependencies:fs.realpathSync(path.join(root,'candidate/backend/node_modules')),offline:path.join(work,'backend/offlineCash/offlineCash.js'),table:path.join(work,'backend/offlineCash/deployed-table/tableService.js'),project},null,2));
 const ports={auth:await port(),firestore:await port(),functions:await port(),hub:await port(),logging:await port(),app:await port(),appOld:await port(),appNew:await port()};
 const config={functions:{source:'functions'},firestore:{rules:path.join(staff,'firestore.rules'),indexes:path.join(staff,'firestore.indexes.json')},emulators:{auth:{host:'127.0.0.1',port:ports.auth},firestore:{host:'127.0.0.1',port:ports.firestore},functions:{host:'127.0.0.1',port:ports.functions},hub:{host:'127.0.0.1',port:ports.hub},logging:{host:'127.0.0.1',port:ports.logging},ui:{enabled:false},singleProjectMode:true}};
 fs.writeFileSync(path.join(dir,'firebase.json'),JSON.stringify(config,null,2));
 const environment={...process.env,MIXED_QA_BACKEND_ROOT:backend,MIXED_QA_AUTH_BACKEND_ROOT:authorizationBackend,NODE_PATH:fs.realpathSync(path.join(root,'candidate/backend/node_modules')),PATH:path.dirname(node)+':'+process.env.PATH,GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',CI:'true',JAVA_HOME:'/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:'+ports.auth,FIRESTORE_EMULATOR_HOST:'127.0.0.1:'+ports.firestore};
 const credentialPath=path.join(dir,'synthetic-credential.json');fs.writeFileSync(credentialPath,JSON.stringify({type:'service_account',project_id:project,client_email:'synthetic@'+project+'.iam.gserviceaccount.com',private_key:crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}).privateKey}));environment.GOOGLE_APPLICATION_CREDENTIALS=credentialPath;delete environment.FIREBASE_TOKEN;environment.NODE_OPTIONS='--require '+path.resolve(root,'../offline-sector51-enrollment-fix-20261105/tools/loopback-only.cjs');environment.QUAL_NETWORK_LOG=path.join(evidenceDir,'denied-nonlocal.jsonl');
 const log=fs.openSync(path.join(evidenceDir,'emulators.log'),'a');
 const emulators=spawn(node,['/opt/homebrew/lib/node_modules/firebase-tools/lib/bin/firebase.js','emulators:start','--only','auth,firestore,functions','--project',project,'--config',path.join(dir,'firebase.json')],{cwd:dir,env:environment,stdio:['ignore',log,log]});
 let closed=false,app,proxy,backendUp=true;
 const gates=[],sockets=new Set(),gateEvents=[];
 const close=async()=>{if(closed)return;closed=true;if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}for(const s of sockets)s.destroy();for(const gate of gates)await new Promise(r=>gate.close(r));if(app){await app.firestore().terminate();await app.delete()}emulators.kill('SIGINT');await new Promise(r=>{if(emulators.exitCode!==null)return r();emulators.once('exit',r);setTimeout(()=>{emulators.kill('SIGKILL');r()},5000).unref()});fs.closeSync(log);fs.rmSync(dir,{recursive:true,force:true})};
 try{
 await new Promise((resolve,reject)=>{const until=Date.now()+90000;const check=()=>{if(emulators.exitCode!==null)return reject(Error('Emulator exit '+emulators.exitCode));const s=net.connect({host:'127.0.0.1',port:ports.functions});s.once('connect',()=>{s.destroy();resolve()});s.once('error',()=>{s.destroy();if(Date.now()>until)reject(Error('Functions emulator not ready'));else setTimeout(check,250)})};check()});
 // Give emulator function discovery time to complete; readiness below is a real callable response.
 const callable='http://127.0.0.1:'+ports.functions+'/'+project+'/us-central1/commitPosCheckout';
 await new Promise((resolve,reject)=>{const until=Date.now()+60000;const check=async()=>{try{const r=await fetch(callable,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{}})});const j=await r.json();if(j.error?.status==='UNAUTHENTICATED')return resolve()}catch{}if(Date.now()>until)reject(Error('Exact callable was not discovered'));else setTimeout(check,300)};check()});
 Object.assign(process.env,{FIREBASE_AUTH_EMULATOR_HOST:environment.FIREBASE_AUTH_EMULATOR_HOST,FIRESTORE_EMULATOR_HOST:environment.FIRESTORE_EMULATOR_HOST,GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project});process.env.GOOGLE_APPLICATION_CREDENTIALS=credentialPath;
 const admin=req('firebase-admin');app=admin.initializeApp({projectId:project},'full-app-'+crypto.randomUUID());const db=app.firestore();
 const accounts={};for(const [role,uid] of [['ADMIN','SYNTH_ADMIN'],['STORE_MANAGER','SYNTH_MANAGER'],['CASHIER','SYNTH_CASHIER']]){const email=role.toLowerCase()+'@qualification.invalid';await app.auth().createUser({uid,email,password:'Synthetic-Only-2026!'});await db.doc('users/'+uid).set({uid,role,isActive:true,name:'Synthetic '+role,displayName:'Synthetic '+role,staffAccessVersion:1,assignedStoreIds:['B_SYNTH_STORE'],storeIds:['B_SYNTH_STORE']});accounts[role]={uid,email,password:'Synthetic-Only-2026!'}}
 const stores=[{id:'A_SYNTH_STORE',code:'A_SYNTH_STORE',name:'A Synthetic First Store',isActive:true,posEnabled:true,gstTreatment:{mode:'ITEM_WISE',rate:null,revision:1}},{id:'B_SYNTH_STORE',code:'B_SYNTH_STORE',name:'B Synthetic Assigned Store',isActive:true,posEnabled:true,gstTreatment:{mode:'ITEM_WISE',rate:null,revision:1}}];
 for(const store of stores)await db.doc('stores/'+store.id).set(store);
 const product={id:'SYNTH_PRODUCT',code:'SYNTH_PRODUCT',name:'Synthetic Stock Coffee',displayName:'Synthetic Stock Coffee',price:100,salePrice:100,taxRate:5,isActive:true,isSellable:true,isAvailable:true,availableStoreIds:stores.map(s=>s.id),addOnGroupIds:[],prepStation:'KITCHEN',itemType:'DIRECT_STOCK',recipeCost:12,category:'Coffee',categoryId:'SYNTH_CATEGORY'};
 await db.doc('finishedGoods/'+product.id).set(product);await db.doc('categories/SYNTH_CATEGORY').set({name:'Coffee',isActive:true,sortOrder:1});
 for(const store of stores)await db.doc('storeStock/'+store.id+'_FINISHED_GOOD_'+product.code).set({storeId:store.id,stockItemType:'FINISHED_GOOD',stockItemCode:product.code,stockItemName:product.name,currentStock:1000,uom:'PCS',costPerUnit:12});
 // Native hosts, service workers and browser pages see only these three endpoints. The
 // read-only test observer uses the underlying emulator to measure effects while disconnected.
 const external={...ports};
 for(const name of ['auth','firestore','functions']){
   const gate=net.createServer(client=>{
     if(!backendUp){client.destroy();return;}
     const upstream=net.connect({host:'127.0.0.1',port:ports[name]});
     for(const socket of [client,upstream]){sockets.add(socket);socket.on('error',()=>{client.destroy();upstream.destroy();});socket.on('close',()=>sockets.delete(socket));}
     client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream).pipe(client);
   });
   await new Promise((yes,no)=>gate.once('error',no).listen(0,'127.0.0.1',yes));
   external[name]=gate.address().port;gates.push(gate);
 }
 Object.assign(process.env,{VITE_FIREBASE_API_KEY:'synthetic-emulator-api-key',VITE_FIREBASE_AUTH_DOMAIN:project+'.firebaseapp.com',VITE_FIREBASE_PROJECT_ID:project,VITE_FIREBASE_MESSAGING_SENDER_ID:'1234567890',VITE_FIREBASE_APP_ID:'1:1234567890:web:synthetic',VITE_FIREBASE_STORAGE_BUCKET:project+'.appspot.com',VITE_FIREBASE_FUNCTIONS_REGION:'us-central1',VITE_USE_FIREBASE_EMULATORS:'true',VITE_OFFLINE_RELEASE:'local',VITE_OFFLINE_LOCAL_ONLY:'true',VITE_FIREBASE_AUTH_EMULATOR_URL:'http://127.0.0.1:'+external.auth,VITE_FIREBASE_FIRESTORE_EMULATOR_HOST:'127.0.0.1',VITE_FIREBASE_FIRESTORE_EMULATOR_PORT:String(external.firestore),VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST:'127.0.0.1',VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT:String(external.functions),VITE_FIREBASE_STORAGE_EMULATOR_HOST:'127.0.0.1',VITE_FIREBASE_STORAGE_EMULATOR_PORT:'61999',DISABLE_HMR:'true'});
 const out=path.join(dir,'staff-build');
 async function build(){
   const {spawnSync}=await import('node:child_process');
   const result=spawnSync(process.execPath,[path.join(staff,'node_modules/vite/bin/vite.js'),'build','--outDir',out,'--emptyOutDir'],{cwd:staff,encoding:'utf8',env:{...process.env,NODE_ENV:'production'},timeout:120000});
   fs.writeFileSync(path.join(evidenceDir,'synthetic-build.log'),result.stdout+result.stderr);
   if(result.status!==0)throw Error('Synthetic build failed: '+result.stderr.slice(-500));
 }
 proxy=http.createServer((req,res)=>{
   const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
   if(!backendUp){res.writeHead(503);res.end();return;}
   const requestFile=path.join(out,pathname);
   if(!requestFile.startsWith(out+'/') && requestFile!==out){res.writeHead(404);res.end();return;}
   const file=fs.existsSync(requestFile)&&fs.statSync(requestFile).isFile()?requestFile:path.join(out,'index.html');
   if(!fs.existsSync(file)){res.writeHead(503);res.end();return;}
   res.setHeader('content-type',({'.webmanifest':'application/manifest+json','.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');
   res.setHeader('cache-control','no-cache');
   res.end(req.method==='HEAD'?undefined:fs.readFileSync(file));
 });
 await new Promise(resolve=>proxy.listen(ports.app,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+ports.app;
 write('runtime.json',{project,internalPorts:ports,browserPorts:external,url,backend,staff});
 return {admin,app,db,accounts,stores,product,url,ports:external,close,staff,backend,build,gateEvents,setReachable:ok=>{
   if(backendUp===ok)return;
   backendUp=ok;gateEvents.push({atUTC:new Date().toISOString(),reachable:ok,terminatedTransportSockets:ok?0:sockets.size});
   if(!ok)for(const socket of sockets)socket.destroy();
 }};
 }catch(e){await close();throw e}
}
