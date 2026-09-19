import { addMinor, assertPositive, mulMinor, MoneyError, toMinorUnits } from './money.js';

/** SDD BI-05 and section 10. Totals are ALWAYS computed here, from the lines, and never accepted from a caller. */
export const MAX_LINES = 100;
export const MAX_QUANTITY = 2_147_483_647; // the `integer` column; quantities are integers only in v1 (B-034)

export interface LineInput {
  quantity: number;
  unitAmount: bigint;
}

export interface ComputedLine {
  lineNumber: number;
  quantity: number;
  unitAmount: bigint;
  lineTotal: bigint;
  taxAmount: bigint;
}

export interface InvoiceTotals {
  lines: ComputedLine[];
  subtotal: bigint;
  taxTotal: bigint;
  total: bigint;
}

/**
 * subtotal = sum of line totals; taxTotal = sum of line taxes; total = subtotal + taxTotal. No tax is determined in v1 (B-006), so
 * every line's tax is 0 and taxTotal is 0. There are no discounts or adjustments (B-033): every line total is quantity x unit amount.
 */
export function computeTotals(lines: LineInput[]): InvoiceTotals {
  if (lines.length < 1 || lines.length > MAX_LINES) throw new MoneyError(`an invoice has between 1 and ${MAX_LINES} lines`);
  let subtotal = 0n;
  const computed = lines.map((l, i): ComputedLine => {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) throw new MoneyError(`line ${i + 1}: quantity must be an integer from 1 to ${MAX_QUANTITY}`);
    const unitAmount = assertPositive(toMinorUnits(l.unitAmount, `line ${i + 1} unit amount`), `line ${i + 1} unit amount`);
    const lineTotal = mulMinor(BigInt(l.quantity), unitAmount, `line ${i + 1} total`);
    subtotal = addMinor(subtotal, lineTotal, 'subtotal');
    return { lineNumber: i + 1, quantity: l.quantity, unitAmount, lineTotal, taxAmount: 0n };
  });
  const taxTotal = 0n;
  return { lines: computed, subtotal, taxTotal, total: addMinor(subtotal, taxTotal, 'total') };
}
