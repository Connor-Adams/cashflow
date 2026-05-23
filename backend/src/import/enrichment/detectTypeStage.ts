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
  // Dividend: cash dividend distributions from holdings. Sign-agnostic — the
  // WS bundle imports these with negative amount on the position leg, so a
  // positive-only rule loses ~20 rows to 'purchase' default.
  { type: 'dividend', re: /\bcash dividend distribution\b/i },
  // Investment: BUY/SELL cash legs and stock-lending loan creation/termination
  // from invest statements. The phrases are unambiguous regardless of sign —
  // buys come in negative, sells positive, lending legs come in at zero.
  { type: 'investment', re: /\b(bought|sold)\s+[\d.]+\s+shares\b/i },
  { type: 'investment', re: /\bloan of\s+[\d.]+\s+shares\s+(?:terminated|created)\b/i },
  // "X.X Shares on loan" — active share-lending state ledger entry, distinct
  // from the loan terminated/created state transitions above.
  { type: 'investment', re: /\b[\d.]+\s+shares\s+on\s+loan\b/i },
  // "Staked X of TOKEN-Name" — crypto staking initiation; counterpart to the
  // "X of TOKEN rewards earned" reward pattern below.
  { type: 'investment', re: /\bstaked\s+[\d.]+\s+of\s+[\w-]+/i },
  // Fee: must come BEFORE the reward 'rewards earned' pattern so
  // "Fee paid on ... staking reward" doesn't get mis-routed to reward.
  {
    type: 'fee',
    re: /\b(annual fee|monthly fee|service fee|nsf fee|late fee|atm fee|fx fee|foreign transaction fee|subscription fee|staking reward fee|fee paid on [^.]{0,60}staking reward|wealthsimple[^.]{0,40}fee)\b/i,
  },
  // Reward: crypto staking rewards earned. Sign-agnostic — WS bundle imports
  // these with negative amount on the position leg.
  { type: 'reward', re: /\bof\s+\w+\s+rewards?\s+earned\b/i },
  {
    type: 'transfer',
    re: /\b(transfer (?:to|from|in|out)|wire transfer|interac e?-?transfer|pre-?authorized (?:debit|credit)|cash (?:sent|received)|direct deposit|from chequing account|eft (?:in|out)|aft)\b/i,
  },
  { type: 'interest', re: /\b(interest charge|interest on|finance charge|stock lending monthly interest)\b/i },
  { type: 'reward', re: /\b(cash ?back|reward|points redemption)\b/i, requireSign: 'positive' },
];

// Bare-word phrases that don't survive a \b match inside the concatenated
// haystack — checked before PATTERNS as exact-match shortcuts. "Deposit"
// alone is a Wealthsimple deposit ledger entry (treat as transfer); a generic
// \bDeposit\b regex would false-positive on "Direct deposit" or "term deposit".
const EXACT_RAW_MATCHES: Array<{ value: string; type: TxnType }> = [
  { value: 'deposit', type: 'transfer' },
];

export interface DetectTypeInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
}

export function runDetectTypeStage(input: DetectTypeInput): Signal[] {
  const haystack = `${input.merchantRaw} ${input.merchantClean}`.trim();

  const trimmedRaw = input.merchantRaw.trim().toLowerCase();
  for (const m of EXACT_RAW_MATCHES) {
    if (trimmedRaw === m.value) {
      return [
        {
          source: 'type-detect',
          confidence: 'high',
          fields: { txnType: m.type },
          rationale: `narrative matched ${m.type} (bare ${m.value})`,
        },
      ];
    }
  }

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
