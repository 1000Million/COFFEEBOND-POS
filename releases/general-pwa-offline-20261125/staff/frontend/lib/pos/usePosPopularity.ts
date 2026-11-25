import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
export type PosPopularity = { kind:'POS_POPULAR_ITEMS';status:'AVAILABLE';storeId:string;startDate:string;endDate:string;timeZone:string;generatedAt:string;items:Array<{productId:string;quantitySold:number}> };
const cache=new Map<string,{until:number;value:PosPopularity}>();
const inFlight=new Map<string,Promise<{data:PosPopularity}>>();
export function usePosPopularity(storeId:string, staffKey:string) {
  const scopeKey=staffKey+':'+storeId;
  const[state,setState]=useState<{storeId:string;scopeKey:string;data?:PosPopularity;loading:boolean}>({storeId:'',scopeKey:'',loading:false});
  useEffect(()=>{let active=true;if(!storeId||!staffKey)return;const key=scopeKey,hit=cache.get(key);
    if(hit&&hit.until>Date.now()){setState({storeId,scopeKey,data:hit.value,loading:false});return;}
    setState({storeId,scopeKey,loading:true});
    if(!inFlight.has(key)){const request=httpsCallable<{mode:string;storeId:string},PosPopularity>(functions,'getReportingSummary')({mode:'POS_POPULAR_ITEMS',storeId});inFlight.set(key,request);void request.finally(()=>inFlight.delete(key)).catch(()=>{});}
    inFlight.get(key)!.then(r=>{
      const d=r.data;if(d.kind!=='POS_POPULAR_ITEMS'||d.storeId!==storeId||d.status!=='AVAILABLE'||!Array.isArray(d.items)||d.items.length>10||new Set(d.items.map(i=>i.productId)).size!==d.items.length)throw Error('Invalid POS ranking');
      if(!d.items.every(i=>typeof i.productId==='string'&&Number.isFinite(i.quantitySold)&&i.quantitySold>0))throw Error('Invalid POS ranking');
      if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key,{until:Date.now()+5*60*1000,value:d});if(active)setState({storeId,scopeKey,data:d,loading:false});
    }).catch(()=>{if(active)setState({storeId,scopeKey,loading:false});});return()=>{active=false};
  },[storeId,staffKey,scopeKey]);
  return state.scopeKey===scopeKey?state:{storeId,scopeKey,loading:Boolean(storeId),data:undefined};
}
