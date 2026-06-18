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
