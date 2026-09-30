/**
 * The shared compute-and-cache core, exercised through its injected seams.
 *
 * The case that matters: a cached row written by an OLDER engine must not be
 * served. Every row in prod today was keyed on the facts alone, so without this
 * the slip-box and FHSA corrections change no number a user can see — the facts
 * are unchanged, the key matches, the stale row wins.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import { Entity, Household, Scenario, ScenarioReturn } from '../../models';
import { computeScenarioReturn, hashFacts, type EngineReturn } from './computeScenarioReturn';
import { D } from '../util/decimal';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedScenario() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  return Scenario.create({
    entityId: entity.id, year: 2026, kind: 'baseline', name: 'Baseline',
    parentId: null, overrides: {}, assumptions: {},
  } as never);
}

const FACTS = { income: D('1000') };
const resolve = async () => FACTS;

/** Counts invocations so "did the engine actually run?" is observable. */
function countingEngine(payable: string) {
  let runs = 0;
  const engine = (): EngineReturn => {
    runs += 1;
    return { lines: [], totals: { totalPayable: payable }, warnings: [] };
  };
  return { engine, runs: () => runs };
}

test('a second call with identical facts and engine is served from cache', async () => {
  const scenario = await seedScenario();
  const first = countingEngine('100');
  await computeScenarioReturn(scenario.id, resolve, first.engine);
  const second = countingEngine('100');
  const result = await computeScenarioReturn(scenario.id, resolve, second.engine);
  assert.equal(result.cached, true);
  assert.equal(second.runs(), 0, 'engine must not re-run on a cache hit');
});

test('a row keyed without the engine version is ignored, not served', async () => {
  // Exactly the shape of every ScenarioReturn row already in prod: the facts
  // digest with no engine component. Its totals are deliberately wrong so a
  // stale hit is unmistakable.
  const scenario = await seedScenario();
  const legacyKey = hashFacts(FACTS);

  await ScenarioReturn.create({
    scenarioId: scenario.id,
    factsHash: legacyKey,
    computedAt: new Date(),
    lines: [],
    totals: { totalPayable: '999999.00' },
    warnings: [],
  } as never);

  const fresh = countingEngine('100');
  const result = await computeScenarioReturn(scenario.id, resolve, fresh.engine);
  assert.equal(result.cached, false, 'a legacy-keyed row must not satisfy the cache');
  assert.equal(fresh.runs(), 1);
  assert.equal(result.totals.totalPayable, '100');
  assert.notEqual(result.factsHash, legacyKey, 'the stored key must carry the engine version');
});

test('the stored key is the versioned key, so the next call hits', async () => {
  const scenario = await seedScenario();
  const first = countingEngine('100');
  const a = await computeScenarioReturn(scenario.id, resolve, first.engine);
  const rows = await ScenarioReturn.findAll({ where: { scenarioId: scenario.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].factsHash, a.factsHash);
});
