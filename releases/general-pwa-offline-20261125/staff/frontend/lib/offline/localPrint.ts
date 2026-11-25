import {getMeta,putMeta,stable,type Entry,type Snapshot} from './journal';

type PrintSnapshot=Snapshot & {printStationId?:string;printStationPublicKey?:string};
type JobResult={id:string;channel:string;state:string};
export type PrintResult={state:'SPOOLED'|'OUTCOME_UNCERTAIN'|'UNAVAILABLE'|'NOT_APPLICABLE';message:string;jobs?:JobResult[]};
const testPort=Number(import.meta.env.VITE_TILL_TEST_PRINT_PORT);
const printPort=location.hostname==='127.0.0.1' && Number.isInteger(testPort) && testPort>=1024 && testPort<=65535 ? testPort : 43869;
const endpoint=`http://127.0.0.1:${printPort}/v1/till-print`;
const decode=(text:string)=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const utf8=new TextEncoder();
const protocol='coffee-bond/till-print/1';
function encode(bytes:Uint8Array){
  const parts:string[]=[];
  for(let i=0;i<bytes.length;i+=16384)parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(parts.join(''));
}
async function post(message:unknown,signal:AbortSignal){
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),
    credentials:'omit',cache:'no-store',redirect:'error',signal});
  if(!response.ok)throw Error('Station unavailable or local authorization expired.');
  return response.json();
}
async function verified(key:CryptoKey,action:string,nonce:string,proof:{result:any;signature:string}){
  const message=utf8.encode(stable({protocol,action,nonce,result:proof.result}));
  if(!await crypto.subtle.verify('Ed25519',key,decode(proof.signature),message))throw Error('Station identity could not be verified.');
  return proof.result;
}
export async function stationRequest(action:'prepare'|'ready'|'print'|'resume',body:Record<string,unknown>,snapshot:PrintSnapshot,nonce:string=crypto.randomUUID()) {
  if(!snapshot.printStationPublicKey || !snapshot.printStationId)throw Error('No authorized local printer assignment.');
  const control=new AbortController();
  const timer=setTimeout(()=>control.abort(),action==='print'?65000:(action==='ready'||action==='resume')?2000:17000);
  try{
    const identity=await crypto.subtle.importKey('spki',decode(snapshot.printStationPublicKey.replace(/-----[^-]+-----|\s/g,'')),'Ed25519',false,['verify']);
    const helloNonce=crypto.randomUUID();
    const hello=await verified(identity,'hello',helloNonce,await post({action:'hello',nonce:helloNonce},control.signal));
    if(hello.stationId!==snapshot.printStationId)throw Error('Station binding differs.');
    const peer=await crypto.subtle.importKey('raw',decode(hello.publicKey),{name:'ECDH',namedCurve:'P-256'},false,[]);
    const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
    const secret=await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256);
    const material=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:utf8.encode(nonce),info:utf8.encode(protocol+'/aes-gcm')},
      material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const auth=(direction:string)=>utf8.encode(JSON.stringify([protocol,action,nonce,direction]));
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:auth('request')},key,utf8.encode(JSON.stringify(body)));
    const publicKey=await crypto.subtle.exportKey('raw',ephemeral.publicKey);
    const box=await post({action,nonce,box:{iv:encode(iv),publicKey:encode(new Uint8Array(publicKey)),ciphertext:encode(new Uint8Array(ciphertext))}},control.signal);
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(box.iv),additionalData:auth('response')},key,decode(box.ciphertext));
    return await verified(identity,action,nonce,JSON.parse(new TextDecoder().decode(clear)));
  }finally{clearTimeout(timer);}
}
export async function prepareLocalPrint(snapshot:PrintSnapshot):Promise<boolean>{
  try{const result=await stationRequest('prepare',{snapshot},snapshot);return result.state==='READY' && result.snapshotId===snapshot.id;}catch{return false;}
}
export async function hasLocalPrintAuthority(snapshot:PrintSnapshot):Promise<boolean>{
  try{const result=await stationRequest('ready',{snapshotId:snapshot.id},snapshot);return result.state==='READY' && result.snapshotId===snapshot.id;}catch{return false;}
}
export const savedPrintStatus=(id:string):Promise<PrintResult|undefined>=>getMeta('localPrint/'+id);
export async function printSavedEntry(entry:Entry):Promise<PrintResult>{
  if(entry.payload.printAuthority!=='DESIGNATED_TILL')return {state:'NOT_APPLICABLE',message:'Local printing was unavailable for this operation.'};
  let status:PrintResult;
  try{
    const snapshot:PrintSnapshot|undefined=await getMeta('snapshot');
    if(!snapshot||snapshot.id!==entry.payload.snapshotId||snapshot.printStationId!==entry.payload.printStationId)throw Error('Original station binding is required.');
    const outcome=await stationRequest('print',{entry:{id:entry.id,payload:entry.payload,signature:entry.signature}},snapshot);
    if(outcome.entryId!==entry.id||!Array.isArray(outcome.jobs)||!['SPOOLED','OUTCOME_UNCERTAIN','UNAVAILABLE','NOT_APPLICABLE'].includes(outcome.state))throw Error('Unrecognized station response.');
    status={state:outcome.state,jobs:outcome.jobs,message:outcome.state==='SPOOLED'?'Submitted to the local print queue.':outcome.state==='UNAVAILABLE'?'One or more local queues were unavailable. Review the job status.':outcome.state==='NOT_APPLICABLE'?'No print jobs for this operation.':'Print outcome uncertain. Check the station before any reprint.'};
  }catch{status={state:'OUTCOME_UNCERTAIN',message:'Station acknowledgement unavailable. Check the station before any reprint.'};}
  try{await putMeta('localPrint/'+entry.id,status);}catch{return {...status,message:status.message+' Print status could not be saved on this browser.'};}
  return status;
}
