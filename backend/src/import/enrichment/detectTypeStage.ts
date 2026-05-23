import type { Signal, TxnType } from './types';

// Order matters: patterns are tried top-down and the first match wins.
// `dividend` and `investment` must come BEFORE the generic positive/negative
// fallbacks below; `transfer` and `fee` come before the broader
// `purchase` default. The Wealthsimple-specific cues (Pre-authorized Debit,
// Cash sent, Subscription fee, Cash dividend distribution, "Bought N shares")
// were added when the bundle importer started routing the same descriptions
// through the regular /upload path — without them, every WS BUY/AFT_OUT/FEE
// row would default to 'purchase' and bloat the dashboard totalSpend metric.
const PATTERNS: Array<{ type: TxnType; re: RegExp; requireSign?: 'positive' | 'negative' }> = [
  { type: 'refund', re: /\b(refund|return(?:ed)?|reversal|chargeback)\b/i, requireSign: 'positive' },
  { type: 'payment', re: /\b(online payment|payment received|payment thank you|autopay|statement credit)\b/i },
  // Dividend: positive-amount cash dividend distributions from holdings.
  { type: 'dividend', re: /\bcash dividend distribution\b/i, requireSign: 'positive' },
  // Investment: BUY/SELL cash legs from invest statements. The "Bought N
  // shares" / "Sold N shares" idiom is unambiguous regardless of sign —
  // buys come in negative, sells positive.
  { type: 'investment', re: /\b(bought|sold)\s+[\d.]+\s+shares\b/i },
  {
    type: 'transfer',
    re: /\b(transfer (?:to|from|in|out)|wire transfer|interac e?-?transfer|pre-?authorized (?:debit|credit)|cash (?:sent|received)|direct deposit|eft (?:in|out)|aft)\b/i,
  },
  {
    type: 'fee',
    re: /\b(annual fee|monthly fee|service fee|nsf fee|late fee|atm fee|fx fee|foreign transaction fee|subscription fee|staking reward fee|wealthsimple[^.]{0,40}fee)\b/i,
  },
  { type: 'interest', re: /\b(interest charge|interest on|finance charge|stock lending monthly interest)\b/i },
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
