'use strict';

const { roundMoney } = require('./customerCheckoutCanonicalization');

function customerOrderLineMoney({
  baseUnitPrice,
  addOnUnitTotal,
  quantity,
  taxRate,
  addOns,
}) {
  const unitPrice = baseUnitPrice + addOnUnitTotal;
  const lineSubtotal = roundMoney(unitPrice * quantity);
  const baseLineTax = baseUnitPrice * quantity * taxRate / 100;
  const addOnLineTax = addOns.reduce((sum, addOn) => (
    sum + addOn.totalPrice * quantity * addOn.taxRate / 100
  ), 0);
  const lineTax = roundMoney(baseLineTax + addOnLineTax);
  return {
    unitPrice,
    lineSubtotal,
    lineTaxable: lineSubtotal,
    lineTax,
    lineTotal: roundMoney(lineSubtotal + lineTax),
  };
}

function customerOrderTotals(items) {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineSubtotal, 0));
  const taxableAmount = roundMoney(items.reduce((sum, item) => sum + item.lineTaxable, 0));
  const gstTotal = roundMoney(items.reduce((sum, item) => sum + item.lineTax, 0));
  const grandTotal = roundMoney(taxableAmount + gstTotal);
  return { subtotal, taxableAmount, gstTotal, grandTotal };
}

module.exports = {
  customerOrderLineMoney,
  customerOrderTotals,
};
