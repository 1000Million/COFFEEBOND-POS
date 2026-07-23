import React, { useMemo, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import type { AddOnSelection } from '../../types';
import type { AddOnGroup } from '../../types/menu-management';
import {
  AddOnQuantityByOption,
  buildAddOnSelections,
  validateAddOnQuantities,
} from '../../lib/addOns';

type Props = {
  productName: string;
  basePrice: number;
  taxRate: number;
  groups: AddOnGroup[];
  initialSelections?: AddOnSelection[];
  mode?: 'POS' | 'CUSTOMER';
  onCancel: () => void;
  onConfirm: (addOns: AddOnSelection[]) => void;
};

function initialQuantities(groups: AddOnGroup[], selections: AddOnSelection[]): Record<string, AddOnQuantityByOption> {
  const result: Record<string, AddOnQuantityByOption> = {};
  groups.forEach(group => {
    if (!group.id) return;
    result[group.id] = {};
  });
  selections.forEach(selection => {
    if (!result[selection.groupId]) result[selection.groupId] = {};
    result[selection.groupId][selection.optionId] = selection.quantity;
  });
  return result;
}

export default function AddOnSelector({
  productName,
  basePrice,
  taxRate,
  groups,
  initialSelections = [],
  mode = 'POS',
  onCancel,
  onConfirm,
}: Props) {
  const [quantities, setQuantities] = useState<Record<string, AddOnQuantityByOption>>(
    () => initialQuantities(groups, initialSelections),
  );

  const validation = useMemo(() => groups.map(group => ({
    group,
    result: validateAddOnQuantities(group, quantities[group.id || ''] || {}),
  })), [groups, quantities]);
  const selections = useMemo(
    () => buildAddOnSelections(groups, quantities, taxRate),
    [groups, quantities, taxRate],
  );
  const addOnValue = selections.reduce((sum, selection) => sum + selection.totalPrice, 0);
  const isValid = validation.every(entry => entry.result.ok);

  const updateQuantity = (group: AddOnGroup, optionId: string, delta: number) => {
    const groupId = group.id || '';
    setQuantities(current => {
      const groupQuantities = current[groupId] || {};
      const nextValue = Math.max(0, (groupQuantities[optionId] || 0) + delta);
      const nextGroup = { ...groupQuantities, [optionId]: nextValue };
      if (group.selectionMode === 'SINGLE' && nextValue > 0) {
        Object.keys(nextGroup).forEach(id => {
          if (id !== optionId) nextGroup[id] = 0;
        });
      }
      return { ...current, [groupId]: nextGroup };
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
      <button type="button" aria-label="Close add-on selector" className="absolute inset-0" onClick={onCancel} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Choose add-ons for ${productName}`}
        className={`relative z-10 flex max-h-[90dvh] w-full flex-col overflow-hidden bg-[#fffdf9] shadow-2xl ${
          mode === 'CUSTOMER'
            ? 'rounded-t-[28px] sm:max-w-lg sm:rounded-[28px]'
            : 'rounded-t-3xl sm:max-w-xl sm:rounded-3xl'
        }`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[#eadfd4] px-5 py-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.14em] text-[#8a6a58]">Customise item</p>
            <h2 className="mt-1 text-xl font-black text-[#2d1c19]">{productName}</h2>
            <p className="mt-1 text-sm font-bold text-neutral-500">
              ₹{basePrice.toFixed(2)} + ₹{addOnValue.toFixed(2)} add-ons
            </p>
          </div>
          <button type="button" onClick={onCancel} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f5efe7] text-[#5c4033]" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {groups.map(group => {
            const validationEntry = validation.find(entry => entry.group.id === group.id);
            return (
              <div key={group.id}>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="font-black text-[#2d1c19]">{group.name}</h3>
                    <p className="text-xs font-bold text-neutral-500">
                      {group.minimumSelections ? `Choose at least ${group.minimumSelections}` : 'Optional'}
                      {group.maximumSelections !== null && group.maximumSelections !== undefined
                        ? ` · Up to ${group.maximumSelections}`
                        : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuantities(current => ({ ...current, [group.id || '']: {} }))}
                    className="text-xs font-black text-[#8a6a58]"
                  >
                    No add-on
                  </button>
                </div>
                <div className="divide-y divide-[#efe5dc] overflow-hidden rounded-2xl border border-[#eadfd4] bg-white">
                  {(group.options || []).map(option => {
                    const quantity = quantities[group.id || '']?.[option.id] || 0;
                    return (
                      <div key={option.id} className="flex min-h-14 items-center justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-black text-[#2d1c19]">{option.name}</p>
                          <p className="text-xs font-bold text-neutral-500">+₹{Number(option.price || 0).toFixed(2)}</p>
                        </div>
                        <div className="inline-flex shrink-0 items-center rounded-full border border-[#eadfd4] bg-[#fffdf9] p-1">
                          <button
                            type="button"
                            onClick={() => updateQuantity(group, option.id, -1)}
                            disabled={quantity === 0}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[#5c4033] disabled:opacity-30"
                            aria-label={`Remove ${option.name}`}
                          >
                            <Minus size={15} />
                          </button>
                          <span className="w-7 text-center text-sm font-black">{quantity}</span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(group, option.id, 1)}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#5c4033] text-white"
                            aria-label={`Add ${option.name}`}
                          >
                            <Plus size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {validationEntry && !validationEntry.result.ok && (
                  <p className="mt-2 text-xs font-bold text-red-600">{validationEntry.result.message}</p>
                )}
              </div>
            );
          })}
        </div>

        <footer className="border-t border-[#eadfd4] bg-white p-4">
          <button
            type="button"
            disabled={!isValid}
            onClick={() => onConfirm(selections)}
            className="min-h-12 w-full rounded-2xl bg-[#4a3026] px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {initialSelections.length > 0 ? 'Update item' : 'Add item'} · ₹{(basePrice + addOnValue).toFixed(2)}
          </button>
        </footer>
      </section>
    </div>
  );
}
