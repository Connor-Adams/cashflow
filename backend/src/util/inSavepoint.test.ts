import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Household } from '../models';
import { inSavepoint } from './inSavepoint';

before(async () => {
  await sequelize.sync({ force: true });
});

const names = async () => (await Household.findAll({ order: [['id', 'ASC']] })).map((h) => h.name);

test('a failure inside the savepoint is undone; work before it survives', async () => {
  await Household.destroy({ where: {} });
  await sequelize.transaction(async (t) => {
    await Household.create({ name: 'before' } as never, { transaction: t });
    await assert.rejects(
      inSavepoint(t, async (sp) => {
        await Household.create({ name: 'inside' } as never, { transaction: sp });
        throw new Error('boom');
      }),
      /boom/,
    );
    await Household.create({ name: 'after' } as never, { transaction: t });
  });
  assert.deepEqual(await names(), ['before', 'after']);
});

test('a successful savepoint keeps its work', async () => {
  await Household.destroy({ where: {} });
  await sequelize.transaction(async (t) => {
    await inSavepoint(t, (sp) => Household.create({ name: 'kept' } as never, { transaction: sp }));
  });
  assert.deepEqual(await names(), ['kept']);
});

test('without an outer transaction fn runs directly', async () => {
  await Household.destroy({ where: {} });
  const got = await inSavepoint(undefined, async (sp) => {
    assert.equal(sp, undefined);
    return Household.create({ name: 'autocommit' } as never);
  });
  assert.equal(got.name, 'autocommit');
});

// Sequelize names a nested transaction `${rootId}-sp-${parent.savepoints.length}`,
// counting per PARENT, so the first savepoint opened inside the first savepoint
// of a transaction gets the SAME name as its parent. Postgres and SQLite both
// resolve `ROLLBACK TO SAVEPOINT <name>` to the most recent savepoint of that
// name, so when the enclosing savepoint later rolls back it only rewinds to the
// inner one and keeps everything written before it. inSavepoint must not shadow
// the caller's savepoint.
test('rolling back the enclosing savepoint still undoes work done before a nested inSavepoint', async () => {
  await Household.destroy({ where: {} });
  await sequelize.transaction(async (t) => {
    await assert.rejects(
      sequelize.transaction({ transaction: t }, async (row) => {
        await Household.create({ name: 'row write' } as never, { transaction: row });
        await inSavepoint(row, (sp) =>
          Household.create({ name: 'audit row' } as never, { transaction: sp }),
        );
        throw new Error('row failed after the best-effort write');
      }),
      /row failed/,
    );
  });
  assert.deepEqual(await names(), [], 'the whole row, including the nested write, is rolled back');
});
