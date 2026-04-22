export type PositiveFlowKind = 'payment' | 'credit';

const PAYMENT_PATTERNS = [
  /\bonline payment\b/,
  /\bpayment received\b/,
  /\bpayment thank you\b/,
  /\bautopay\b/,
  /\bauto pay\b/,
  /\btransfer\b/,
  /\be-?transfer\b/,
  /\bach\b/,
  /\bbill payment\b/,
  /\bweb payment\b/,
  /\bpre-authorized payment\b/,
  /\bpayment\b/,
];

const CREDIT_PATTERNS = [
  /\brefund\b/,
  /\breturn(?:ed)?\b/,
  /\breversal\b/,
  /\bstatement credit\b/,
  /\breward\b/,
  /\bcash ?back\b/,
  /\bcredit\b/,
  /\badjustment\b/,
  /\breimbursement\b/,
];

function normalizeText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part) => part != null && part !== '')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function classifyPositiveFlow(input: {
  merchantRaw?: string | null;
  merchantClean?: string | null;
  category?: string | null;
}): PositiveFlowKind {
  const text = normalizeText([
    input.merchantRaw,
    input.merchantClean,
    input.category,
  ]);
  if (!text) return 'credit';
  if (PAYMENT_PATTERNS.some((re) => re.test(text))) return 'payment';
  if (CREDIT_PATTERNS.some((re) => re.test(text))) return 'credit';
  return 'credit';
}
