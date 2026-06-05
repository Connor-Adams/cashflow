import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import {
  spouseRouter,
  type SpouseRouterPersonalInput,
} from './spouseRouter';

test('no splits set → empty byEntityId, no warnings', () => {
  const inputs: SpouseRouterPersonalInput[] = [
    {
      scenarioId: 1,
      entityId: 10,
      spouseEntityId: 20,
      pensionSplitTransferOut: D('0'),
    },
    {
      scenarioId: 2,
      entityId: 20,
      spouseEntityId: 10,
      pensionSplitTransferOut: D('0'),
    },
  ];
  const out = spouseRouter(inputs);
  assert.deepEqual(out.byEntityId, {});
  assert.equal(out.warnings.length, 0);
});

test('A→B split: A has transferOut, B has transferIn equal', () => {
  const inputs: SpouseRouterPersonalInput[] = [
    {
      scenarioId: 1,
      entityId: 10,
      spouseEntityId: 20,
      pensionSplitTransferOut: D('15000'),
    },
    {
      scenarioId: 2,
      entityId: 20,
      spouseEntityId: 10,
      pensionSplitTransferOut: D('0'),
    },
  ];
  const out = spouseRouter(inputs);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.byEntityId[10].pensionSplitTransferOut.toFixed(2), '15000.00');
  assert.equal(out.byEntityId[10].pensionSplitTransferIn.toFixed(2), '0.00');
  assert.equal(out.byEntityId[20].pensionSplitTransferIn.toFixed(2), '15000.00');
  assert.equal(out.byEntityId[20].pensionSplitTransferOut.toFixed(2), '0.00');
});

test('split with no spouse linked → warning + no shift', () => {
  const inputs: SpouseRouterPersonalInput[] = [
    {
      scenarioId: 1,
      entityId: 10,
      spouseEntityId: null,
      pensionSplitTransferOut: D('15000'),
    },
  ];
  const out = spouseRouter(inputs);
  assert.deepEqual(out.byEntityId, {});
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].severity, 'warning');
  assert.equal(out.warnings[0].entityId, 10);
  assert.match(out.warnings[0].message, /no spouse linked/);
});

test('split when spouse has no scenario in plan → warning + no shift', () => {
  const inputs: SpouseRouterPersonalInput[] = [
    {
      scenarioId: 1,
      entityId: 10,
      spouseEntityId: 999,
      pensionSplitTransferOut: D('15000'),
    },
  ];
  const out = spouseRouter(inputs);
  assert.deepEqual(out.byEntityId, {});
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].severity, 'warning');
  assert.equal(out.warnings[0].entityId, 10);
  assert.match(out.warnings[0].message, /no scenario in this plan/);
});

test('bidirectional split (A→B AND B→A): both shifts on both entities', () => {
  const inputs: SpouseRouterPersonalInput[] = [
    {
      scenarioId: 1,
      entityId: 10,
      spouseEntityId: 20,
      pensionSplitTransferOut: D('15000'),
    },
    {
      scenarioId: 2,
      entityId: 20,
      spouseEntityId: 10,
      pensionSplitTransferOut: D('8000'),
    },
  ];
  const out = spouseRouter(inputs);
  assert.equal(out.warnings.length, 0);
  // Entity 10 sends 15000 out, receives 8000 in
  assert.equal(out.byEntityId[10].pensionSplitTransferOut.toFixed(2), '15000.00');
  assert.equal(out.byEntityId[10].pensionSplitTransferIn.toFixed(2), '8000.00');
  // Entity 20 sends 8000 out, receives 15000 in
  assert.equal(out.byEntityId[20].pensionSplitTransferOut.toFixed(2), '8000.00');
  assert.equal(out.byEntityId[20].pensionSplitTransferIn.toFixed(2), '15000.00');
});
