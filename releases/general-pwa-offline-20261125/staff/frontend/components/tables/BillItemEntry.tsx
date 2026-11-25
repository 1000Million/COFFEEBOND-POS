import {useEffect,useId,useRef,useState} from 'react';
import {ChevronRight,Keyboard,Search} from 'lucide-react';
import type {MenuItem} from '../../types';

export default function BillItemEntry({search,onAdd,disabled=false,onViewMenu}:{
 search:(query:string)=>MenuItem[];onAdd:(item:MenuItem)=>void;disabled?:boolean;onViewMenu:()=>void;
}) {
 const id=useId(),list=useRef<HTMLDivElement>(null);
 const [value,setValue]=useState(''),[open,setOpen]=useState(false),[index,setIndex]=useState(0),[limit,setLimit]=useState(12);
 const matches=value.trim()?search(value):[],suggestions=matches.slice(0,limit);
 useEffect(()=>{if(open)list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[index,open]);
 const pick=(item:MenuItem)=>{if(disabled)return;onAdd(item);setValue('');setIndex(0);setOpen(false);};
 return <div className="inline-item-entry bill-item-entry" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <label htmlFor={id} className="sr-only">Type item name or code</label>
  <div className="bill-search-field"><Search size={20} aria-hidden="true"/>
   <input id={id} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open&&suggestions.length>0} aria-controls={id+'-options'} aria-activedescendant={open&&suggestions[index]?id+'-'+index:undefined} disabled={disabled} placeholder="Type item name or code" value={value}
    onFocus={()=>setOpen(true)} onChange={e=>{setValue(e.target.value);setIndex(0);setLimit(12);setOpen(true);}}
    onKeyDown={e=>{
     if(['Enter','Escape','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();}
     if(e.key==='Escape'){setOpen(false);return;}
     if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      setOpen(true);if(e.key==='ArrowDown'&&index===suggestions.length-1&&matches.length>limit)setLimit(n=>n+12);
      setIndex(i=>Math.max(0,Math.min(matches.length-1,i+(e.key==='ArrowDown'?1:-1))));return;
     }
     if(e.key==='Enter'&&!e.repeat&&open&&suggestions[index])pick(suggestions[index]);
    }}/><Keyboard size={20} aria-hidden="true"/>
  </div>
  {open&&value.trim()&&<div className="inline-item-suggestions">
   <div className="bill-suggestion-heading">Suggestions <span>↑ ↓ · Enter to add</span></div>
   <div ref={list} role="listbox" id={id+'-options'} aria-label="Matching catalogue items">{suggestions.map((item,i)=><button type="button" role="option" aria-selected={i===index} id={id+'-'+i} key={(item as any).tableProductId||item.id} onClick={()=>pick(item)}>
    <span className="bill-suggestion-name"><strong>{item.name}</strong><span>{item.code}{item.addOnGroupIds?.length?' · Choose options':''}</span></span>
    <b className="bill-suggestion-price">₹{Number(item.price).toFixed(2)}</b>
   </button>)}</div>
   {matches.length===0?<p>No matching available items</p>:matches.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+12)}>Show more matches ({matches.length})</button>}
   <button type="button" className="bill-menu-link" onClick={onViewMenu}>View full menu <ChevronRight size={18} aria-hidden="true"/></button>
  </div>}
  {!(open&&value.trim())&&<button type="button" className="bill-menu-shortcut" onClick={onViewMenu}>View full menu <ChevronRight size={15} aria-hidden="true"/></button>}
 </div>;
}
