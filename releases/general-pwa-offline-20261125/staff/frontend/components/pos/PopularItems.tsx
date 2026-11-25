import { Plus } from 'lucide-react';
import type { MenuItem } from '../../types';
import type { PosPopularity } from '../../lib/pos/usePosPopularity';

type Props = {
  data?: PosPopularity;
  loading: boolean;
  items: MenuItem[];
  quantityByItemId: ReadonlyMap<string, number>;
  onAddItem: (item: MenuItem) => void;
};

export default function PopularItems({ data, loading, items, quantityByItemId, onAddItem }: Props) {
  // Preserve the reporting order and quantities within the caller's eligible,
  // store-filtered menu. Never substitute unranked menu items.
  const byId = new Map(items.map(item => [item.id, item]));
  const rows = (data?.items || []).filter(row => byId.has(row.productId));
  if (loading || !data || rows.length === 0) return null;

  return (
    <section aria-label="Popular at this store" className="mb-4 rounded-2xl border border-[#eadfd4] bg-[#fff8ed] p-3">
      <h2 className="text-sm font-black text-[#3e2723]">Popular at this store</h2>
      <p className="mt-1 text-xs text-neutral-600">{data.startDate} to {data.endDate} · 30 complete IST business dates · ranked by eligible quantity sold</p>
      <div className="mt-2 flex min-h-[104px] gap-2 overflow-x-auto pb-2">
        {rows.map(row => {
          const item = byId.get(row.productId)!;
          const quantity = quantityByItemId.get(item.id) || 0;
          return (
            <button key={row.productId} type="button" onClick={() => onAddItem(item)}
              className="min-h-[88px] w-36 shrink-0 rounded-xl border border-[#eadfd4] bg-white p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033]"
              aria-label={`Add popular ${item.name}, ₹${Number(item.price).toFixed(2)} each${quantity > 0 ? `, ${quantity} in current sale` : ''}`}>
              <span className="mb-1 flex items-center justify-between gap-1">
                {quantity > 0 && <span className="rounded-full bg-[#3e2723] px-2 py-1 text-[9px] font-black text-white">{quantity} in sale</span>}
                <Plus aria-hidden="true" size={15} className="ml-auto shrink-0 text-[#5c4033]" />
              </span>
              <strong className="block text-sm text-[#3e2723]">{item.name}</strong>
              <span className="mt-1 block text-xs text-neutral-600">{row.quantitySold} sold · ₹{Number(item.price).toFixed(2)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
