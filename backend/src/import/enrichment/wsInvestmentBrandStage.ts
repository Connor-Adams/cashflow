import type { Signal } from './types';

export interface WsInvestmentBrandStageInput {
  merchantRaw: string;
}

// Auto categories for investment activity. These exist so a matched WS row
// arrives at the review-flag computation WITH a category — without one it would
// be treated as "uncategorized" and dumped into the categorization review inbox,
// which makes no sense for a stock buy or a dividend. Two buckets only:
//   - INCOME: money the investment pays you (dividends, interest, stake rewards)
//   - INVEST: every other asset/cash movement and fee (buys, sells, transfers,
//             contributions, trading/subscription fees)
// Spend reports are unaffected — they exclude investment/dividend rows by
// txnType (NON_SPEND_TXN_TYPES), so the category is purely a label.
const INVESTMENT_INCOME = 'Investment income';
const INVESTMENTS = 'Investments';

interface Rule {
  pattern: RegExp;
  /** Build the canonical from regex match groups. */
  toCanonical: (m: RegExpMatchArray) => string;
  /** Auto category assigned to a matched row. */
  category: string;
}

/** Build a rule for "TICKER - Name: <verb>..." security txns. */
function tickerRule(verbSrc: string, action: string, category: string): Rule {
  return {
    pattern: new RegExp(`^([A-Z][A-Z0-9.]{1,5})\\s+-\\s+.+?:\\s*${verbSrc}`, 'i'),
    toCanonical: (m) => `${m[1].toUpperCase()} — ${action}`,
    category,
  };
}

/** Build a rule for "<verb> of N TICKER ..." crypto txns. */
function cryptoVerbRule(verbSrc: string, action: string, category: string): Rule {
  return {
    pattern: new RegExp(`^${verbSrc}\\s+[\\d.]+\\s+([A-Z]{2,5})\\b`, 'i'),
    toCanonical: (m) => `${m[1].toUpperCase()} — ${action}`,
    category,
  };
}

/** Build a rule for cash-flow lines that have no ticker (constant canonical). */
function literalRule(patternSrc: string, canonical: string, category: string): Rule {
  return {
    pattern: new RegExp(patternSrc, 'i'),
    toCanonical: () => canonical,
    category,
  };
}

// Ordered: first match wins. More specific patterns first.
const RULES: Rule[] = [
  // Crypto rewards: "0.001... of DOT rewards earned"
  {
    pattern: /^[\d.]+\s+of\s+([A-Z]{2,5})\s+rewards earned/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake reward`,
    category: INVESTMENT_INCOME,
  },
  // Staked: "Staked 0.020... of ETH-Ethereum"
  {
    pattern: /^Staked\s+[\d.]+\s+of\s+([A-Z]{2,5})-/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake`,
    category: INVESTMENTS,
  },
  // Fee paid on staking: "Fee paid on DOT-Polkadot staking reward:"
  {
    pattern: /^Fee paid on\s+([A-Z]{2,5})-.*staking reward/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake fee`,
    category: INVESTMENTS,
  },
  // Crypto trading fee MUST come before generic Purchase/Sale rules.
  cryptoVerbRule('Trading fee for\\s+(?:sale|purchase) of', 'Trading fee', INVESTMENTS),
  cryptoVerbRule('Purchase of', 'Buy', INVESTMENTS),
  cryptoVerbRule('Sale of', 'Sell', INVESTMENTS),

  // Ticker-prefixed security txns: "TICKER - Name: <verb>..."
  tickerRule('Cash dividend distribution', 'Dividend', INVESTMENT_INCOME),
  tickerRule('Bought\\b', 'Buy', INVESTMENTS),
  tickerRule('Sold\\b', 'Sell', INVESTMENTS),
  tickerRule('[\\d.]+\\s+Shares on loan', 'Loan out', INVESTMENTS),
  tickerRule('Loan of\\s+[\\d.]+\\s+shares terminated', 'Loan terminated', INVESTMENTS),
  tickerRule('Transfer of\\s+.+\\s+into the account', 'Transfer in', INVESTMENTS),

  // Cash-flow lines (no ticker)
  literalRule('^(?:Tax-free\\s+)?Money transfer into the account', 'Money transfer in', INVESTMENTS),
  literalRule('^(?:Tax-free\\s+)?Money transfer out of the account', 'Money transfer out', INVESTMENTS),
  literalRule('^Contribution\\s*\\(executed at\\b', 'Contribution', INVESTMENTS),
  literalRule('^Subscription fee paid for period', 'WS Premium fee', INVESTMENTS),
  literalRule('^Stock lending monthly interest payment', 'Stock lending interest', INVESTMENT_INCOME),
  literalRule('^Interest received\\b', 'Interest received', INVESTMENT_INCOME),
];

function findMatchingRule(raw: string): { rule: Rule; m: RegExpMatchArray } | null {
  for (const rule of RULES) {
    const m = raw.match(rule.pattern);
    if (m) return { rule, m };
  }
  return null;
}

export function runWsInvestmentBrandStage(input: WsInvestmentBrandStageInput): Signal[] {
  const raw = input.merchantRaw?.trim() ?? '';
  if (!raw) return [];
  const hit = findMatchingRule(raw);
  if (!hit) return [];
  return [
    {
      source: 'ws-investment',
      confidence: 'high',
      fields: {
        merchantCanonical: hit.rule.toCanonical(hit.m),
        autoCategory: hit.rule.category,
      },
    },
  ];
}
