import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuggestion } from '../src/ai/suggestTransaction';
import { scoreTransactionSuggestion } from '../src/ai/evaluateSuggestion';
import { ruleProposalFromRow } from '../src/ai/ruleProposals';
import { parseTransactionAuditIssues } from '../src/ai/auditTransactions';

test('parseSuggestion validates malformed values safely', () => {
  const parsed = parseSuggestion({
    category: ' Dining ',
    business: 'true',
    splitType: 'nobody',
    pctMe: 'not a number',
    pctPartner: 0.5,
    confidence: 'certain',
    evidence: ['similar_history', '', 12],
    needsReview: false,
  });

  assert.equal(parsed.category, 'Dining');
  assert.equal(parsed.business, true);
  assert.equal(parsed.splitType, null);
  assert.equal(parsed.pctMe, null);
  assert.equal(parsed.pctPartner, 0.5);
  assert.equal(parsed.confidence, 'medium');
  assert.deepEqual(parsed.evidence, ['similar_history']);
  assert.equal(parsed.needsReview, false);
});

test('scoreTransactionSuggestion distinguishes accepted from edited', () => {
  const suggestion = parseSuggestion({
    category: 'Groceries',
    business: false,
    splitType: 'shared',
    pctMe: 0.5,
    pctPartner: 0.5,
  });

  assert.equal(
    scoreTransactionSuggestion(suggestion, {
      category: 'Groceries',
      business: false,
      splitType: 'shared',
      pctMe: 0.5,
      pctPartner: 0.5,
      notes: null,
    }).status,
    'accepted',
  );
  assert.equal(
    scoreTransactionSuggestion(suggestion, {
      category: 'Dining',
      business: false,
      splitType: 'shared',
      pctMe: 0.5,
      pctPartner: 0.5,
      notes: null,
    }).status,
    'edited',
  );
});

test('ruleProposalFromRow handles Postgres lowercased aliases', () => {
  assert.deepEqual(
    ruleProposalFromRow({
      merchantclean: '  Metro   Grocery  ',
      category: 'Groceries',
      isbusiness: false,
      splittype: 'shared',
      pctme: '0.5',
      pctpartner: '0.5',
      supportcount: '4',
      exampleids: '7,8,9,10',
    }),
    {
      merchantPattern: 'Metro Grocery',
      category: 'Groceries',
      isBusiness: false,
      splitType: 'shared',
      pctMe: '0.5',
      pctPartner: '0.5',
      supportCount: 4,
      exampleTransactionIds: [7, 8, 9, 10],
    },
  );
});

test('parseTransactionAuditIssues validates audit output safely', () => {
  assert.deepEqual(
    parseTransactionAuditIssues({
      issues: [
        {
          id: 12,
          issueType: 'both',
          currentCategory: 'Dining',
          suggestedCategory: 'Office',
          currentBusiness: 'false',
          suggestedBusiness: true,
          confidence: 'high',
          evidence: ['matching rule', '', 1],
          rationale: 'Merchant history points to office supplies.',
        },
        { id: 'bad', issueType: 'category_mismatch' },
      ],
    }),
    [
      {
        id: 12,
        issueType: 'both',
        currentCategory: 'Dining',
        suggestedCategory: 'Office',
        currentBusiness: false,
        suggestedBusiness: true,
        confidence: 'high',
        evidence: ['matching rule'],
        rationale: 'Merchant history points to office supplies.',
      },
    ],
  );
});
