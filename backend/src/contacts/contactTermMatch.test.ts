import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactMatchTerms, matchContactsByTerms } from './contactTermMatch';

const caelan = { id: 1, name: 'Caelan', normalizedName: 'caelan', aliases: 'iten-mcgrath' };
const stephen = { id: 4, name: 'STEPHEN MASSEUR', normalizedName: 'stephen masseur', aliases: null };

test('contactMatchTerms includes name + aliases, drops <3 char terms', () => {
  assert.deepEqual(contactMatchTerms({ id: 9, name: 'Al', normalizedName: 'al', aliases: 'jo, xavier' }), ['xavier']);
  assert.deepEqual(contactMatchTerms(caelan).sort(), ['caelan', 'iten-mcgrath'].sort());
});

test('matchContactsByTerms finds unambiguous matches in merchant text', () => {
  assert.deepEqual(matchContactsByTerms('ONLINE TRANSFER RECEIVED - 5552 CAELAN ANTHONY ITEN-MCGRATH', [caelan, stephen]), [1]);
  assert.deepEqual(matchContactsByTerms('E-TRANSFER RECEIVED STEPHEN MASSEUR', [caelan, stephen]), [4]);
});

test('matchContactsByTerms returns multiple ids when ambiguous', () => {
  const steph2 = { id: 7, name: 'Stephen B', normalizedName: 'stephen b', aliases: 'masseur' };
  const ids = matchContactsByTerms('PAYMENT STEPHEN MASSEUR', [stephen, steph2]).sort();
  assert.deepEqual(ids, [4, 7]);
});

test('matchContactsByTerms returns empty when no term matches', () => {
  assert.deepEqual(matchContactsByTerms('TIM HORTONS #123', [caelan, stephen]), []);
});

// --- Bug fix: word-boundary matching ---

const dad = { id: 3, name: 'Dad', normalizedName: 'dad', aliases: null };
const evan = { id: 5, name: 'Evan', normalizedName: 'evan', aliases: null };

test('matchContactsByTerms does NOT match "dad" inside reference token H9UDAD (false positive bug)', () => {
  assert.deepEqual(
    matchContactsByTerms('E-TRANSFER SENT WEALTHSIMPLE CASH H9UDAD', [dad]),
    [],
  );
});

test('matchContactsByTerms still matches caelan and hyphenated alias iten-mcgrath as bounded tokens', () => {
  assert.deepEqual(
    matchContactsByTerms('ONLINE TRANSFER RECEIVED - 5552 CAELAN ANTHONY ITEN-MCGRATH', [caelan]),
    [1],
  );
});

test('matchContactsByTerms still matches multi-word term "stephen masseur"', () => {
  assert.deepEqual(
    matchContactsByTerms('E-TRANSFER RECEIVED STEPHEN MASSEUR', [stephen]),
    [4],
  );
});

test('matchContactsByTerms does NOT match "evan" inside "relevant" or "evangeline", but DOES match "EVAN SMITH"', () => {
  assert.deepEqual(matchContactsByTerms('this is relevant', [evan]), []);
  assert.deepEqual(matchContactsByTerms('EVANGELINE STREET PAYMENT', [evan]), []);
  assert.deepEqual(matchContactsByTerms('EVAN SMITH TRANSFER', [evan]), [5]);
});
