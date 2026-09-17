/** Price conversions shared by every book's normalizer. */

export function americanFromDecimal(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return -Math.round(100 / (decimal - 1));
}

export function decimalFromAmerican(american: number): number {
  const d = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return roundDecimal(d);
}

/** Three decimals is enough to keep every book's price distinct without floating-point noise. */
export function roundDecimal(decimal: number): number {
  return Math.round(decimal * 1000) / 1000;
}
