import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFanoutCleanup, type AcceptedLinkRow } from '../src/amazon/fanoutCleanup';

const link = (
  id: number,
  transactionId: number,
  confidence: number | string,
  status = 'accepted',
): AcceptedLinkRow => ({ id, transactionId, confidence, status });

test('targets every sub-threshold link in a many-to-one accepted cluster', () => {
  // txn 94: 10 accepted links all at confidence 50.
  const links = Array.from({ length: 10 }, (_, i) => link(i + 1, 94, 50));
  const plan = planFanoutCleanup(links);
  assert.deepEqual(plan.rejectIds.sort((a, b) => a - b), links.map((l) => l.id));
  assert.deepEqual(plan.affectedTransactionIds, [94]);
});

test('keeps the strong link, rejects only the sub-threshold siblings', () => {
  const links = [
    link(1, 88, 90), // legitimate match — keep
    link(2, 88, 50),
    link(3, 88, 50),
    link(4, 88, 15),
  ];
  const plan = planFanoutCleanup(links);
  assert.deepEqual(plan.rejectIds.sort((a, b) => a - b), [2, 3, 4]);
  const cluster = plan.manyToOneClusters.find((c) => c.transactionId === 88);
  assert.equal(cluster?.keptStrong, 1);
  assert.equal(cluster?.subThreshold, 3);
});

test('leaves a many-to-one cluster where both links clear the threshold (legit split)', () => {
  // txn 157 in prod: confidence 75 + 90 — both above threshold, untouched.
  const plan = planFanoutCleanup([link(1, 157, 75), link(2, 157, 90)]);
  assert.deepEqual(plan.rejectIds, []);
  assert.deepEqual(plan.affectedTransactionIds, []);
});

test('does NOT touch a lone (1:1) sub-threshold accepted link, but reports it', () => {
  const plan = planFanoutCleanup([link(1, 500, 50)]);
  assert.deepEqual(plan.rejectIds, []);
  assert.equal(plan.loneSubThreshold, 1);
});

test('only accepted links count toward the many-to-one cluster size', () => {
  // 1 accepted + 2 suggested + 1 rejected → not a many-to-one ACCEPTED cluster.
  const plan = planFanoutCleanup([
    link(1, 600, 50, 'accepted'),
    link(2, 600, 50, 'suggested'),
    link(3, 600, 50, 'suggested'),
    link(4, 600, 50, 'rejected'),
  ]);
  assert.deepEqual(plan.rejectIds, []);
  assert.equal(plan.loneSubThreshold, 1);
});

test('parses DECIMAL confidence delivered as a string', () => {
  const links = [link(1, 94, '50.00'), link(2, 94, '50.00'), link(3, 94, '90.00')];
  const plan = planFanoutCleanup(links);
  assert.deepEqual(plan.rejectIds.sort((a, b) => a - b), [1, 2]);
});

test('matches the prod population: 37 reject ids across 8 txns, plus lone reports', () => {
  const rows: AcceptedLinkRow[] = [];
  let id = 1;
  const cluster = (txn: number, count: number, conf: number) => {
    for (let i = 0; i < count; i++) rows.push(link(id++, txn, conf));
  };
  cluster(94, 10, 50);
  cluster(224, 9, 50);
  cluster(116, 5, 50);
  cluster(88, 4, 15);
  cluster(154, 3, 50);
  cluster(191, 2, 50);
  cluster(247, 2, 50);
  cluster(192, 2, 65);
  // txn 157: 75 + 90, both above threshold — left alone.
  rows.push(link(id++, 157, 75), link(id++, 157, 90));
  // 19 lone sub-threshold accepted links on distinct txns.
  for (let i = 0; i < 19; i++) rows.push(link(id++, 1000 + i, 50));

  const plan = planFanoutCleanup(rows);
  assert.equal(plan.rejectIds.length, 37);
  assert.equal(plan.affectedTransactionIds.length, 8);
  assert.equal(plan.loneSubThreshold, 19);
});
