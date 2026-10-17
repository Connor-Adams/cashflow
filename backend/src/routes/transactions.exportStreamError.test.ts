/**
 * GET /api/transactions/export — a failure AFTER the CSV stream has started
 * (headers + header row already flushed) must abort the connection, not end it
 * cleanly. A clean `res.end()` hands the browser a well-formed, truncated CSV
 * that looks like a complete export.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { sequelize, Transaction } from '../models';
import { seedHousehold } from '../../test/helpers/seedHousehold';

process.env.NODE_ENV = 'test';

let agent: ReturnType<typeof request.agent>;

before(async () => {
  await sequelize.sync({ force: true });
  const seeded = await seedHousehold('export-stream-error', 'Partner');
  const { default: app } = await import('../app.js');
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  mock.restoreAll();
});

test('a DB error mid-stream aborts the download instead of ending it as a complete CSV', async () => {
  const findAll = mock.method(Transaction, 'findAll', async () => {
    throw new Error('db connection lost mid-export');
  });
  try {
    await assert.rejects(
      async () => {
        await agent.get('/api/transactions/export').buffer(true);
      },
      'expected the export request to fail visibly, not resolve with a truncated CSV',
    );
    assert.ok(findAll.mock.callCount() >= 1, 'export should have reached the paged query');
  } finally {
    findAll.mock.restore();
  }
});
