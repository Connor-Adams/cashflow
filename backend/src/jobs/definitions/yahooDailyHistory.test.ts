import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../models');
let registry: typeof import('../registry');

before(async () => {
  models = await import('../../models');
  await models.sequelize.sync();
  registry = await import('../registry');
  await import('./yahooDailyHistory');
});

after(async () => {
  await models.sequelize.close();
});

test('yahoo_daily_history_refresh is registered and runs the held-securities refresh', async () => {
  const def = registry.listDefinitions().find((d) => d.name === 'yahoo_daily_history_refresh');
  assert.ok(def, 'job is defined');
  const out = await def.handler();
  assert.deepEqual(out.summary, {
    held: 0,
    attempted: 0,
    skippedFresh: 0,
    skippedBackoff: 0,
    skippedUnresolvable: 0,
  });
});
