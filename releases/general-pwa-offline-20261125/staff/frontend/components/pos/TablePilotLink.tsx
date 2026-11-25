import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {useAuth} from '../../contexts/AuthContext';
import {validPosStoreId,tableCall} from '../../lib/tables/api';
export default function TablePilotLink({storeId}:{storeId:string}) {
 const{staffProfile}=useAuth();const[visible,setVisible]=useState(false);
 useEffect(()=>{let current=true;setVisible(false);if(validPosStoreId(storeId)&&staffProfile&&['ADMIN','STORE_MANAGER','CASHIER'].includes(staffProfile.role))void tableCall({storeId,action:'BOARD'}).then(b=>{if(current)setVisible(b.enabled||b.tables.some((t:any)=>t.session))}).catch(()=>{});return()=>{current=false}},[storeId,staffProfile?.uid,staffProfile?.role]);
 return visible?<Link className="rounded-full border border-[#eadfd4] bg-white px-4 py-2 text-sm font-bold text-[#3e2723]" to={'/pos/tables?tableStore='+encodeURIComponent(storeId)}>Tables · pilot</Link>:null;
}
