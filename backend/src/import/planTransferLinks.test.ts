import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransferLinks } from './planTransferLinks';

const caelan = { id: 1, name: 'Caelan', normalizedName: 'caelan', aliases: 'iten-mcgrath' };
const stephen = { id: 4, name: 'STEPHEN MASSEUR', normalizedName: 'stephen masseur', aliases: null };

test('partitions rows into unambiguous and ambiguous', () => {
  const plan = planTransferLinks(
    [
      { id: 10, merchantText: 'ONLINE TRANSFER RECEIVED - CAELAN ANTHONY ITEN-MCGRATH' },
      { id: 11, merchantText: 'E-TRANSFER STEPHEN MASSEUR' },
      { id: 12, merchantText: 'TIM HORTONS' },
    ],
    [caelan, stephen],
  );
  assert.deepEqual(plan.unambiguous, [
    { txnId: 10, contactId: 1 },
    { txnId: 11, contactId: 4 },
  ]);
  assert.deepEqual(plan.ambiguous, []);
});

test('rows matching >1 contact go to ambiguous, not unambiguous', () => {
  const steph2 = { id: 7, name: 'Stephen B', normalizedName: 'stephen b', aliases: 'masseur' };
  const plan = planTransferLinks([{ id: 20, merchantText: 'PAY STEPHEN MASSEUR' }], [stephen, steph2]);
  assert.deepEqual(plan.unambiguous, []);
  assert.deepEqual(plan.ambiguous, [{ txnId: 20, merchantText: 'PAY STEPHEN MASSEUR', contactIds: [4, 7] }]);
});
