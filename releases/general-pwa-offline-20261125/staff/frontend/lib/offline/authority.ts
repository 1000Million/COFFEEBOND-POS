// A live clock is never persisted. Cold continuation requires independently witnessed time for the original online lease.
type Lease={id:string;uid:string;deviceId:string;storeId?:string;issuedAt:number;expiresAt:number};
type Observation={wall:number;mono:number};
const MAX_AGE=8*60*60*1000,MAX_GAP=30000,CLOCK_TOLERANCE=1000;
export const observe=():Observation=>({wall:Date.now(),mono:performance.now()});
let live:{lease:Lease;start:Observation;received:number;serverBase:number;last:Observation}|null=null;
let reason='Session restarted. Reconnect and prepare before receiving new Cash. Saved bills and receipts remain available.';
let cold=true;
export const mayResumeAfterRestart=()=>cold && !live;
export function invalidateAuthority(message='Session timing became uncertain. Reconnect and prepare before receiving new Cash.'){cold=false;live=null;reason=message}
export function invalidateScope(uid:string,storeId:string) {
 if (live && live.lease.uid===uid && live.lease.storeId===storeId) invalidateAuthority('Offline permission was withdrawn. Reconnect and prepare this till.');
}
function interruptVisibleSession() {
 if (!live) return;
 invalidateAuthority('The till was inactive. Confirm its original session clock or reconnect before receiving Cash.');
 cold=true;
}
export function establishAuthority(lease:Lease,start:Observation){
 const now=observe(),elapsed=now.mono-start.mono;
 invalidateAuthority();
 if(!Number.isFinite(lease.issuedAt)||!Number.isFinite(lease.expiresAt)||lease.expiresAt<=lease.issuedAt||lease.expiresAt-lease.issuedAt>MAX_AGE||elapsed<0||elapsed>MAX_GAP||Math.abs((now.wall-start.wall)-elapsed)>CLOCK_TOLERANCE)throw Error(reason);
 live={lease:{...lease},start,received:now.mono,serverBase:lease.issuedAt,last:now};
}
// An independent clock measured elapsed time since the authenticated online grant.
export function establishStationAuthority(lease:Lease,start:Observation,serverTime:number) {
 const now=observe(),rtt=now.mono-start.mono;
 if(!mayResumeAfterRestart()||!Number.isFinite(serverTime)||!Number.isFinite(lease.issuedAt)||!Number.isFinite(lease.expiresAt)
   || !(lease.expiresAt>lease.issuedAt) || lease.expiresAt-lease.issuedAt>MAX_AGE
   || serverTime<lease.issuedAt || rtt<0 || rtt>2000 || serverTime+rtt>=lease.expiresAt
   || Math.abs(now.wall-start.wall-rtt)>CLOCK_TOLERANCE)
   throw Error('The session clock could not verify remaining offline billing time. Reconnect to prepare.');
 cold=false;
 live={lease:{...lease},start,received:now.mono,serverBase:serverTime,last:now};
}
function check(){
 if(!live)throw Error(reason);
 const now=observe(),elapsed=now.mono-live.start.mono,gap=now.mono-live.last.mono;
 if(elapsed<0||gap<0||gap>MAX_GAP||Math.abs((now.wall-live.start.wall)-elapsed)>CLOCK_TOLERANCE||elapsed>=live.lease.expiresAt-live.serverBase){invalidateAuthority('Authorization expired or device timing changed. Reconnect and prepare before receiving new Cash.');throw Error(reason)}
 live.last=now;return {lease:live.lease,serverTime:live.serverBase+(now.mono-live.received)};
}
export function authorizedTime(lease:Lease){const current=check();if(current.lease.id!==lease.id||current.lease.uid!==lease.uid||current.lease.deviceId!==lease.deviceId||current.lease.storeId!==lease.storeId){invalidateAuthority();throw Error(reason)}return current.serverTime}
if(typeof window!=='undefined'){
 setInterval(()=>{if(live)try{check()}catch{}},1000);
 window.addEventListener('pagehide',interruptVisibleSession);
 document.addEventListener('freeze',interruptVisibleSession);
 // Browser suspension cannot provide trustworthy elapsed time on every platform.
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')interruptVisibleSession()});
}
