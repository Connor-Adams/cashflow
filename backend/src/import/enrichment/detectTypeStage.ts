import type { Signal, TxnType } from './types';

const PATTERNS: Array<{ type: TxnType; re: RegExp; requireSign?: 'positive' | 'negative' }> = [
  { type: 'refund', re: /\b(refund|return(?:ed)?|reversal|chargeback)\b/i, requireSign: 'positive' },
  { type: 'payment', re: /\b(online payment|payment received|payment thank you|autopay|statement credit)\b/i },
  { type: 'transfer', re: /\b(transfer (?:to|from|in|out)|wire transfer|interac e?-?transfer)\b/i },
  { type: 'fee', re: /\b(annual fee|monthly fee|service fee|nsf fee|late fee|atm fee|fx fee|foreign transaction fee)\b/i },
  { type: 'interest', re: /\b(interest charge|interest on|finance charge)\b/i },
  { type: 'reward', re: /\b(cash ?back|reward|points redemption)\b/i, requireSign: 'positive' },
];

export interface DetectTypeInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
}

export function runDetectTypeStage(input: DetectTypeInput): Signal[] {
  const haystack = `${input.merchantRaw} ${input.merchantClean}`.trim();

  for (const p of PATTERNS) {
    if (!p.re.test(haystack)) continue;
    if (p.requireSign === 'positive' && input.amount <= 0) continue;
    if (p.requireSign === 'negative' && input.amount >= 0) continue;
    return [
      {
        source: 'type-detect',
        confidence: 'high',
        fields: { txnType: p.type },
        rationale: `narrative matched ${p.type}`,
      },
    ];
  }

  if (input.amount < 0) {
    return [
      {
        source: 'type-detect',
        confidence: 'medium',
        fields: { txnType: 'purchase' },
        rationale: 'negative amount with no narrative cue',
      },
    ];
  }

  return [
    {
      source: 'type-detect',
      confidence: 'low',
      fields: { txnType: 'unknown' },
      rationale: 'positive amount with no narrative cue',
    },
  ];
}
