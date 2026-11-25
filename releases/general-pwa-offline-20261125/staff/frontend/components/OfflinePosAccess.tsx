import {useEffect,useState} from 'react';
import {usePosOnline} from '../lib/pos/usePosOnline';
import {getMeta,verifySnapshotForRead,type Snapshot} from '../lib/offline/journal';
import {supportedOfflineSnapshot} from '../lib/offline/tableRepository';
import {auth} from '../lib/firebase';
import type {StaffProfile} from '../types';
import {DisconnectedPosProfile} from '../contexts/AuthContext';
import AppLoading from './AppLoading';
import OfflineDraftRecovery from './OfflineDraftRecovery';
import POSHome from '../pages/pos/POSHome';

// Mounted only on /pos while the signed-in user's live profile is still loading.
// The scoped profile is passed only to the disconnected POS, never to route guards.
export default function OfflinePosAccess({uid}:{uid:string}){
  const online=usePosOnline();
  const [state,setState]=useState<{uid:string;profile?:StaffProfile;reason?:string}|null>(null);
  useEffect(()=>{
    if(online)return;
    let active=true;
    const load=async()=>{
      try{
        const s:Snapshot|undefined=await getMeta('snapshot');
        if(!s || !supportedOfflineSnapshot(s) || s.uid!==uid || !['CASHIER','STORE_MANAGER','ADMIN'].includes(s.role))
          throw Error('This account has no signed offline authorization for this device and store.');
        await verifySnapshotForRead(s);
        if(!active || auth.currentUser?.uid!==uid)return;
        const name=auth.currentUser.displayName || 'Staff';
        setState({uid,profile:{uid,name,displayName:name,email:auth.currentUser.email || '',role:s.role as StaffProfile['role'],
          isActive:true,storeIds:[s.storeId],assignedStoreIds:[s.storeId],createdAt:null,updatedAt:null}});
      }catch(error){if(active)setState({uid,reason:error instanceof Error?error.message:'The saved till authorization could not be verified.'});}
    };
    void load();
    return()=>{active=false;};
  },[uid,online]);
  if(online || state?.uid!==uid)return <AppLoading/>;
  return state.profile ? <DisconnectedPosProfile profile={state.profile}><POSHome offlineProfile={state.profile}/></DisconnectedPosProfile> : <OfflineDraftRecovery uid={uid} reason={state.reason}/>;
}
