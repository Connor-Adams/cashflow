/**
 * The compute-and-cache core behind `GET /api/tax/personal/:year/return` and
 * `GET /api/tax/corp/:fiscalYear/return`.
 *
 * Both handlers carried an identical 45-line block — find the `TaxReturn` row,
 * compare a facts hash, run the engine on a mismatch, update-or-create. It was
 * reachable only through supertest with a fully seeded household, which is why
 * its one "test" asserted `status === 404 || status === 200` and proved nothing.
 *
 * The case that matters: a row keyed by an OLDER engine must not be served.
 * Every `TaxReturn` row in prod was keyed on facts alone, so the slip-box, FHSA
 * and 2026 rate corrections would change no number on screen without this.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Entity, Household, TaxReturn } from '../../models';
import { computeEntityReturn, factsDigest } from './computeEntityReturn';
import { D } from '../util/decimal';
import type { EngineReturn } from '../scenarios/computeScenarioReturn';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
  const household = await Household.create({ name: 'T' });
  return Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
}

const FACTS = { income: D('1000'), nested: { credit: D('55.5') } };

/** Counts invocations so "did the engine actually run?" is observable. */
function countingEngine(payable: string) {
  let runs = 0;
  const run = (): EngineReturn => {
    runs += 1;
    return {
      lines: [{ code: 'L1', label: 'One', amount: D('1'), inputs: [] }],
      totals: { totalPayable: D(payable) },
      warnings: [],
    };
  };
  return { run, runs: () => runs };
}

test('a first call runs the engine and persists a cache row', async () => {
  const entity = await seedEntity();
  const engine = countingEngine('100');
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: engine.run,
  });
  assert.equal(res.cached, false);
  assert.equal(engine.runs(), 1);
  const rows = await TaxReturn.findAll({ where: { entityId: entity.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].year, 2026);
});

test('a second call with identical facts and engine is served from cache', async () => {
  const entity = await seedEntity();
  await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  const second = countingEngine('100');
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: second.run,
  });
  assert.equal(res.cached, true);
  assert.equal(second.runs(), 0, 'engine must not re-run on a cache hit');
});

test('a row keyed without the engine version is ignored, not served', async () => {
  const entity = await seedEntity();
  // Exactly the shape of every TaxReturn row in prod: the facts digest with no
  // engine component. Its totals are absurd so a stale hit is unmistakable.
  await TaxReturn.create({
    entityId: entity.id,
    year: 2026,
    factsHash: factsDigest(FACTS),
    computedAt: new Date(),
    lines: [],
    totals: { totalPayable: '999999.00' },
    warnings: [],
  } as never);

  const engine = countingEngine('100');
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: engine.run,
  });
  assert.equal(res.cached, false, 'a legacy-keyed row must not satisfy the cache');
  assert.equal(engine.runs(), 1);
  assert.deepEqual(res.totals, { totalPayable: '100.00' });
});

test('a stale row is updated in place, not duplicated', async () => {
  // The route relies on one row per (entity, year): the corp path keys on the
  // fiscal year's start year, and two rows would make which one wins arbitrary.
  const entity = await seedEntity();
  await TaxReturn.create({
    entityId: entity.id, year: 2026, factsHash: factsDigest(FACTS),
    computedAt: new Date(), lines: [], totals: {}, warnings: [],
  } as never);
  await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  const rows = await TaxReturn.findAll({ where: { entityId: entity.id, year: 2026 } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].totals, { totalPayable: '100.00' });
});

test('changed facts invalidate the cache', async () => {
  const entity = await seedEntity();
  await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  const engine = countingEngine('200');
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026,
    facts: { income: D('2000'), nested: { credit: D('55.5') } },
    run: engine.run,
  });
  assert.equal(res.cached, false);
  assert.equal(engine.runs(), 1);
});

test('the facts digest ignores Decimal internals but not Decimal values', async () => {
  // buildPersonalFacts hands over Decimal instances; hashing their `s`/`e`/`d`
  // internals would make the key depend on representation rather than value.
  assert.equal(factsDigest({ a: D('1.50') }), factsDigest({ a: D('1.5') }));
  assert.notEqual(factsDigest({ a: D('1.5') }), factsDigest({ a: D('1.6') }));
});

test('Decimals serialise into the response as fixed strings', async () => {
  const entity = await seedEntity();
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  assert.deepEqual(res.lines, [
    { code: 'L1', label: 'One', amount: '1.00', inputs: [] },
  ]);
});

test('a miss exposes the raw engine return for post-processing', async () => {
  // The personal route feeds it to rollPersonalCarryforwards, which needs
  // Decimals rather than the serialised response values.
  const entity = await seedEntity();
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  assert.equal(res.cached, false);
  if (res.cached) throw new Error('unreachable');
  assert.equal(res.engineReturn.totals.totalPayable.toFixed(2), '100.00');
});

test('warnings are shared by reference so a late push reaches the response', async () => {
  // Locks the quirk the original handler had: a carryforward-roll failure is
  // appended after the row is written, so the response warns and the row does not.
  const entity = await seedEntity();
  const res = await computeEntityReturn({
    entityId: entity.id, cacheYear: 2026, facts: FACTS, run: countingEngine('100').run,
  });
  res.warnings.push('carryforward_roll_failed');
  const row = await TaxReturn.findOne({ where: { entityId: entity.id, year: 2026 } });
  assert.deepEqual(row!.warnings, []);
  assert.deepEqual(res.warnings, ['carryforward_roll_failed']);
});
