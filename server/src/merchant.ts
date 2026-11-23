const TRANSFER_PATTERNS: RegExp[] = [
  /^(?:transfer|payment|money added) from\s+(.+)$/i,
  /^from\s+(.+)$/i,
  /^(?:transfer|payment) to\s+(.+)$/i,
  /^to\s+(.+)$/i,
];

/** Extract a person/account name from transfer descriptions like "Transfer from John Doe". */
export function extractCounterparty(type: string, description: string): string | null {
  if (!/TRANSFER|TOPUP/i.test(type)) return null;
  for (const re of TRANSFER_PATTERNS) {
    const m = re.exec(description.trim());
    if (m?.[1]) return titleCase(m[1].trim());
  }
  return null;
}

const PROCESSOR_PREFIX = /^(?:sumup|zettle|sq|izettle|paypal|ccv|mollie|stripe|pp|sp)\s*[*_]\s*/i;

/**
 * Reduce a raw description to a merchant name that stays the same across visits:
 * "SumUp *Coffee Lab 0231" -> "Coffee Lab", "Albert Heijn 1234" -> "Albert Heijn",
 * "Uber *Trip Help.Uber.Com" -> "Uber Trip".
 */
export function normalizeMerchant(description: string): { name: string; key: string } {
  let s = description.trim().replace(PROCESSOR_PREFIX, '');
  // "Uber *Eats" -> "Uber Eats", but "Amzn Mktp *2K4L1" -> "Amzn Mktp" (ids after * vary per purchase)
  s = s.replace(/\s*\*\s*(\S*).*$/, (_, w: string) => (/^\p{L}{3,}$/u.test(w) ? ` ${w}` : ''));
  s = s.replace(/\s+(?:[A-Z]{2}\s*)?#?\d[\d\s-]*$/i, ''); // trailing store numbers
  s = s.replace(/\s+(?:b\.?v\.?|gmbh|ltd|s\.?a\.?|s\.?r\.?l\.?|inc|llc)\.?$/i, '');
  s = s.replace(/\s{2,}/g, ' ').trim() || description.trim();
  return { name: s, key: s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}
