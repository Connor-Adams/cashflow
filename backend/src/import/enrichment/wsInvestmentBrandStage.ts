import type { Signal } from './types';

export interface WsInvestmentBrandStageInput {
  merchantRaw: string;
}

interface Rule {
  pattern: RegExp;
  /** Build the canonical from regex match groups. */
  toCanonical: (m: RegExpMatchArray) => string;
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
  // Crypto trading fee: "Trading fee for sale of N XRP ..."
  {
    pattern: /^Trading fee for\s+(?:sale|purchase) of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Trading fee`,
  },
  // Crypto buy: "Purchase of 500000.0 PEPE (executed at ...)"
  {
    pattern: /^Purchase of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Buy`,
  },
  // Crypto sell: "Sale of 4.0 XRP (executed at ...)"
  {
    pattern: /^Sale of\s+[\d.]+\s+([A-Z]{2,5})\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Sell`,
  },
  // Ticker dividend: "XEQT - iShares ...: Cash dividend distribution, received on ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*Cash dividend distribution/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Dividend`,
  },
  // Ticker buy with optional price: "XEQT - iShares ...: Bought 0.3921 shares ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*Bought\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Buy`,
  },
  // Ticker sell: "NFLD - Exploits ...: Sold 1500.0 shares ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*Sold\b/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Sell`,
  },
  // Loan out: "PLUR - Plurilock ...: 2.0 Shares on loan ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*[\d.]+\s+Shares on loan/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Loan out`,
  },
  // Loan terminated: "PLUR - Plurilock ...: Loan of 3.0 shares terminated ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*Loan of\s+[\d.]+\s+shares terminated/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Loan terminated`,
  },
  // Ticker transfer in: "ETH - Ethereum: Transfer of 0.0036 ETH into the account ..."
  {
    pattern: /^([A-Z][A-Z0-9.]{1,5})\s+-\s+.+?:\s*Transfer of\s+.+\s+into the account/i,
    toCanonical: (m) => `${m[1].toUpperCase()} — Transfer in`,
  },

  // Cash account flow lines (no ticker)
  {
    pattern: /^(?:Tax-free\s+)?Money transfer into the account/i,
    toCanonical: () => 'Money transfer in',
  },
  {
    pattern: /^(?:Tax-free\s+)?Money transfer out of the account/i,
    toCanonical: () => 'Money transfer out',
  },
  {
    pattern: /^Contribution\s*\(executed at\b/i,
    toCanonical: () => 'Contribution',
  },
  {
    pattern: /^Subscription fee paid for period/i,
    toCanonical: () => 'WS Premium fee',
  },
  {
    pattern: /^Stock lending monthly interest payment/i,
    toCanonical: () => 'Stock lending interest',
  },
  {
    pattern: /^Interest received\b/i,
    toCanonical: () => 'Interest received',
  },
];

export function runWsInvestmentBrandStage(input: WsInvestmentBrandStageInput): Signal[] {
  const raw = input.merchantRaw?.trim() ?? '';
  if (!raw) return [];

  for (const rule of RULES) {
    const m = raw.match(rule.pattern);
    if (m) {
      return [
        {
          source: 'ws-investment',
          confidence: 'high',
          fields: { merchantCanonical: rule.toCanonical(m) },
        },
      ];
    }
  }
  return [];
}
