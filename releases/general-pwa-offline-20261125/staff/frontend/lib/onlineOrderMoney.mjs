/** Round an order amount to the smallest supported INR display/settlement unit. */
export function roundOrderMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calculateOnlineOrderLineMoney({
  baseUnitPrice,
  selectedAddOnTotal,
  quantity,
  appliedTaxRate,
  addOnLineTax,
}) {
  const lineSubtotal = roundOrderMoney((baseUnitPrice + selectedAddOnTotal) * quantity);
  const lineTax = roundOrderMoney(
    baseUnitPrice * quantity * appliedTaxRate / 100 + addOnLineTax,
  );
  return {
    lineSubtotal,
    lineTaxable: lineSubtotal,
    lineTax,
    lineTotal: roundOrderMoney(lineSubtotal + lineTax),
  };
}

export function calculateOnlineOrderTotals(lines) {
  const subtotal = roundOrderMoney(lines.reduce((sum, line) => sum + line.lineSubtotal, 0));
  const taxableAmount = roundOrderMoney(lines.reduce((sum, line) => sum + line.lineTaxable, 0));
  const gstTotal = roundOrderMoney(lines.reduce((sum, line) => sum + line.lineTax, 0));
  const grandTotal = roundOrderMoney(taxableAmount + gstTotal);
  return { subtotal, taxableAmount, gstTotal, grandTotal };
}
