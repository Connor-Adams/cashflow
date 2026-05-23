import type { Signal } from './types';

export interface WsInvestmentBrandStageInput {
  merchantRaw: string;
}

interface Rule {
  pattern: RegExp;
  /** Build the canonical from regex match groups. */
  toCanonical: (m: RegExpMatchArray) => string;
}

/** Build a rule for "TICKER - Name: <verb>..." security txns. */
function tickerRule(verbSrc: string, action: string): Rule {
  return {
    pattern: new RegExp(`^([A-Z][A-Z0-9.]{1,5})\\s+-\\s+.+?:\\s*${verbSrc}`, 'i'),
    toCanonical: (m) => `${m[1].toUpperCase()} — ${action}`,
  };
}

/** Build a rule for "<verb> of N TICKER ..." crypto txns. */
function cryptoVerbRule(verbSrc: string, action: string): Rule {
  return {
    pattern: new RegExp(`^${verbSrc}\\s+[\\d.]+\\s+([A-Z]{2,5})\\b`, 'i'),
    toCanonical: (m) => `${m[1].toUpperCase()} — ${action}`,
  };
}

/** Build a rule for cash-flow lines that have no ticker (constant canonical). */
function literalRule(patternSrc: string, canonical: string): Rule {
  return {
    pattern: new RegExp(patternSrc, 'i'),
    toCanonical: () => canonical,
  };
}

// Ordered: first match wins. More specific patterns first.
const RULES: Rule[] = [
  // Crypto rewards: "0.001... of DOT rewards earned"
  {
    pattern: /^[\d.]+\s+of\s+([A-Z]{2,5})\s+rewards earned/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake reward`,
  },
  // Staked: "Staked 0.020... of ETH-Ethereum"
  {
    pattern: /^Staked\s+[\d.]+\s+of\s+([A-Z]{2,5})-/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake`,
  },
  // Fee paid on staking: "Fee paid on DOT-Polkadot staking reward:"
  {
    pattern: /^Fee paid on\s+([A-Z]{2,5})-.*staking reward/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Stake fee`,
  },
  // Crypto trading fee MUST come before generic Purchase/Sale rules.
  cryptoVerbRule('Trading fee for\\s+(?:sale|purchase) of', 'Trading fee'),
  cryptoVerbRule('Purchase of', 'Buy'),
  cryptoVerbRule('Sale of', 'Sell'),

  // Ticker-prefixed security txns: "TICKER - Name: <verb>..."
  tickerRule('Cash dividend distribution', 'Dividend'),
  tickerRule('Bought\\b', 'Buy'),
  tickerRule('Sold\\b', 'Sell'),
  tickerRule('[\\d.]+\\s+Shares on loan', 'Loan out'),
  tickerRule('Loan of\\s+[\\d.]+\\s+shares terminated', 'Loan terminated'),
  tickerRule('Transfer of\\s+.+\\s+into the account', 'Transfer in'),

  // Cash-flow lines (no ticker)
  literalRule('^(?:Tax-free\\s+)?Money transfer into the account', 'Money transfer in'),
  literalRule('^(?:Tax-free\\s+)?Money transfer out of the account', 'Money transfer out'),
  literalRule('^Contribution\\s*\\(executed at\\b', 'Contribution'),
  literalRule('^Subscription fee paid for period', 'WS Premium fee'),
  literalRule('^Stock lending monthly interest payment', 'Stock lending interest'),
  literalRule('^Interest received\\b', 'Interest received'),
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
      fields: { merchantCanonical: hit.rule.toCanonical(hit.m) },
    },
  ];
}
