/** Parse a decimal string like "-12.34", "1,234.5" or "12" into integer cents. */
export function parseCents(input: string): number {
  let s = input.trim().replace(/\s/g, '');
  if (s === '') return 0;
  // "1.234,56" (comma decimal) -> "1234.56"; "1,234.56" -> "1234.56"
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`Not a number: ${input}`);
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2] || '0');
  const frac = Number(((m[3] ?? '') + '00').slice(0, 2));
  const extra = (m[3] ?? '').length > 2 && Number(m[3]![2]) >= 5 ? 1 : 0;
  return sign * (whole * 100 + frac + extra) + 0; // + 0 turns -0 into 0
}

export function formatCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100);
}
