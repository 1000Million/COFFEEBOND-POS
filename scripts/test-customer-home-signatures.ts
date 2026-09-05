import assert from 'node:assert/strict';
import { selectCustomerHomeSignatures } from '../frontend/lib/customerHomeSignatures';

type Item = {
  code: string;
  name: string;
  displayName?: string;
  available: boolean;
};

const menu: Item[] = [
  { code: 'BOND_FRAPPE', name: 'Bond Frappe', available: true },
  { code: 'ICED_VIETNAMESE', name: 'Iced Vietnamese', available: true },
  { code: 'MAGIK_TEAM_FAVORITE', name: 'Magik (Team Favorite)', displayName: 'Magik', available: true },
  { code: 'CAPPUCCINO', name: 'Cappuccino', available: true },
];

const orderable = (items: Item[]) => items.filter(item => item.available);

assert.deepEqual(
  selectCustomerHomeSignatures(orderable(menu)).map(item => item.code),
  ['BOND_FRAPPE', 'ICED_VIETNAMESE', 'MAGIK_TEAM_FAVORITE'],
  'available signatures should follow the owner-approved order',
);

assert.deepEqual(
  selectCustomerHomeSignatures(orderable(menu.map(item => (
    item.code === 'ICED_VIETNAMESE' ? { ...item, available: false } : item
  )))).map(item => item.code),
  ['BOND_FRAPPE', 'MAGIK_TEAM_FAVORITE'],
  'an unavailable signature must not remain selectable',
);

assert.deepEqual(
  selectCustomerHomeSignatures(orderable(menu.map(item => ({ ...item, available: false })))),
  [],
  'all unavailable signatures should produce the safe menu fallback state',
);

assert.deepEqual(
  selectCustomerHomeSignatures([
    { code: 'BOND_FRAPPE_COPY', name: 'Bond Frappe Special', available: true },
    { code: 'MAGIKAL', name: 'Magikal', available: true },
  ]),
  [],
  'similar names must not be promoted as signature products',
);

console.log('Customer Home signature selector tests passed (4 assertions).');
