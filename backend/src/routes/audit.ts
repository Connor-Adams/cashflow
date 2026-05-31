import { Router } from 'express';
import { Op } from 'sequelize';
import { auditAuth } from '../auth/auditAuth';
import {
  Account,
  Transaction,
  Rule,
  Category,
  Subscription,
  PlannedEvent,
  FinancialGoal,
} from '../models';
import { getIntegrity } from '../audit/integrity';
import { getClientErrors } from '../audit/clientErrorBuffer';
import { getServerErrors } from '../audit/serverErrorBuffer';

const router = Router();

router.use(auditAuth);

router.get('/_ping', (_req, res) => {
  res.json({ ok: true });
});

// GET /api/audit/counts — counts of each primitive scoped to the household
router.get('/counts', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;

    // Get account IDs for the household first
    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    const [
      transactionCount,
      accountCount,
      ruleCount,
      categoryCount,
      subscriptionCount,
      plannedEventCount,
      goalCount,
    ] = await Promise.all([
      accountIds.length > 0
        ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
        : Promise.resolve(0),
      Account.count({ where: { householdId } }),
      Rule.count({ where: { householdId } }),
      Category.count({ where: { householdId } }),
      Subscription.count({ where: { householdId } }),
      PlannedEvent.count({ where: { householdId } }),
      FinancialGoal.count({ where: { householdId } }),
    ]);

    res.json({
      Transaction: transactionCount,
      Account: accountCount,
      Rule: ruleCount,
      Category: categoryCount,
      Subscription: subscriptionCount,
      PlannedEvent: plannedEventCount,
      FinancialGoal: goalCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/audit/integrity — duplicate groups, unenriched txns, orphans
router.get('/integrity', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;
    const result = await getIntegrity(householdId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /api/audit/client-errors — recent client errors for the household
router.get('/client-errors', (req, res) => {
  const householdId = req.auditAuth!.household.id;
  const errors = getClientErrors(householdId);
  res.json({ errors, generatedAt: new Date().toISOString() });
});

// GET /api/audit/server-errors — recent server errors for the household
router.get('/server-errors', (req, res) => {
  const householdId = req.auditAuth!.household.id;
  const errors = getServerErrors(householdId);
  res.json({ errors, generatedAt: new Date().toISOString() });
});

// GET /api/audit/route-probe — DB-level health check for each SPA route
router.get('/route-probe', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    const probes = await Promise.all([
      probe('Account', () => Account.count({ where: { householdId } })),
      probe('Transaction', () =>
        accountIds.length > 0
          ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
          : Promise.resolve(0)
      ),
      probe('Rule', () => Rule.count({ where: { householdId } })),
      probe('Category', () => Category.count({ where: { householdId } })),
      probe('Subscription', () => Subscription.count({ where: { householdId } })),
      probe('PlannedEvent', () => PlannedEvent.count({ where: { householdId } })),
      probe('FinancialGoal', () => FinancialGoal.count({ where: { householdId } })),
    ]);

    res.json({ routes: probes, generatedAt: new Date().toISOString() });
  } catch (e) {
    next(e);
  }
});

async function probe(path: string, fn: () => Promise<number>): Promise<{ path: string; healthy: boolean; rowCount?: number }> {
  const start = Date.now();
  try {
    const rowCount = await fn();
    return { path, healthy: true, rowCount };
  } catch {
    return { path, healthy: false };
  } finally {
    void start; // latency available if needed
  }
}

// GET /api/audit/summary — composite digest of all audit endpoints
router.get('/summary', async (req, res, next) => {
  try {
    const householdId = req.auditAuth!.household.id;

    const accounts = await Account.findAll({
      where: { householdId },
      attributes: ['id'],
      raw: true,
    });
    const accountIds = accounts.map((a) => a.id);

    const [
      transactionCount,
      accountCount,
      ruleCount,
      categoryCount,
      subscriptionCount,
      plannedEventCount,
      goalCount,
      integrity,
    ] = await Promise.all([
      accountIds.length > 0
        ? Transaction.count({ where: { accountId: { [Op.in]: accountIds } } })
        : Promise.resolve(0),
      Account.count({ where: { householdId } }),
      Rule.count({ where: { householdId } }),
      Category.count({ where: { householdId } }),
      Subscription.count({ where: { householdId } }),
      PlannedEvent.count({ where: { householdId } }),
      FinancialGoal.count({ where: { householdId } }),
      getIntegrity(householdId),
    ]);

    const clientErrors = getClientErrors(householdId);
    const serverErrors = getServerErrors(householdId);

    res.json({
      counts: {
        Transaction: transactionCount,
        Account: accountCount,
        Rule: ruleCount,
        Category: categoryCount,
        Subscription: subscriptionCount,
        PlannedEvent: plannedEventCount,
        FinancialGoal: goalCount,
      },
      integrity,
      clientErrorCount: clientErrors.length,
      serverErrorCount: serverErrors.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
