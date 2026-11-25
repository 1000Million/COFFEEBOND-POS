import {auth} from '../firebase';
import {resumeDesktopClock} from './desktopClock';
import {observe,establishStationAuthority} from './authority';
import {digest,sign,type Snapshot} from './journal';
import {stationRequest} from './localPrint';

// Provisioned outside the browser and embedded in this release. Rotation requires
// verification of the station's new public identity and a new Staff release.
const sector51='L0qB13uuPxHvv089YtGQ';
const productionStation='fb42ab9b-2c9b-4264-a81c-4a8364ffd818';
const productionPin='e7b1ba66815ab5495a1d4a0032d506bb0afb2039849039587c786baf221fa912';
const localTest=import.meta.env.VITE_OFFLINE_LOCAL_ONLY==='true'
  && import.meta.env.VITE_FIREBASE_PROJECT_ID==='demo-coffee-bond-offline' && location.hostname==='127.0.0.1';
type StationSnapshot=Snapshot & {printStationPublicKey?:string};
let pending:{id:string;job:Promise<void>}|null=null;
let failedAt=-Infinity;
const unavailable='Reconnect to authorize new Cash. The original offline session clock is unavailable. Saved bills and receipts are available.';

async function attest(snapshot:StationSnapshot) {
 const expectedId=localTest?import.meta.env.VITE_TILL_TEST_STATION_ID:productionStation;
 const pin=localTest?import.meta.env.VITE_TILL_TEST_STATION_PIN:productionPin;
 if(!pin || snapshot.storeId!==sector51 || snapshot.tableWorkflowVersion!==1 || !snapshot.printStationPublicKey
   || !snapshot.printStationId || snapshot.printStationId!==expectedId || snapshot.tableOwnership?.deviceId!==snapshot.deviceId
   || snapshot.tableOwnership?.storeId!==sector51 || document.visibilityState!=='visible' || auth.currentUser?.uid!==snapshot.uid) throw Error(unavailable);
 const der=Uint8Array.from(atob(snapshot.printStationPublicKey.replace(/-----[^-]+-----|\s/g,'')),ch=>ch.charCodeAt(0));
 const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',der)),n=>n.toString(16).padStart(2,'0')).join('');
 if(actual!==pin)throw Error(unavailable);
 const nonce=crypto.randomUUID(), snapshotDigest=await digest(snapshot);
 const challenge={action:'RESUME',nonce,snapshotId:snapshot.id,snapshotDigest,uid:snapshot.uid,storeId:sector51,deviceId:snapshot.deviceId};
 const signature=await sign(challenge);
 const started=observe();
 const reply=await stationRequest('resume',{challenge,signature},snapshot,nonce);
 if(reply.state!=='RESUMED' || reply.nonce!==nonce || reply.snapshotId!==snapshot.id || reply.snapshotDigest!==snapshotDigest
   || reply.uid!==snapshot.uid || reply.storeId!==sector51 || reply.deviceId!==snapshot.deviceId || reply.stationId!==expectedId
   || reply.expiresAt!==snapshot.expiresAt || document.visibilityState!=='visible' || auth.currentUser?.uid!==snapshot.uid) throw Error(unavailable);
 establishStationAuthority(snapshot,started,reply.serverTime);
}
export function resumeOfflineSession(snapshot:Snapshot):Promise<void> {
 if(pending?.id===snapshot.id)return pending.job;
 if(pending || performance.now()-failedAt<5000)return Promise.reject(Error(unavailable));
 const job=resumeDesktopClock(snapshot).catch(() => {
   if (!snapshot.printStationId) throw Error(unavailable);
   return attest(snapshot);
 }).catch(()=>{failedAt=performance.now();throw Error(unavailable);}).finally(()=>{pending=null;});
 pending={id:snapshot.id,job};return job;
}
