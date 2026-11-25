import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';import assert from 'node:assert/strict';
import {useTableOrder,type TableOrder} from '../frontend/lib/tables/useTableOrder';
let captured:TableOrder;let locked=true;
function Probe(){captured=useTableOrder('synthetic-cashier','HCLGB7BRuIxp9gLjDdca','DINE_IN',locked);return null}
const render=()=>renderToStaticMarkup(React.createElement(MemoryRouter,{initialEntries:['/pos?table=T04']},React.createElement(Probe)));
render();await captured!.execute({action:'PAY_BEGIN',opId:'synthetic-op',sessionId:'synthetic-session',version:1});assert.equal((globalThis as any).__tableBoundaryCalls||0,0);
assert.equal(captured!.externalLocked,true);assert.equal(captured!.canEdit,false);
locked=false;render();await captured!.execute({action:'PAY_BEGIN',opId:'synthetic-op',sessionId:'synthetic-session',version:1});assert.equal((globalThis as any).__tableBoundaryCalls,1);
console.log('PASS: actual composed hook refuses all writes before API boundary under external counter lock; negative control reaches throwing-only boundary. No successful table action stubs.');
