/**
 * A brokerage statement import is ONE unit of work: its ledger rows and the
 * portfolio cache invalidations they trigger (daily snapshots dropped, forward
 * projections marked stale) commit together or not at all.
 *
 * The invalidations come from model hooks (hooks/dailySnapshotStaleHooks.ts,
 * hooks/forwardIncomeStaleHooks.ts). They used to defer to `afterCommit` and run
 * on the global connection — but the importer inserts each row inside a
 * SAVEPOINT, and Sequelize fires a savepoint's afterCommit hooks while the outer
 * transaction is still open. On this suite's SQLite DB every such write waited
 * on the import's own write lock (busy_timeout x Sequelize's SQLITE_BUSY retry)
 * for ~25s per row; on Postgres it applied the invalidation before — and
 * independently of — the import's commit.
 *
 * The statement is the synthetic Wealthsimple brokerage PDF from #1211, parsed
 * by the real parser (two holdings, a CONT, a BUY and an FPLINT row).
 */
import { before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { resetTestDb } from '../../test/helpers/resetTestDb';
import { synthPdf, synthPdfLines } from '../../test/helpers/syntheticPdf';
import {
  SYN_WS_ACCOUNT,
  SYN_WS_BROKERAGE,
  SYN_WS_FILENAME,
} from '../../test/helpers/syntheticStatements';
import type { StatementPreview } from './statementTypes';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;
let parseStatementFile: typeof import('./parseStatementFile.js').parseStatementFile;

let householdId: number;
let accountId: number;
let smplSecurityId: number;

before(async () => {
  models = await import('../models/index.js');
  ({ commitStatementImport } = await import('./commitStatementImport.js'));
  ({ parseStatementFile } = await import('./parseStatementFile.js'));
});

beforeEach(async () => {
  await resetTestDb(models.sequelize);
  const hh = await models.Household.create({ name: 'Atomic HH' } as never);
  householdId = hh.id;
  const account = await models.Account.create({
    name: 'WS TFSA', householdId, accountType: 'investment', owner: 'me',
    visibility: 'private', defaultCurrency: 'CAD', shortCode: SYN_WS_ACCOUNT,
  } as never);
  accountId = account.id as number;
  // The statement's SMPL holding and BUY resolve to this security, so its
  // forward projection is one the import must mark stale.
  const smpl = await models.Security.create({
    householdId, symbol: 'SMPL', currency: 'CAD', name: 'Sample Index ETF', assetType: 'etf',
  } as never);
  smplSecurityId = smpl.id as number;
  await models.PortfolioForwardProjection.create({
    householdId, securityId: smplSecurityId, qtyBasis: '1', currency: 'CAD',
    cadenceLabel: 'quarterly', computedAt: new Date(), staleAt: null,
  } as never);
  // A cached daily snapshot dated after every activity on the statement.
  await models.PortfolioDailySnapshot.create({
    householdId, accountId, date: '2024-05-20', marketValueNative: '0', currency: 'CAD',
    fxRateToCad: '1', marketValueCad: '0', computedAt: new Date(),
  } as never);
});

async function parseSyntheticBrokerage(): Promise<StatementPreview> {
  const preview = await parseStatementFile({
    buffer: synthPdf(SYN_WS_BROKERAGE),
    fileName: SYN_WS_FILENAME,
    accountId,
    householdId,
    preExtractedLines: synthPdfLines(SYN_WS_BROKERAGE),
  });
  if ('ok' in preview && preview.ok === false) throw new Error(preview.error);
  const p = preview as StatementPreview;
  assert.ok(p.investmentActivities.length > 0, 'fixture should yield activities');
  assert.ok(p.holdings.length > 0, 'fixture should yield holdings');
  return p;
}

/**
 * Record every write issued with no transaction while an import transaction
 * is open. Root `sequelize.transaction(cb)` calls are tracked from the moment
 * the callback starts until it returns (i.e. until COMMIT is issued).
 */
function watchNonTransactionalWrites(): { writes: string[]; restore: () => void } {
  const seq = models.sequelize;
  const open = new Set<SequelizeTransaction>();
  const writes: string[] = [];
  const origTransaction = seq.transaction.bind(seq) as (...a: unknown[]) => Promise<unknown>;
  const origQuery = seq.query.bind(seq) as (...a: unknown[]) => Promise<unknown>;
  const s = seq as unknown as Record<string, unknown>;
  s.transaction = (...args: unknown[]) => {
    const cb = args[args.length - 1];
    const opts = args.length > 1 ? (args[0] as { transaction?: unknown }) : {};
    if (typeof cb !== 'function' || opts?.transaction) return origTransaction(...args);
    const wrapped = async (t: SequelizeTransaction) => {
      open.add(t);
      try {
        return await (cb as (t: SequelizeTransaction) => Promise<unknown>)(t);
      } finally {
        open.delete(t);
      }
    };
    return args.length > 1 ? origTransaction(args[0], wrapped) : origTransaction(wrapped);
  };
  s.query = (sql: unknown, options?: { transaction?: unknown }) => {
    const text = typeof sql === 'string' ? sql : String((sql as { query?: string })?.query ?? '');
    if (open.size > 0 && !options?.transaction && !/^\s*(SELECT|PRAGMA)\b/i.test(text)) {
      writes.push(text.slice(0, 160));
    }
    return origQuery(sql, options);
  };
  return {
    writes,
    restore: () => {
      delete s.transaction;
      delete s.query;
    },
  };
}

test('importing a brokerage statement issues no write outside its transaction, and finishes fast', async () => {
  const preview = await parseSyntheticBrokerage();
  const watch = watchNonTransactionalWrites();
  const started = Date.now();
  let result: Awaited<ReturnType<typeof commitStatementImport>>;
  try {
    result = await commitStatementImport(preview, null, householdId);
  } finally {
    watch.restore();
  }
  const elapsedMs = Date.now() - started;

  assert.deepEqual(watch.writes, [], 'every write during the import must use the import transaction');
  // One SQLite lock wait is busy_timeout = 5000ms; a handful of rows with no
  // lock contention commits in well under a second.
  assert.ok(elapsedMs < 4000, `import took ${elapsedMs}ms — a write is waiting on the import's own lock`);

  assert.ok(result.insertedInvestmentActivities > 0);
  assert.ok(result.insertedHoldings > 0);
  // The invalidations still happen — threaded, not dropped.
  assert.equal(await models.PortfolioDailySnapshot.count({ where: { householdId } }), 0);
  const proj = await models.PortfolioForwardProjection.findOne({
    where: { householdId, securityId: smplSecurityId },
  });
  assert.ok(proj?.staleAt, 'forward projection for an imported security is marked stale');
});

test('an import that fails mid-way leaves no ledger rows and no portfolio invalidation', async () => {
  const preview = await parseSyntheticBrokerage();
  // The last write inside the import transaction: by now every activity,
  // holding and their hook-driven invalidations have run.
  const boom = mock.method(models.ImportHistory, 'create', async () => {
    throw new Error('forced failure after the rows were written');
  });
  try {
    await assert.rejects(
      commitStatementImport(preview, null, householdId),
      /forced failure/,
    );
  } finally {
    boom.mock.restore();
  }

  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 0);
  assert.equal(await models.HoldingSnapshot.count({ where: { accountId } }), 0);
  assert.equal(await models.ImportHistory.count(), 0);
  // The cache was not invalidated for a ledger change that never happened.
  assert.equal(await models.PortfolioDailySnapshot.count({ where: { householdId } }), 1);
  const proj = await models.PortfolioForwardProjection.findOne({
    where: { householdId, securityId: smplSecurityId },
  });
  assert.equal(proj?.staleAt ?? null, null);
});

test('a foreign-currency income row resolves its FX rate before the import transaction opens', async () => {
  const preview = await parseSyntheticBrokerage();
  // A USD staking reward on this CAD account is re-expressed in CAD, which
  // needs a USD→CAD rate. None is cached, so ensureFxRate fetches one from the
  // Bank of Canada (stubbed) and caches it — global reference data that must
  // not ride inside, or wait on, the statement's transaction.
  preview.investmentActivities.push({
    activityType: 'staking_reward', tradeDate: '2024-05-20', settlementDate: null,
    description: 'Staking reward', security: null, quantity: null, price: null,
    amount: 2, fees: null, currency: 'USD', sourceReference: null,
    sourceRowFingerprint: 'synthetic-staking-usd',
  });
  const fetchStub = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ observations: [{ d: '2024-05-17', FXUSDCAD: { v: '1.5' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  );
  const watch = watchNonTransactionalWrites();
  try {
    await commitStatementImport(preview, null, householdId);
  } finally {
    watch.restore();
    fetchStub.mock.restore();
  }

  assert.deepEqual(watch.writes, [], 'the FxRate cache write must happen before the transaction opens');
  assert.equal(await models.FxRate.count({ where: { fromCurrency: 'USD', toCurrency: 'CAD' } }), 1);
  const reward = await models.InvestmentActivity.findOne({
    where: { accountId, sourceRowFingerprint: 'synthetic-staking-usd' },
  });
  assert.equal(reward?.currency, 'CAD');
  assert.equal(Number(reward?.amount), 3);
});
