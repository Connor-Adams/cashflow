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
  // RBC internal-transfer narratives: "Online transfer sent - 6113 Connor Adams"
  // and "Online transfer received". The existing pattern above only matches
  // "transfer to/from/in/out", so "Online transfer sent" fell through to
  // 'purchase'. "Online transfer sent|received" is unambiguous — RBC uses it
  // exclusively for account-to-account funds movement.
  { type: 'transfer', re: /\bonline transfer (?:sent|received)\b/i },
  // Additional internal-money-movement narratives (2026-06-03). These bank
  // descriptions for account-to-account moves and credit-card / loan bill
  // payments did NOT match any pattern above and fell through to the
  // negative-default 'purchase' (or positive 'unknown'), inflating dashboard
  // totalSpend. Each phrase is unambiguous regardless of sign — internal
  // movement, never spend — so they are intentionally sign-agnostic. We do NOT
  // add a bare "e-transfer sent" or "^withdrawal" rule: those are genuinely
  // ambiguous (gambling deposits, cash spent, paying a person for goods) and
  // are deliberately deferred.
  { type: 'transfer', re: /\bonline banking transfer\b/i },
  { type: 'transfer', re: /\bsent money to\b/i },
  { type: 'transfer', re: /\breceived money from\b/i },
  { type: 'transfer', re: /\btopped up account\b/i },
  { type: 'payment', re: /\bonline banking (?:loan )?payment\b/i },
  { type: 'payment', re: /\bonline bill payment for\b/i },
  { type: 'payment', re: /\bamex bill pymt\b/i },
  { type: 'payment', re: /\bmisc payment\b.*\b(amex|visa|mastercard|wise|questrade|bmo)\b/i },
  // RBC → Wealthsimple investment funding: "Investment WS Investments".
  // This phrase is not a securities BUY (no "bought N shares"), so it is safe
  // to match before the negative fallback. The existing `investment` patterns
  // only match "bought/sold N shares" and "loan of N shares", not this phrase.
  // We match the full phrase (not bare "investment") to avoid false-positives
  // on other "investment" narratives like "Investment advisor fee".
  { type: 'transfer', re: /\binvestment\s+ws\s+investments\b/i },
  // Wise FX conversion: "Converted 5,207.60 USD to 7,084.89 CAD". Both legs of
  // a Wise FX appear on the matching CAD + USD statements with a shared
  // sourceReference; classifying them as transfer lets detectRelationshipsStage
  // pair them via sourceReference (amounts differ across currencies so the
  // amount-equality path can't catch them).
  {
    type: 'transfer',
    re: /\bConverted\s+[\d.,]+\s+[A-Z]{3}\s+to\s+[\d.,]+\s+[A-Z]{3}\b/i,
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

// Income: external payroll / direct-deposit inflows. Distinguished from the
// `transfer` pattern below (which also matches "direct deposit") by requiring a
// positive amount and excluding self-deposits. A "direct deposit from <X>"
// where <X> is the account owner's own name or an own-account word is internal
// money movement, not earned income. Bank descriptions are truncated (35-char
// cap in the reference data) so a corporate-entity suffix is not reliably
// present — own-name exclusion against the household members is the precision
// signal that separates "Direct deposit from CDG LABS INC" / "...ADAMS GREENE"
// (income) from "...ADAMS CONNOR" (the owner paying themselves → transfer).
const INCOME_WORD_RE = /\b(payroll|salary|paycheque|paycheck)\b/i;
const DIRECT_DEPOSIT_FROM_RE = /\bdirect deposit from\b/i;
const OWN_ACCOUNT_RE =
  /\b(chequing|checking|savings|tfsa|fhsa|rrsp|rrif|rdsp|margin|crypto)\b/i;

function tokenizeName(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * True when the payee text names a household member — every token of some
 * member's name is present in the payee. A token-SUPERSET test (not substring)
 * so a shared surname alone ("ADAMS" in both "Connor Adams" and an external
 * "ADAMS GREENE") does not misclassify external income as a self transfer.
 */
function isOwnNameDeposit(
  payeeTokens: Set<string>,
  ownerNames: string[],
): boolean {
  return ownerNames.some((name) => {
    const memberTokens = tokenizeName(name);
    return memberTokens.length > 0 && memberTokens.every((t) => payeeTokens.has(t));
  });
}

function detectsIncome(
  haystack: string,
  amount: number,
  ownerNames: string[],
): boolean {
  if (amount <= 0) return false;
  if (INCOME_WORD_RE.test(haystack)) return true;
  if (!DIRECT_DEPOSIT_FROM_RE.test(haystack)) return false;
  if (OWN_ACCOUNT_RE.test(haystack)) return false;
  return !isOwnNameDeposit(new Set(tokenizeName(haystack)), ownerNames);
}

export interface DetectTypeInput {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  /**
   * Owner-side names for the household — member User display names plus any
   * partner Contact names (see loadHouseholdOwnerNames). Used to tell an external
   * payroll direct deposit (income) apart from a self-deposit made under an
   * owner's or partner's own name (transfer). Optional: when omitted, any
   * "direct deposit from <X>" that isn't an own-account movement is treated as
   * external income.
   */
  ownerNames?: string[];
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

  if (detectsIncome(haystack, input.amount, input.ownerNames ?? [])) {
    return [
      {
        source: 'type-detect',
        confidence: 'high',
        fields: { txnType: 'income' },
        rationale: 'narrative matched income (payroll / external direct deposit)',
      },
    ];
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
