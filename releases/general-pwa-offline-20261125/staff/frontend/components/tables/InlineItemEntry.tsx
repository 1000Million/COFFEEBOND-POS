import {useId,useState} from 'react';
import type {MenuItem} from '../../types';
export default function InlineItemEntry({search,onAdd,disabled=false}:{search:(query:string)=>MenuItem[];onAdd:(item:MenuItem)=>void;disabled?:boolean}) {
 const id=useId();const [value,setValue]=useState(''),[open,setOpen]=useState(false),[index,setIndex]=useState(0),[limit,setLimit]=useState(12);
 const matches=value.trim()?search(value):[];const suggestions=matches.slice(0,limit);
 const pick=(item:MenuItem)=>{if(disabled)return;onAdd(item);setValue('');setIndex(0);setOpen(false)};
 return <div className="inline-item-entry" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false)}}>
  <label htmlFor={id}>Add item — type name or code…</label>
  <input id={id} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open&&suggestions.length>0} aria-controls={id+'-options'} aria-activedescendant={open&&suggestions[index]?id+'-'+index:undefined} disabled={disabled} placeholder="Name or code" value={value} onFocus={()=>setOpen(true)} onChange={e=>{setValue(e.target.value);setIndex(0);setLimit(12);setOpen(true)}} onKeyDown={e=>{if(['Enter','Escape','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation()}if(e.key==='Escape'){setOpen(false);return}if(e.key==='ArrowDown'||e.key==='ArrowUp'){setOpen(true);setIndex(i=>Math.max(0,Math.min(suggestions.length-1,i+(e.key==='ArrowDown'?1:-1))));return}if(e.key==='Enter'&&!e.repeat&&open&&suggestions[index])pick(suggestions[index])}}/>
  {open&&value.trim()&&<div className="inline-item-suggestions"><div role="listbox" id={id+'-options'} aria-label="Matching catalogue items">{suggestions.map((item,i)=><button type="button" role="option" aria-selected={i===index} id={id+'-'+i} key={(item as any).tableProductId||item.id} onClick={()=>pick(item)}><strong>{item.name}</strong><span>{item.code} · ₹{Number(item.price).toFixed(2)} · {(item as any).posCategoryName||(item as any).categoryName||'Menu'}{item.addOnGroupIds?.length?' · Choose options':''}</span></button>)}</div>{matches.length===0?<p>No matching available items</p>:matches.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+12)}>Show more matches ({matches.length})</button>}</div>}
 </div>;
}
