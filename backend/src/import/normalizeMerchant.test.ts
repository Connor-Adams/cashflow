import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMerchant } from './normalizeMerchant';

test('normalizeMerchant trims and collapses whitespace', () => {
  assert.equal(normalizeMerchant('  Foo   Bar  '), 'Foo Bar');
});

test('normalizeMerchant strips SQ * processor prefix', () => {
  assert.equal(normalizeMerchant('SQ *JOES COFFEE'), 'JOES COFFEE');
  assert.equal(normalizeMerchant('SQ *JOE&#39;S COFFEE TORONTO'), "JOE'S COFFEE TORONTO");
});

test('normalizeMerchant strips TST* prefix', () => {
  assert.equal(normalizeMerchant('TST*LOCAL BISTRO'), 'LOCAL BISTRO');
});

test('normalizeMerchant strips PAYPAL * prefix', () => {
  assert.equal(normalizeMerchant('PAYPAL *MERCHANT123'), 'MERCHANT123');
});

test('normalizeMerchant strips AMZN MKTP US* trailing identifier', () => {
  assert.equal(normalizeMerchant('AMZN MKTP US*A1B2C3D4'), 'AMZN MKTP US');
  assert.equal(normalizeMerchant('AMZN Mktp US*Z9Y8X7'), 'AMZN Mktp US');
});

test('normalizeMerchant strips STRIPE* and GOOGLE *', () => {
  assert.equal(normalizeMerchant('STRIPE*MERCHANT'), 'MERCHANT');
  assert.equal(normalizeMerchant('GOOGLE *DOMAINS'), 'DOMAINS');
});

test('normalizeMerchant strips trailing store/transit numbers', () => {
  assert.equal(normalizeMerchant('STARBUCKS #1234'), 'STARBUCKS');
  assert.equal(normalizeMerchant('TARGET STORE 5678'), 'TARGET');
  assert.equal(normalizeMerchant('SHELL OIL 91234'), 'SHELL OIL');
});

test('normalizeMerchant strips trailing US/CA city-state tails', () => {
  assert.equal(normalizeMerchant('JOE COFFEE TORONTO ON'), 'JOE COFFEE');
  assert.equal(normalizeMerchant('CAFE BAR NEW YORK NY US'), 'CAFE BAR');
  assert.equal(normalizeMerchant('SAM SHOP MISSISSAUGA ON CA'), 'SAM SHOP');
});

test('normalizeMerchant strips trailing phone numbers', () => {
  assert.equal(normalizeMerchant('PIZZA SHOP 416-555-1212'), 'PIZZA SHOP');
  assert.equal(normalizeMerchant('STORE 800.555.0199'), 'STORE');
});

test('normalizeMerchant edge case: 2-word string ending in state code is stripped to one word', () => {
  // Documented behaviour: with no recognised city, the trailing state token is
  // stripped. Real merchant strings rarely take this form so this is acceptable.
  assert.equal(normalizeMerchant('SHOP ON'), 'SHOP');
});

test('normalizeMerchant edge case: trailing CA is treated as Canada, not California', () => {
  // Known limitation: CA appears in both COUNTRY_SET (Canada) and STATE_PROV_SET
  // (California). The country check fires first — consuming CA as country — then
  // the preceding token (MALIBU) is not a state code, so stripCityStateTail bails
  // out and returns the string unchanged. US merchant strings ending in "... CA"
  // with no other state token are therefore NOT stripped.
  assert.equal(normalizeMerchant('STORE MALIBU CA'), 'STORE MALIBU CA');
});

test('normalizeMerchant is idempotent', () => {
  const once = normalizeMerchant('SQ *JOE COFFEE TORONTO ON #1234');
  const twice = normalizeMerchant(once);
  assert.equal(once, twice);
});

test('normalizeMerchant handles empty / non-string input', () => {
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant(null), '');
  assert.equal(normalizeMerchant(undefined), '');
});

test('normalizeMerchant leaves recognised cleaned merchants untouched', () => {
  assert.equal(normalizeMerchant('NETFLIX.COM'), 'NETFLIX.COM');
});

test('normalizeMerchant strips mid-string numeric store IDs', () => {
  assert.equal(normalizeMerchant("MCDONALD'S #12164 GUELPH"), "MCDONALD'S");
  assert.equal(normalizeMerchant('STARBUCKS 04747 GUELPH'), 'STARBUCKS');
  assert.equal(normalizeMerchant('PETRO-CANADA 10585 GUELPH'), 'PETRO-CANADA');
  assert.equal(normalizeMerchant('WALMART 3144 3144 GUELPH'), 'WALMART');
  assert.equal(normalizeMerchant('DOMINOS PIZZA 10263 GUELPH'), 'DOMINOS PIZZA');
});

test('normalizeMerchant strips mid-string alphanumeric store IDs', () => {
  assert.equal(normalizeMerchant('SHELL C12587 GUELPH'), 'SHELL');
  assert.equal(normalizeMerchant('COSTCO GAS W1168'), 'COSTCO GAS');
});

test('normalizeMerchant does not strip short leading numbers', () => {
  // 500 is part of the merchant name (sports box seat), don't drop it.
  // TORONTO stays because no state code follows and no store ID precedes it.
  assert.equal(normalizeMerchant('500 LOGE CLUB TORONTO'), '500 LOGE CLUB TORONTO');
  // Single-digit '# 5' (with space) isn't a store ID under our regex.
  assert.equal(normalizeMerchant('ZEHRS GUELPH CLAIR # 5'), 'ZEHRS GUELPH CLAIR # 5');
});

test('normalizeMerchant collapses duplicate trailing city tokens', () => {
  assert.equal(normalizeMerchant('FARM BOY GUELPH GUELPH'), 'FARM BOY GUELPH');
  assert.equal(normalizeMerchant("A&W TORONTO TORONTO"), 'A&W TORONTO');
  assert.equal(normalizeMerchant('BEERTOWN GUELPH GUELPH'), 'BEERTOWN GUELPH');
});

test('normalizeMerchant does not collapse non-duplicate tails', () => {
  assert.equal(normalizeMerchant('REN PETS GUELPH'), 'REN PETS GUELPH');
  assert.equal(normalizeMerchant('FOO BAR BAZ'), 'FOO BAR BAZ');
});

test('normalizeMerchant duplicate-tail collapse is case-insensitive', () => {
  assert.equal(normalizeMerchant('SLAP BURGERS Guelph guelph'), 'SLAP BURGERS Guelph');
});

test('normalizeMerchant strips IC* (Instacart) prefix', () => {
  assert.equal(normalizeMerchant('IC* INSTACART*SUBSCRIP HALIFAX'), 'INSTACART*SUBSCRIP HALIFAX');
});

test('normalizeMerchant strips CTLP* prefix', () => {
  assert.equal(normalizeMerchant('CTLP*CS VENDING SOLUTI'), 'CS VENDING SOLUTI');
});

test('normalizeMerchant strips INTUIT * prefix', () => {
  assert.equal(normalizeMerchant('INTUIT *QBOOKS ONLINE'), 'QBOOKS ONLINE');
});

test('normalizeMerchant strips PADDLE.NET* prefix', () => {
  assert.equal(normalizeMerchant('PADDLE.NET* MTW LONDON'), 'MTW LONDON');
  assert.equal(normalizeMerchant('PADDLE.NET* BTTRDISPLY LONDON'), 'BTTRDISPLY LONDON');
});

// ---------------------------------------------------------------------------
// Transaction-specific boilerplate (issue: phantom merchants)
//
// `merchant_clean` is the key merchant memory and rules hinge on, so every
// transaction-specific token retained in it forks one real merchant into many
// low-support memory buckets. The three families below were each measured
// against production before being stripped; see
// docs/superpowers/specs/2026-09-28-embedding-threshold-calibration.md.
// ---------------------------------------------------------------------------

test('normalizeMerchant strips a trailing [CURRENCY amount @ rate] suffix', () => {
  assert.equal(
    normalizeMerchant('DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]'),
    'DISCORD* NITROMONTHLY SAN FRANCISCO',
  );
  assert.equal(
    normalizeMerchant('CLOUDFLARE SAN FRANCISCO [UNITED STATES DOLLAR 4.72 @ 1.41314]'),
    'CLOUDFLARE SAN FRANCISCO',
  );
  assert.equal(
    normalizeMerchant('ENDOR AMERICA LLC BERVERLY HILLS [EUROPEAN UNION EURO 305.90 @ 1.52867]'),
    'ENDOR AMERICA LLC BERVERLY HILLS',
  );
  assert.equal(
    normalizeMerchant('EMPEROR SERVERS POOLE [UNITED KINGDOM POUND STERLING 12.00 @ 1.71]'),
    'EMPEROR SERVERS POOLE',
  );
  // Thousands separator and an integer rate both occur in production.
  assert.equal(
    normalizeMerchant('UNITED AIRLINES HOUSTON [UNITED STATES DOLLAR 1,692.74 @ 1.4]'),
    'UNITED AIRLINES HOUSTON',
  );
});

test('normalizeMerchant collapses FX-rate variants of one merchant to one key', () => {
  const a = normalizeMerchant('BT*IRACING MOTORSPORT S CHELMSFORD [UNITED STATES DOLLAR 1.35 @ 1.45185]');
  const b = normalizeMerchant('BT*IRACING MOTORSPORT S CHELMSFORD [UNITED STATES DOLLAR 1.35 @ 1.43704]');
  assert.equal(a, b);
  assert.equal(a, 'BT*IRACING MOTORSPORT S CHELMSFORD');
});

test('normalizeMerchant leaves bracketed text that is not a currency-rate payload', () => {
  // A bracketed qualifier can be part of a merchant's identity. Only the
  // `[<CURRENCY WORDS> <amount> @ <rate>]` shape is boilerplate.
  assert.equal(normalizeMerchant('COFFEE CO [LIMITED EDITION]'), 'COFFEE CO [LIMITED EDITION]');
  assert.equal(normalizeMerchant('SOME SHOP [USD]'), 'SOME SHOP [USD]');
  assert.equal(normalizeMerchant('SOME SHOP [UNITED STATES DOLLAR 5.00]'), 'SOME SHOP [UNITED STATES DOLLAR 5.00]');
  // Not anchored at the end -> not the FX suffix, so it stays.
  assert.equal(
    normalizeMerchant('ACME [UNITED STATES DOLLAR 5.00 @ 1.4] STORE'),
    'ACME [UNITED STATES DOLLAR 5.00 @ 1.4] STORE',
  );
});

test('normalizeMerchant strips a date-bearing parenthetical', () => {
  assert.equal(normalizeMerchant('Withdrawal (executed at 2026-06-04)'), 'Withdrawal');
  assert.equal(
    normalizeMerchant('Money transfer out of the account (executed at 2026-07-01)'),
    'Money transfer out of the account',
  );
  assert.equal(
    normalizeMerchant('Tax-free money transfer out of the account (executed at 2026-06-04)'),
    'Tax-free money transfer out of the account',
  );
  assert.equal(
    normalizeMerchant('Online bill payment for CIBC MASTERCARD, account \u2219\u2219\u2219\u22193114 (executed at 2026-08-01)'),
    'Online bill payment for CIBC MASTERCARD, account \u2219\u2219\u2219\u22193114',
  );
  // Mid-string parenthetical: the text after it survives.
  assert.equal(
    normalizeMerchant('GOLD - Physically backed gold: Bought 0.0084 ounces (executed at 2026-01-02), Fee: $0.2700'),
    'GOLD - Physically backed gold: Bought 0.0084 ounces, Fee: $0.2700',
  );
});

test('normalizeMerchant strips a trailing date clause', () => {
  assert.equal(
    normalizeMerchant(
      'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2024-10-07, record date of',
    ),
    'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution',
  );
  assert.equal(
    normalizeMerchant('DOO - BRP Inc: Cash dividend distribution, received on 2026-04-24, record date of 2026-03-31'),
    'DOO - BRP Inc: Cash dividend distribution',
  );
  assert.equal(normalizeMerchant('Subscription fee paid for period 2026-01-01 to'), 'Subscription fee paid');
});

test('normalizeMerchant collapses date variants of one Wealthsimple sentence to one key', () => {
  const a = normalizeMerchant('Money transfer out of the account (executed at 2026-03-08)');
  const b = normalizeMerchant('Money transfer out of the account (executed at 2026-07-01)');
  assert.equal(a, b);
  assert.equal(a, 'Money transfer out of the account');
  assert.equal(
    normalizeMerchant('Contribution (executed at 2025-02-14)'),
    normalizeMerchant('Contribution (executed at 2026-02-14)'),
  );
});

test('normalizeMerchant leaves digit groups that are not a full ISO date', () => {
  assert.equal(normalizeMerchant('ACME 2026-09 SUBSCRIPTION'), 'ACME 2026-09 SUBSCRIPTION');
  assert.equal(normalizeMerchant('Widget 12-34-5678 Depot'), 'Widget 12-34-5678 Depot');
  assert.equal(normalizeMerchant('Contribution (executed at)'), 'Contribution (executed at)');
  // A parenthetical with no ISO date is identity, not boilerplate.
  assert.equal(normalizeMerchant('BELL CANADA (OB) MONTREAL'), 'BELL CANADA (OB) MONTREAL');
});

test('normalizeMerchant strips card-network purchase prefixes', () => {
  assert.equal(
    normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 1089 ZEHRS GUELPH CL'),
    'ZEHRS GUELPH CL',
  );
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 5587 TIM HORTONS'), 'TIM HORTONS');
  assert.equal(normalizeMerchant('INTERAC PURCHASE - 2183 WAL-MART'), 'WAL-MART');
  assert.equal(normalizeMerchant('INTERAC PURCHASE REFUND - 2183 WAL-MART'), 'WAL-MART');
  assert.equal(
    normalizeMerchant('ONLINE BANKING INTERAC PURCHASE - 4410 CANADIAN TIRE'),
    'CANADIAN TIRE',
  );
  assert.equal(normalizeMerchant('VISA DEBIT PURCHASE - 5678 PETRO-CANADA'), 'PETRO-CANADA');
});

test('normalizeMerchant collapses Interac variants onto the plain merchant key', () => {
  assert.equal(
    normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 8507 SHOPPERS DRUG M'),
    normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 5637 SHOPPERS DRUG M'),
  );
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 9315 TIM HORTONS'), normalizeMerchant('TIM HORTONS'));
});

test('normalizeMerchant leaves other bank boilerplate prefixes alone', () => {
  // Deliberately out of scope: these carry transfer counterparty/reference
  // information and are consumed by transfer matching and type detection.
  // (Trailing reference numbers on these are stripped by the pre-existing
  // store-number pass; what matters here is that the prefix itself survives.)
  assert.equal(
    normalizeMerchant('ONLINE BANKING PAYMENT CIBC MASTERCARD'),
    'ONLINE BANKING PAYMENT CIBC MASTERCARD',
  );
  assert.equal(normalizeMerchant('E-TRANSFER - AUTODEPOSIT JANE DOE'), 'E-TRANSFER - AUTODEPOSIT JANE DOE');
  assert.equal(normalizeMerchant('ONLINE TRANSFER RECEIVED SAVINGS'), 'ONLINE TRANSFER RECEIVED SAVINGS');
  // No card-network qualifier -> not our prefix.
  assert.equal(normalizeMerchant('PURCHASE - SOMETHING ELSE'), 'PURCHASE - SOMETHING ELSE');
});

test('normalizeMerchant never returns empty for a non-empty input', () => {
  // A row whose merchant is nothing but boilerplate (36 production rows are
  // exactly this) must keep something to key on rather than collapse to ''.
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE -'), 'CONTACTLESS INTERAC PURCHASE -');
  assert.equal(normalizeMerchant('INTERAC PURCHASE -'), 'INTERAC PURCHASE -');
  assert.equal(normalizeMerchant('(executed at 2026-06-04)'), '(executed at 2026-06-04)');
  assert.equal(normalizeMerchant('[UNITED STATES DOLLAR 1.35 @ 1.45185]'), '[UNITED STATES DOLLAR 1.35 @ 1.45185]');
});

test('normalizeMerchant no longer reduces an Interac purchase to the bare prefix', () => {
  // Regression lock on the strongest reason to strip this prefix. Before the
  // prefix strip existed, MID_STORE_WITH_CITY read "5587 TIM HORTONS" as a
  // store id plus city words and ate it, leaving the transaction type as the
  // merchant: 219 production rows normalized to a bare card-network prefix,
  // i.e. one meaningless 219-row memory bucket spanning Tim Hortons, Metro,
  // Wal-Mart and a dozen others. Stripping the prefix FIRST means the tail
  // passes see "TIM HORTONS", which has no digits for them to chew on.
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 5587 TIM HORTONS'), 'TIM HORTONS');
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 4149 WENDY\'S'), "WENDY'S");
  assert.equal(normalizeMerchant('INTERAC PURCHASE - 2183 WAL-MART'), 'WAL-MART');
  // The store-number pass must still do its job on merchants it should trim.
  assert.equal(normalizeMerchant('CONTACTLESS INTERAC PURCHASE - 8714 METRO 123 GUELPH ON'), 'METRO');
});
