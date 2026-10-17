import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCounterparty } from './extractCounterparty';
import type { AccountType } from '@cashflow/shared';

const IN_SCOPE: AccountType[] = ['checking', 'savings', 'cash'];
const OUT_OF_SCOPE: AccountType[] = ['credit_card', 'loan', 'investment'];

test('out-of-scope account types always return null', () => {
  for (const t of OUT_OF_SCOPE) {
    assert.equal(
      extractCounterparty('INTERAC E-TFR FROM JANE DOE', t),
      null,
      `expected null for accountType ${t}`,
    );
  }
});

test('in-scope: Interac e-transfer FROM with full INTERAC prefix', () => {
  for (const t of IN_SCOPE) {
    assert.equal(
      extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE', t)?.name,
      'JANE DOE',
    );
  }
});

test('in-scope: Interac e-transfer with E-TFR abbrev', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR TO MIKE SMITH', 'savings')?.name,
    'MIKE SMITH',
  );
});

test('in-scope: bare E-TRANSFER without INTERAC prefix', () => {
  assert.equal(
    extractCounterparty('E-TRANSFER FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('E-TRANSFER TO MIKE SMITH', 'checking')?.name,
    'MIKE SMITH',
  );
});

test('in-scope: SEND/RECV e-transfer variants', () => {
  assert.equal(
    extractCounterparty('SEND E-TFR JOHN SMITH', 'checking')?.name,
    'JOHN SMITH',
  );
  assert.equal(
    extractCounterparty('RECV E-TFR JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('RECEIVED E-TFR JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: Zelle FROM/TO', () => {
  assert.equal(
    extractCounterparty('ZELLE FROM SARAH KIM', 'checking')?.name,
    'SARAH KIM',
  );
  assert.equal(
    extractCounterparty('ZELLE TO BOB JONES', 'checking')?.name,
    'BOB JONES',
  );
});

test('in-scope: Venmo payment/cashout', () => {
  assert.equal(
    extractCounterparty('VENMO PAYMENT FROM SARAH', 'checking')?.name,
    'SARAH',
  );
  assert.equal(
    extractCounterparty('VENMO CASHOUT TO BOB', 'checking')?.name,
    'BOB',
  );
});

test('in-scope: Cash App asterisk form', () => {
  assert.equal(
    extractCounterparty('CASH APP*JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('CASHAPP*MIKE', 'checking')?.name,
    'MIKE',
  );
});

test('in-scope: Cash App with FROM/TO', () => {
  assert.equal(
    extractCounterparty('CASH APP FROM JANE DOE', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: payroll / direct deposit captures payer', () => {
  assert.equal(
    extractCounterparty('PAYROLL DEPOSIT ACME CORP', 'checking')?.name,
    'ACME CORP',
  );
  assert.equal(
    extractCounterparty('DIRECT DEPOSIT ACME PAYROLL', 'checking')?.name,
    'ACME PAYROLL',
  );
  assert.equal(
    extractCounterparty('DIRECT DEP ACME INC', 'checking')?.name,
    'ACME INC',
  );
});

test('in-scope: trailing REF#/numeric noise is stripped', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE REF# ABC123', 'checking')?.name,
    'JANE DOE',
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE 12345', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: whitespace collapses and trims', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM   JANE   DOE  ', 'checking')?.name,
    'JANE DOE',
  );
});

test('in-scope: false-positive guards (TO/FROM as English word in merchant)', () => {
  assert.equal(extractCounterparty('TIM HORTONS TO GO', 'checking'), null);
  assert.equal(extractCounterparty('FROM THE GROUND COFFEE', 'checking'), null);
  assert.equal(extractCounterparty('WALMART SUPERCENTER', 'checking'), null);
  assert.equal(extractCounterparty('STARBUCKS COFFEE #4567', 'checking'), null);
  assert.equal(extractCounterparty('AMAZON.CA*1234567', 'checking'), null);
});

test('in-scope: empty / whitespace input returns null', () => {
  assert.equal(extractCounterparty('', 'checking'), null);
  assert.equal(extractCounterparty('   ', 'checking'), null);
});

test('in-scope: mixed case input still matches', () => {
  assert.equal(
    extractCounterparty('Interac e-Transfer from Jane Doe', 'checking')?.name,
    'Jane Doe',
  );
});

test('in-scope: very short single-word name still captured', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM SU', 'checking')?.name,
    'SU',
  );
});

test('in-scope: name with hyphen/apostrophe preserved', () => {
  assert.equal(
    extractCounterparty("INTERAC E-TFR FROM SEAN O'BRIEN", 'checking')?.name,
    "SEAN O'BRIEN",
  );
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM MARY-JANE WATSON', 'checking')?.name,
    'MARY-JANE WATSON',
  );
});

// ---------------------------------------------------------------------------
// Real production description shapes (measured against prod 2026-09-29).
//
// None of these use the `FROM`/`TO` form the original pattern table required,
// which is why the extractor matched 0 of 2,076 rows on the main RBC chequing
// account. Third-party legal names are replaced with stand-ins; the SHAPES
// (token order, separators, reference-code suffixes, casing) are verbatim.
// ---------------------------------------------------------------------------

// --- RBC: E-TRANSFER SENT / RECEIVED -------------------------------------

test('prod shape: RBC E-TRANSFER SENT <name>', () => {
  assert.deepEqual(extractCounterparty('E-TRANSFER SENT STEPHEN', 'checking'), {
    name: 'STEPHEN',
    kind: 'person',
    direction: 'sent',
  });
});

test('prod shape: RBC E-TRANSFER RECEIVED <full name>', () => {
  assert.deepEqual(
    extractCounterparty('E-TRANSFER RECEIVED CORY FRASER ROBINSON', 'checking'),
    { name: 'CORY FRASER ROBINSON', kind: 'person', direction: 'received' },
  );
});

test('prod shape: RBC E-TRANSFER - AUTODEPOSIT is a RECEIVED variant', () => {
  assert.deepEqual(
    extractCounterparty('E-TRANSFER - AUTODEPOSIT STEPHEN MASSEUR', 'checking'),
    { name: 'STEPHEN MASSEUR', kind: 'person', direction: 'received' },
  );
});

test('prod shape: RBC E-TRANSFER REQUEST FULFILLED is a RECEIVED variant', () => {
  assert.deepEqual(
    extractCounterparty('E-TRANSFER REQUEST FULFILLED PAYBILT INC. 3K2WLR', 'checking'),
    { name: 'PAYBILT INC.', kind: 'person', direction: 'received' },
  );
});

test('prod shape: RBC E-TRANSFER CANCEL keeps the name, reads as sent', () => {
  assert.deepEqual(extractCounterparty('E-TRANSFER CANCEL EVAN LEROSE DPKGQG', 'checking'), {
    name: 'EVAN LEROSE',
    kind: 'person',
    direction: 'sent',
  });
});

test('prod shape: lowercase RBC e-transfer line still matches', () => {
  assert.deepEqual(extractCounterparty('e-Transfer sent caelan ws PMF6C7', 'checking'), {
    name: 'caelan ws',
    kind: 'person',
    direction: 'sent',
  });
});

// --- RBC: reference-code suffix stripping --------------------------------

test('prod shape: 6-char alphanumeric RBC reference code is stripped', () => {
  assert.equal(extractCounterparty('E-TRANSFER SENT STEPHEN 5KBFRY', 'checking')?.name, 'STEPHEN');
  assert.equal(extractCounterparty('E-TRANSFER SENT STEPHEN QRZJW3', 'checking')?.name, 'STEPHEN');
});

test('prod shape: vowel-poor all-letter RBC reference code is stripped', () => {
  assert.equal(extractCounterparty('E-TRANSFER SENT STEPHEN UNJGNG', 'checking')?.name, 'STEPHEN');
  assert.equal(extractCounterparty('E-TRANSFER SENT ALP KYXLNZ', 'checking')?.name, 'ALP');
});

test('prod shape: CA-prefixed 8-char reference code is stripped', () => {
  assert.equal(
    extractCounterparty('E-TRANSFER RECEIVED CONNOR ADAMS CATHXKBZ', 'checking')?.name,
    'CONNOR ADAMS',
  );
  assert.equal(
    extractCounterparty('E-TRANSFER - AUTODEPOSIT ALEXANDRA MCPHERSON CAGDTUAK', 'checking')?.name,
    'ALEXANDRA MCPHERSON',
  );
});

test('prod shape: C1A-prefixed 12-char reference code is stripped', () => {
  assert.equal(
    extractCounterparty('E-TRANSFER - AUTODEPOSIT STEPHEN MASSEUR C1AA2KGH73HY', 'checking')?.name,
    'STEPHEN MASSEUR',
  );
});

test('prod shape: long hex / opaque reference codes are stripped', () => {
  assert.equal(
    extractCounterparty(
      'E-TRANSFER - AUTODEPOSIT ALEXANDRA MCPHERSON D75F1AEF4BF0ED3C',
      'checking',
    )?.name,
    'ALEXANDRA MCPHERSON',
  );
  assert.equal(
    extractCounterparty(
      'E-TRANSFER - AUTODEPOSIT ALEXANDRA MCPHERSON 18D77730EED8471E7DE884CEEBE5BE89',
      'checking',
    )?.name,
    'ALEXANDRA MCPHERSON',
  );
  assert.equal(
    extractCounterparty(
      'E-TRANSFER - AUTODEPOSIT CONNOR DOUGLAS GREENE ADAMS BJI1OV8OCBZIR67JMMC9CWTPX1AJ55G9DMY',
      'checking',
    )?.name,
    'CONNOR DOUGLAS GREENE ADAMS',
  );
});

test('prod shape: only ONE trailing reference token is stripped, so a single-token name survives', () => {
  // CRYPTO is 6 letters with 1 vowel — it fits the reference-code shape, but
  // stripping it would leave nothing, so the name must be kept.
  assert.equal(extractCounterparty('E-TRANSFER SENT CRYPTO', 'checking')?.name, 'CRYPTO');
  assert.equal(extractCounterparty('E-TRANSFER SENT WESTYN R6L9CA', 'checking')?.name, 'WESTYN');
});

test('prod shape: a real surname is not mistaken for a reference code', () => {
  assert.equal(
    extractCounterparty('E-TRANSFER RECEIVED EVAN ADCOCK', 'checking')?.name,
    'EVAN ADCOCK',
  );
  assert.equal(extractCounterparty('E-TRANSFER RECEIVED MARY GREENE', 'checking')?.name, 'MARY GREENE');
  assert.equal(extractCounterparty('E-TRANSFER SENT ALLISTAR', 'checking')?.name, 'ALLISTAR');
  assert.equal(
    extractCounterparty('E-TRANSFER RECEIVED MACLENNANEDWARDJAMIESON CAGJPEW8', 'checking')?.name,
    'MACLENNANEDWARDJAMIESON',
  );
});

// --- RBC: ONLINE TRANSFER with a leading account fragment ----------------

test('prod shape: ONLINE TRANSFER RECEIVED - <acct> <name>', () => {
  assert.deepEqual(
    extractCounterparty('ONLINE TRANSFER RECEIVED - 8613 CAELAN ANTHONY ITEN-MCGRATH', 'checking'),
    { name: 'CAELAN ANTHONY ITEN-MCGRATH', kind: 'person', direction: 'received' },
  );
  assert.equal(
    extractCounterparty("ONLINE TRANSFER RECEIVED - 8267 ENZO'S COLLEGE FUND INC.", 'checking')
      ?.name,
    "ENZO'S COLLEGE FUND INC.",
  );
});

test('prod shape: ONLINE TRANSFER SENT - <acct> <name> - SAVINGS', () => {
  assert.deepEqual(
    extractCounterparty('ONLINE TRANSFER SENT - 8288 ERIC BROADFOOT - SAVINGS', 'checking'),
    { name: 'ERIC BROADFOOT', kind: 'person', direction: 'sent' },
  );
});

test('prod shape: mixed-case Online transfer sent - <acct> <name>', () => {
  assert.equal(
    extractCounterparty('Online transfer sent - 5715 Connor Adams', 'checking')?.name,
    'Connor Adams',
  );
});

test('prod shape: nameless ONLINE TRANSFER lines yield null, not an empty name', () => {
  assert.equal(extractCounterparty('ONLINE TRANSFER SENT -', 'checking'), null);
  assert.equal(extractCounterparty('ONLINE TRANSFER RECEIVED -', 'checking'), null);
  assert.equal(extractCounterparty('ONLINE BANKING TRANSFER -', 'checking'), null);
  assert.equal(extractCounterparty('E-TRANSFER RECEIVED', 'checking'), null);
  assert.equal(extractCounterparty('E-TRANSFER - AUTODEPOSIT', 'checking'), null);
  assert.equal(extractCounterparty('INTERAC E-TRANSFER CANCEL -', 'checking'), null);
});

// --- RBC: own-account and service lines must NOT produce a person --------

test('prod shape: own-account transfers produce no counterparty', () => {
  assert.equal(extractCounterparty('ONLINE TRANSFER TO DEPOSIT ACCOUNT-1134', 'checking'), null);
  assert.equal(extractCounterparty('AUTO TRANSFER FROM FIND & SAVE', 'checking'), null);
  assert.equal(extractCounterparty('Auto transfer to deposit account', 'savings'), null);
  assert.equal(extractCounterparty('Online Transfer to Deposit Account-3393', 'savings'), null);
});

test('prod shape: MISC PAYMENT service lines produce no counterparty', () => {
  assert.equal(extractCounterparty('MISC PAYMENT MYLO TRANSFER', 'checking'), null);
  assert.equal(extractCounterparty('MISC PAYMENT MOKA TRANSFER', 'checking'), null);
});

test('prod shape: ATM / cheque / interest lines produce no counterparty', () => {
  assert.equal(extractCounterparty('ATM DEPOSIT - KF470333', 'checking'), null);
  assert.equal(extractCounterparty('ATM WITHDRAWAL - AD552902', 'checking'), null);
  assert.equal(extractCounterparty('MOBILE CHEQUE DEPOSIT -', 'checking'), null);
  assert.equal(extractCounterparty('CASH WITHDRAWAL BR TO BR -', 'checking'), null);
  assert.equal(extractCounterparty('Own cash deposit', 'checking'), null);
  assert.equal(extractCounterparty('Deposit interest', 'savings'), null);
  assert.equal(extractCounterparty('CANADA ESSENTIALS BENEFIT CANADA', 'checking'), null);
});

// --- Wealthsimple --------------------------------------------------------

test('prod shape: Wealthsimple Interac e-Transfer® Received from <name>', () => {
  assert.deepEqual(
    extractCounterparty('Interac e-Transfer® Received from Alexandra McPherson', 'checking'),
    { name: 'Alexandra McPherson', kind: 'person', direction: 'received' },
  );
});

test('prod shape: Wealthsimple Interac e-Transfer® Out to <name>', () => {
  assert.deepEqual(
    extractCounterparty('Interac e-Transfer® Out to Connor Adams RBC Auto', 'checking'),
    { name: 'Connor Adams RBC Auto', kind: 'person', direction: 'sent' },
  );
});

test('prod shape: Wealthsimple bare Interac lines yield null (the email-match set)', () => {
  assert.equal(extractCounterparty('Interac e-Transfer® Received', 'checking'), null);
  assert.equal(extractCounterparty('Interac e-Transfer® Out', 'checking'), null);
});

test('prod shape: Wealthsimple Direct deposit from <payer> captures the payer, not "from ..."', () => {
  assert.deepEqual(extractCounterparty('Direct deposit from ADAMS GREENE HO', 'checking'), {
    name: 'ADAMS GREENE HO',
    kind: 'payroll',
    direction: 'received',
  });
  assert.equal(
    extractCounterparty('Direct deposit from CDG LABS INC', 'checking')?.name,
    'CDG LABS INC',
  );
});

test('prod shape: Wealthsimple Transfer in from <entity>', () => {
  assert.deepEqual(extractCounterparty('Transfer in from CDG Labs Inc.', 'checking'), {
    name: 'CDG Labs Inc.',
    kind: 'person',
    direction: 'received',
  });
});

test('prod shape: Wealthsimple internal account words are not people', () => {
  assert.equal(extractCounterparty('Transfer out to Chequing', 'checking'), null);
  assert.equal(extractCounterparty('Transfer out to Credit Card', 'checking'), null);
  assert.equal(extractCounterparty('Transfer out', 'checking'), null);
  assert.equal(extractCounterparty('Transfer', 'checking'), null);
  assert.equal(extractCounterparty('Money transfer into the account', 'checking'), null);
  assert.equal(extractCounterparty('Money transfer out of the account', 'checking'), null);
  assert.equal(extractCounterparty('Tax-free money transfer out of the account', 'checking'), null);
  assert.equal(extractCounterparty('Cash sent', 'checking'), null);
  assert.equal(extractCounterparty('Cash received', 'checking'), null);
  assert.equal(extractCounterparty('Withdrawal', 'checking'), null);
  assert.equal(extractCounterparty('Deposit', 'checking'), null);
  assert.equal(extractCounterparty('Interest received', 'checking'), null);
  assert.equal(extractCounterparty('Giveaway received', 'checking'), null);
});

// --- Wise ----------------------------------------------------------------

test('prod shape: Wise Sent money to <name>', () => {
  assert.deepEqual(extractCounterparty('Sent money to Stephen Masseur', 'checking'), {
    name: 'Stephen Masseur',
    kind: 'person',
    direction: 'sent',
  });
  assert.equal(
    extractCounterparty('Sent money to CDG Labs Inc.', 'checking')?.name,
    'CDG Labs Inc.',
  );
});

test('prod shape: Wise Received money from <name> with reference <ref>', () => {
  assert.deepEqual(
    extractCounterparty('Received money from Stephen Masseur with reference', 'checking'),
    { name: 'Stephen Masseur', kind: 'person', direction: 'received' },
  );
  assert.equal(
    extractCounterparty(
      'Received money from WANDERCOM with reference INVOICE-4471',
      'checking',
    )?.name,
    'WANDERCOM',
  );
  assert.equal(
    extractCounterparty('Received money from Enzo’s College Fund Inc. with reference', 'checking')
      ?.name,
    'Enzo’s College Fund Inc.',
  );
});

test('prod shape: Wise truncated name with an unbalanced paren is trimmed at the paren', () => {
  assert.equal(
    extractCounterparty('Received money from RBC Bank (Georgi with reference P2P', 'checking')?.name,
    'RBC Bank',
  );
});

// --- Hand-written merchantClean (loan ledger) ---------------------------

test('prod shape: hand-written cash repayment line names the person', () => {
  assert.deepEqual(
    extractCounterparty('Cash repayment from Caelan (ATM deposit KF470333)', 'checking'),
    { name: 'Caelan', kind: 'person', direction: 'received' },
  );
});

// --- Direction on the pre-existing FROM/TO forms -------------------------

test('FROM reads as received and TO reads as sent', () => {
  assert.equal(
    extractCounterparty('INTERAC E-TFR FROM JANE DOE', 'checking')?.direction,
    'received',
  );
  assert.equal(extractCounterparty('INTERAC E-TFR TO MIKE SMITH', 'checking')?.direction, 'sent');
  assert.equal(extractCounterparty('ZELLE FROM SARAH KIM', 'checking')?.direction, 'received');
  assert.equal(extractCounterparty('VENMO CASHOUT TO BOB', 'checking')?.direction, 'sent');
});

test('out-of-scope accounts still return null for every new shape', () => {
  for (const t of OUT_OF_SCOPE) {
    assert.equal(extractCounterparty('E-TRANSFER SENT STEPHEN', t), null);
    assert.equal(extractCounterparty('Sent money to Stephen Masseur', t), null);
    assert.equal(
      extractCounterparty('ONLINE TRANSFER RECEIVED - 8613 CAELAN ANTHONY ITEN-MCGRATH', t),
      null,
    );
  }
});
