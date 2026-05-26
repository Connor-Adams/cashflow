/**
 * Pure date-range helpers for the natural-language query intent presets.
 * Kept separate from queryBuilders so the calendar math can be unit-tested
 * without standing up Express or Sequelize.
 *
 * All dates are ISO `YYYY-MM-DD` strings in local time. `today` is injected
 * so tests can pin the calendar deterministically.
 */
import type { DateRangePreset } from './queryIntents.js';

export type DateWindow = {
  from: string;
  to: string;
  label: string;
};

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeek(d: Date): Date {
  // ISO weeks start Monday. JS getDay: 0=Sun..6=Sat.
  const day = d.getDay();
  const offset = (day + 6) % 7;
  const out = new Date(d);
  out.setDate(d.getDate() - offset);
  out.setHours(0, 0, 0, 0);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

function endOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3 + 3, 0);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

function endOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 11, 31);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(d.getDate() + n);
  return out;
}

/**
 * Resolve a {@link DateRangePreset} relative to `today`. Returns the inclusive
 * ISO date bounds and a human-readable label.
 *
 * `all_time` returns no bounds — callers should treat it as "no date filter".
 */
export function resolveDateRange(
  preset: DateRangePreset,
  today: Date = new Date(),
): DateWindow | { all: true; label: string } {
  switch (preset) {
    case 'this_week': {
      const from = startOfWeek(today);
      const to = addDays(from, 6);
      return { from: fmt(from), to: fmt(to), label: 'this week' };
    }
    case 'last_week': {
      const cur = startOfWeek(today);
      const from = addDays(cur, -7);
      const to = addDays(from, 6);
      return { from: fmt(from), to: fmt(to), label: 'last week' };
    }
    case 'this_month': {
      return {
        from: fmt(startOfMonth(today)),
        to: fmt(endOfMonth(today)),
        label: 'this month',
      };
    }
    case 'last_month': {
      const last = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return {
        from: fmt(startOfMonth(last)),
        to: fmt(endOfMonth(last)),
        label: 'last month',
      };
    }
    case 'this_quarter': {
      return {
        from: fmt(startOfQuarter(today)),
        to: fmt(endOfQuarter(today)),
        label: 'this quarter',
      };
    }
    case 'last_quarter': {
      const prev = new Date(today.getFullYear(), today.getMonth() - 3, 1);
      return {
        from: fmt(startOfQuarter(prev)),
        to: fmt(endOfQuarter(prev)),
        label: 'last quarter',
      };
    }
    case 'this_year': {
      return {
        from: fmt(startOfYear(today)),
        to: fmt(endOfYear(today)),
        label: 'this year',
      };
    }
    case 'last_year': {
      const prev = new Date(today.getFullYear() - 1, 0, 1);
      return {
        from: fmt(startOfYear(prev)),
        to: fmt(endOfYear(prev)),
        label: 'last year',
      };
    }
    case 'all_time': {
      return { all: true, label: 'all time' };
    }
  }
}
