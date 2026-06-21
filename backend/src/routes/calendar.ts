/**
 * GET /api/calendar/events — household-scoped financial calendar view.
 *
 * Thin facade over `planned_events`: pulls events in the requested
 * window, expands recurrence rules to concrete day occurrences, and
 * decorates each occurrence with presentational hints (category color,
 * kind label) so the calendar UI doesn't have to map types itself.
 *
 * Mutations stay on /api/planned-events (created/updated/deleted there).
 * The calendar route is read-only by design — one URL, one source of
 * truth for the "show me what's coming up" question.
 *
 * Query params:
 *   from     YYYY-MM-DD (default: today, UTC)
 *   to       YYYY-MM-DD (default: from + 30 days)
 *   currency 3-letter ISO filter (optional)
 *   type     PlannedEventType filter (optional, validated)
 *   status   PlannedEventStatus filter (optional, validated)
 *
 * Response: { from, to, events: CalendarEvent[] } where events are
 * already sorted by eventDate ASC and may contain multiple entries
 * for the same `id` (one per recurring occurrence in the window).
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import {
  PlannedEvent,
  PLANNED_EVENT_TYPES,
  PLANNED_EVENT_STATUSES,
  type PlannedEventType,
  type PlannedEventStatus,
} from '../models/PlannedEvent';
import { householdWhere } from '../auth/scope';
import { expandRecurrence } from '../calendar/expandRecurrence';
import { categoryColorForType } from '../calendar/categoryColor';

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Default window length when `to` is not supplied. */
const DEFAULT_WINDOW_DAYS = 30;

/** Maximum window length, clamped to keep query + expansion cheap. */
const MAX_WINDOW_DAYS = 366;

const KIND_LABEL: Record<PlannedEventType, string> = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  settlement: 'Settlement',
  debt_payment: 'Debt payment',
  savings: 'Savings',
};

function todayIso(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const f = new Date(`${fromIso}T12:00:00Z`).getTime();
  const t = new Date(`${toIso}T12:00:00Z`).getTime();
  return Math.round((t - f) / (1000 * 60 * 60 * 24));
}

export type CalendarEventResponse = {
  /** PlannedEvent.id — duplicated across occurrences for recurring rules. */
  id: number;
  /** The concrete YYYY-MM-DD this occurrence lands on. */
  eventDate: string;
  type: PlannedEventType;
  /** Human-readable type label ("Debt payment", not "debt_payment"). */
  kindLabel: string;
  /** Tailwind palette key (e.g. 'emerald') for the type. */
  categoryColor: string;
  name: string;
  amount: string;
  currency: string;
  status: PlannedEventStatus;
  /** YYYY-MM-DD — the original anchor date the rule started from. */
  anchorDate: string;
  recurrenceRule: string | null;
  accountId: number | null;
  linkedTransactionId: number | null;
  notes: string | null;
};

router.get('/events', async (req, res, next) => {
  try {
    const fromRaw = req.query.from ? String(req.query.from) : todayIso();
    if (!ISO_DATE_RE.test(fromRaw)) {
      res.status(400).json({ error: 'from must be YYYY-MM-DD' });
      return;
    }
    const toRaw = req.query.to
      ? String(req.query.to)
      : addDaysIso(fromRaw, DEFAULT_WINDOW_DAYS);
    if (!ISO_DATE_RE.test(toRaw)) {
      res.status(400).json({ error: 'to must be YYYY-MM-DD' });
      return;
    }
    if (toRaw < fromRaw) {
      res.status(400).json({ error: 'to must be on or after from' });
      return;
    }

    // Clamp the window before we even hit the DB — protects against an
    // accidental "give me 100 years of events" query.
    const windowDays = daysBetween(fromRaw, toRaw);
    if (windowDays > MAX_WINDOW_DAYS) {
      res.status(400).json({
        error: `date range too large (max ${MAX_WINDOW_DAYS} days)`,
      });
      return;
    }

    // Build the underlying planned-events query. Two cases per row:
    //   - One-off (no recurrence_rule): the row matches iff
    //     expectedDate ∈ [from, to].
    //   - Recurring (has recurrence_rule): the rule may yield
    //     occurrences inside [from, to] even when expectedDate is
    //     before `from`. So we pull *every* recurring row whose anchor
    //     date is ≤ `to`, then filter occurrences in JS.
    const where: Record<string, unknown> = { ...householdWhere(req), kind: 'planned' };

    if (req.query.type) {
      const typeRaw = String(req.query.type);
      if ((PLANNED_EVENT_TYPES as readonly string[]).includes(typeRaw)) {
        where.type = typeRaw;
      } else {
        res.status(400).json({ error: 'invalid type filter' });
        return;
      }
    }
    if (req.query.status) {
      const statusRaw = String(req.query.status);
      if ((PLANNED_EVENT_STATUSES as readonly string[]).includes(statusRaw)) {
        where.status = statusRaw;
      } else {
        res.status(400).json({ error: 'invalid status filter' });
        return;
      }
    }
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    where[Op.and as unknown as string] = [
      {
        [Op.or]: [
          // one-off rows
          {
            recurrenceRule: null,
            expectedDate: { [Op.between]: [fromRaw, toRaw] },
          },
          // recurring rows: anchor on/before window end
          {
            recurrenceRule: { [Op.not]: null },
            expectedDate: { [Op.lte]: toRaw },
          },
        ],
      },
    ];

    const rows = await PlannedEvent.findAll({ where });

    const events: CalendarEventResponse[] = [];
    for (const row of rows) {
      const occurrences = expandRecurrence(
        row.recurrenceRule,
        row.expectedDate,
        fromRaw,
        toRaw,
      );
      for (const dateIso of occurrences) {
        events.push({
          id: row.id,
          eventDate: dateIso,
          type: row.type,
          kindLabel: KIND_LABEL[row.type] ?? row.type,
          categoryColor: categoryColorForType(row.type),
          name: row.name,
          amount: String(row.amount),
          currency: row.currency,
          status: row.status,
          anchorDate: row.expectedDate,
          recurrenceRule: row.recurrenceRule,
          accountId: row.accountId,
          linkedTransactionId: row.linkedTransactionId,
          notes: row.notes,
        });
      }
    }

    // Stable sort: by date, then name, then id — handy when two events
    // share a day so the UI doesn't shuffle them between renders.
    events.sort((a, b) => {
      if (a.eventDate !== b.eventDate) {
        return a.eventDate < b.eventDate ? -1 : 1;
      }
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.id - b.id;
    });

    res.json({ from: fromRaw, to: toRaw, events });
  } catch (e) {
    next(e);
  }
});

export default router;
