'use strict';
const {createHash,createPublicKey}=require('node:crypto');
const SECTOR51='L0qB13uuPxHvv089YtGQ';
const POLICY_PATH='offlinePilotPolicies/sector51';
const RECOVERY_PATH='offlinePilotRecovery/sector51';
const ENROLLMENT_PATH='offlineEnrollmentPolicies/sector51';
const ROLES=new Set(['ADMIN','STORE_MANAGER','CASHIER']);
function keyFingerprint(publicKey){
 if(publicKey?.kty!=='EC'||publicKey.crv!=='P-256'||publicKey.d)throw Error('Public P-256 key required');
 return createHash('sha256').update(createPublicKey({key:publicKey,format:'jwk'}).export({type:'spki',format:'der'})).digest('hex');
}
// Version 2 grants live under the exact store ID. A matching v2 document, even
// when disabled or malformed, always takes precedence over the legacy pilot.
async function resolveGrant(tx,db,collection,storeId) {
 const ref=db.collection(collection).doc(storeId);
 const scoped=await tx.get(ref);
 if(scoped.exists)return {policy:scoped.data(),version:2};
 if(storeId===SECTOR51)return {policy:(await tx.get(db.collection(collection).doc('sector51'))).data(),version:1};
 return {policy:null,version:2};
}
function approved(policy,{uid,role,storeId,deviceId,publicKey,offlineId,recovery=false},version=1){
 try{
  if(![1,2].includes(version)||(version===1&&storeId!==SECTOR51)||policy?.version!==version||policy.storeId!==storeId||policy.enabled!==true)return false;
  const a=policy.approval;if(!a||typeof a.reference!=='string'||a.reference.trim().length<8||typeof a.approvedBy!=='string'||!a.approvedBy.trim()||!Number.isFinite(a.approvedAt)||a.approvedAt<=0||a.approvedAt>Date.now())return false;
  if(!ROLES.has(role)||!Array.isArray(policy.approvedStaff)||!policy.approvedStaff.length||policy.approvedStaff.some(s=>!s||typeof s.uid!=='string'||!s.uid||!ROLES.has(s.role)))return false;
  if(!policy.approvedStaff.some(s=>s.uid===uid&&s.role===role))return false;
  const d=policy.approvedDevice;if(!d||typeof d.deviceId!=='string'||d.deviceId!==deviceId||typeof d.keyFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(d.keyFingerprint)||keyFingerprint(publicKey)!==d.keyFingerprint)return false;
  if(recovery&&(!['ADMIN','STORE_MANAGER'].includes(role)||!Array.isArray(policy.offlineIds)||!policy.offlineIds.length||policy.offlineIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))||!policy.offlineIds.includes(offlineId)))return false;
  return true;
 }catch{return false}
}
module.exports={SECTOR51,POLICY_PATH,RECOVERY_PATH,ENROLLMENT_PATH,keyFingerprint,approved,resolveGrant};
