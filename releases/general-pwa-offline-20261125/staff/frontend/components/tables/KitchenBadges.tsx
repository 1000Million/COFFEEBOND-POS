import {useEffect,useState} from 'react';
import {collection,onSnapshot,query,where} from 'firebase/firestore';
import {db} from '../../lib/firebase';
import {TABLE_STORE,validPosStoreId} from '../../lib/tables/api';
export default function KitchenBadges({sessionId,storeId=TABLE_STORE}:{sessionId:string;storeId?:string}) {
 const [counts,setCounts]=useState<Record<string,number>|null>(null);
 useEffect(()=>{setCounts(null);if(!validPosStoreId(storeId))return;let current=true;const stop=onSnapshot(query(collection(db,'kotItems'),where('storeId','==',storeId),where('tableSessionId','==',sessionId)),s=>{if(!current)return;const next:Record<string,number>={PENDING:0,PREPARING:0,READY:0};s.docs.forEach(d=>{const x=d.data();next[x.status]=(next[x.status]||0)+Number(x.quantity||0)});setCounts(next)},()=>{if(current)setCounts(null)});return()=>{current=false;stop()}},[storeId,sessionId]);
 return <div className="table-badges" aria-live="polite">{counts===null?<span>Kitchen updates unavailable</span>:<><span>Waiting {counts.PENDING}</span><span>Preparing {counts.PREPARING}</span><span>Ready {counts.READY}</span></>}</div>;
}
