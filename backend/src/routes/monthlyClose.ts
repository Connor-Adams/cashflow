/**
 * /api/monthly-close — Monthly close workflow (issue #227).
 *
 * Exposes:
 *   GET    /                   list periods for the caller's household
 *   GET    /:periodMonth       get a period (creates a transient view if
 *                              none exists) with tasks + critical-items
 *   POST   /:periodMonth/start idempotent: ensure a period exists with the
 *                              default checklist
 *   PATCH  /:periodMonth/tasks/:taskKey  toggle is_complete (or update notes)
 *   POST   /:periodMonth/close  mark the period closed (records closed_at)
 *   POST   /:periodMonth/reopen reopen a closed period
 *
 * All endpoints are auth-scoped to the caller's household via
 * `householdWhere`. The route shares the global `aiSuggestLimiter` —
 * CodeQL flags any new authenticated route without an explicit limiter
 * (see previous PR #273 finding). The limiter is no-op in `NODE_ENV=test`.
 */
import { Router } from 'express';
import { MonthlyClosePeriod, MonthlyCloseTask } from '../models';
import {
  DEFAULT_MONTHLY_CLOSE_TASKS,
  MONTHLY_CLOSE_TASK_KEYS,
  type MonthlyCloseTaskKey,
} from '../models/MonthlyCloseTask';
import { type MonthlyCloseStatus } from '../models/MonthlyClosePeriod';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';
import { detectMonthlyCloseCritical } from '../cashflow/monthlyCloseCritical';

const router = Router();

const PERIOD_MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_NOTES_LENGTH = 4096;

/**
 * Pure validator: returns true when the string is a 'YYYY-MM' with a
 * sensible year (1900–9999) and month (01–12). Exported for unit tests.
 */
export function isValidPeriodMonth(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !PERIOD_MONTH_RE.test(raw)) return false;
  const [yearStr, monthStr] = raw.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  return true;
}

function normalizeNotes(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return String(raw).slice(0, MAX_NOTES_LENGTH);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NOTES_LENGTH);
}

type PeriodResponse = {
  id: number;
  householdId: number;
  userId: number;
  periodMonth: string;
  status: MonthlyCloseStatus;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function serializePeriod(
  row: InstanceType<typeof MonthlyClosePeriod>,
): PeriodResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    periodMonth: row.periodMonth,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type TaskResponse = {
  id: number;
  periodId: number;
  taskKey: MonthlyCloseTaskKey;
  isComplete: boolean;
  completedAt: string | null;
  completedByUserId: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function serializeTask(row: InstanceType<typeof MonthlyCloseTask>): TaskResponse {
  return {
    id: row.id,
    periodId: row.periodId,
    taskKey: row.taskKey as MonthlyCloseTaskKey,
    isComplete: row.isComplete,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completedByUserId: row.completedByUserId,
    notes: row.notes,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadTasks(
  periodId: number,
): Promise<InstanceType<typeof MonthlyCloseTask>[]> {
  return (await MonthlyCloseTask.findAll({
    where: { periodId },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  })) as InstanceType<typeof MonthlyCloseTask>[];
}

router.get('/', aiSuggestLimiter, async (req, res, next) => {
  try {
    const rows = (await MonthlyClosePeriod.findAll({
      where: { ...householdWhere(req) },
      order: [
        ['periodMonth', 'DESC'],
        ['id', 'DESC'],
      ],
    })) as InstanceType<typeof MonthlyClosePeriod>[];
    res.json({ data: rows.map(serializePeriod) });
  } catch (e) {
    next(e);
  }
});

router.get('/:periodMonth', aiSuggestLimiter, async (req, res, next) => {
  try {
    const periodMonth = req.params.periodMonth;
    if (!isValidPeriodMonth(periodMonth)) {
      res.status(400).json({ error: 'periodMonth must be YYYY-MM' });
      return;
    }
    const period = (await MonthlyClosePeriod.findOne({
      where: { periodMonth, ...householdWhere(req) },
    })) as InstanceType<typeof MonthlyClosePeriod> | null;
    if (!period) {
      // Surface a "not yet started" view so the frontend can render a
      // "Start close" CTA without needing a second roundtrip.
      const critical = await detectMonthlyCloseCritical(
        householdWhere(req) as Record<string, unknown>,
        periodMonth,
      );
      res.json({
        period: null,
        tasks: [],
        critical,
      });
      return;
    }
    const tasks = await loadTasks(period.id);
    const critical = await detectMonthlyCloseCritical(
      householdWhere(req) as Record<string, unknown>,
      period.periodMonth,
    );
    res.json({
      period: serializePeriod(period),
      tasks: tasks.map(serializeTask),
      critical,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:periodMonth/start', aiSuggestLimiter, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const periodMonth = req.params.periodMonth;
    if (!isValidPeriodMonth(periodMonth)) {
      res.status(400).json({ error: 'periodMonth must be YYYY-MM' });
      return;
    }

    // Idempotent: if a period for this (household, month) already exists,
    // return it. Otherwise create + seed the default tasks.
    let period = (await MonthlyClosePeriod.findOne({
      where: { periodMonth, householdId: household.id },
    })) as InstanceType<typeof MonthlyClosePeriod> | null;

    if (!period) {
      const now = new Date();
      period = (await MonthlyClosePeriod.create({
        householdId: household.id,
        userId: user.id,
        periodMonth,
        status: 'open',
        openedAt: now,
        closedAt: null,
        notes: null,
      })) as InstanceType<typeof MonthlyClosePeriod>;
      await MonthlyCloseTask.bulkCreate(
        DEFAULT_MONTHLY_CLOSE_TASKS.map((spec) => ({
          periodId: period!.id,
          taskKey: spec.taskKey,
          isComplete: false,
          completedAt: null,
          completedByUserId: null,
          notes: null,
          sortOrder: spec.sortOrder,
        })),
      );
    }

    const tasks = await loadTasks(period.id);
    const critical = await detectMonthlyCloseCritical(
      householdWhere(req) as Record<string, unknown>,
      period.periodMonth,
    );
    res.status(201).json({
      period: serializePeriod(period),
      tasks: tasks.map(serializeTask),
      critical,
    });
  } catch (e) {
    next(e);
  }
});

router.patch(
  '/:periodMonth/tasks/:taskKey',
  aiSuggestLimiter,
  async (req, res, next) => {
    try {
      const { user } = currentAuth(req);
      const periodMonth = req.params.periodMonth;
      if (!isValidPeriodMonth(periodMonth)) {
        res.status(400).json({ error: 'periodMonth must be YYYY-MM' });
        return;
      }
      const taskKey = req.params.taskKey;
      if (!(MONTHLY_CLOSE_TASK_KEYS as readonly string[]).includes(taskKey)) {
        res.status(400).json({
          error: `taskKey must be one of: ${MONTHLY_CLOSE_TASK_KEYS.join(', ')}`,
        });
        return;
      }

      const period = (await MonthlyClosePeriod.findOne({
        where: { periodMonth, ...householdWhere(req) },
      })) as InstanceType<typeof MonthlyClosePeriod> | null;
      if (!period) {
        res.status(404).json({ error: 'Period not found — start it first' });
        return;
      }
      if (period.status === 'closed') {
        res.status(409).json({
          error: 'Period is closed — reopen it before editing tasks',
        });
        return;
      }

      const task = (await MonthlyCloseTask.findOne({
        where: { periodId: period.id, taskKey },
      })) as InstanceType<typeof MonthlyCloseTask> | null;
      if (!task) {
        res.status(404).json({ error: 'Task not found for period' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(body, 'isComplete')) {
        const value = Boolean(body.isComplete);
        task.set('isComplete', value);
        task.set('completedAt', value ? new Date() : null);
        task.set('completedByUserId', value ? user.id : null);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
        task.set('notes', normalizeNotes(body.notes));
      }
      await task.save();
      res.json(serializeTask(task));
    } catch (e) {
      next(e);
    }
  },
);

router.post('/:periodMonth/close', aiSuggestLimiter, async (req, res, next) => {
  try {
    const periodMonth = req.params.periodMonth;
    if (!isValidPeriodMonth(periodMonth)) {
      res.status(400).json({ error: 'periodMonth must be YYYY-MM' });
      return;
    }
    const period = (await MonthlyClosePeriod.findOne({
      where: { periodMonth, ...householdWhere(req) },
    })) as InstanceType<typeof MonthlyClosePeriod> | null;
    if (!period) {
      res.status(404).json({ error: 'Period not found — start it first' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const force = Boolean(body.force);

    const critical = await detectMonthlyCloseCritical(
      householdWhere(req) as Record<string, unknown>,
      period.periodMonth,
    );
    if (critical.hasCritical && !force) {
      res.status(409).json({
        error: 'critical_items',
        message:
          'Closing this month leaves critical items unresolved. Set force=true to close anyway.',
        critical,
      });
      return;
    }

    if (period.status !== 'closed') {
      period.set('status', 'closed');
      period.set('closedAt', new Date());
    }
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      period.set('notes', normalizeNotes(body.notes));
    }
    await period.save();

    const tasks = await loadTasks(period.id);
    res.json({
      period: serializePeriod(period),
      tasks: tasks.map(serializeTask),
      critical,
    });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/:periodMonth/reopen',
  aiSuggestLimiter,
  async (req, res, next) => {
    try {
      const periodMonth = req.params.periodMonth;
      if (!isValidPeriodMonth(periodMonth)) {
        res.status(400).json({ error: 'periodMonth must be YYYY-MM' });
        return;
      }
      const period = (await MonthlyClosePeriod.findOne({
        where: { periodMonth, ...householdWhere(req) },
      })) as InstanceType<typeof MonthlyClosePeriod> | null;
      if (!period) {
        res.status(404).json({ error: 'Period not found' });
        return;
      }
      if (period.status === 'open') {
        // Idempotent — already open. Still return the period so the
        // caller can refresh state without a follow-up GET.
        const tasks = await loadTasks(period.id);
        const critical = await detectMonthlyCloseCritical(
          householdWhere(req) as Record<string, unknown>,
          period.periodMonth,
        );
        res.json({
          period: serializePeriod(period),
          tasks: tasks.map(serializeTask),
          critical,
        });
        return;
      }
      period.set('status', 'open');
      period.set('closedAt', null);
      await period.save();

      const tasks = await loadTasks(period.id);
      const critical = await detectMonthlyCloseCritical(
        householdWhere(req) as Record<string, unknown>,
        period.periodMonth,
      );
      res.json({
        period: serializePeriod(period),
        tasks: tasks.map(serializeTask),
        critical,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
