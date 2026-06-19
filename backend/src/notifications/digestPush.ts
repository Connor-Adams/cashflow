/**
 * Web-push title/body for the weekly digest (issue #796).
 *
 * Pure functions — no IO. Mirrors the copy templates in the issue spec so the
 * OS push notification reads like the in-app card's headline. The deep-link is
 * carried separately on the payload's `dataJson.link` (the service worker reads
 * it on click).
 */
import type { WeeklyDigestData } from './digest';

export interface WeeklyDigestPush {
  title: string;
  body: string;
}

/** Signed, currency-prefixed amount, e.g. `-$420` → `-420`. v1 keeps it plain. */
function signedAbs(value: number): { sign: string; abs: string } {
  const sign = value < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(value * 100) / 100).toFixed(2);
  return { sign, abs };
}

/**
 * Build the push title + body for a digest payload.
 *
 * Title: `Your week: {±netChange} {currency} · {topCat} up {pct}%`
 *        (empty week → `Your week: a quiet one`).
 * Body:  `Net {±netChange} {currency} this week. {n} open insight(s),
 *         {m} due next week. Tap to review.`
 */
export function buildDigestPush(data: WeeklyDigestData): WeeklyDigestPush {
  if (data.isEmptyWeek) {
    return {
      title: 'Your week: a quiet one',
      body:
        `Nothing spent this week. ${data.openInsightCount} open insight` +
        `${data.openInsightCount === 1 ? '' : 's'}, ` +
        `${data.upcomingExpectations.length} due next week. Tap to review.`,
    };
  }

  const { sign, abs } = signedAbs(data.netChange);
  const top = data.topCategories[0];
  let title = `Your week: ${sign}${abs} ${data.currency}`;
  if (top && top.priorTotal > 0) {
    const pct = Math.round(((top.total - top.priorTotal) / top.priorTotal) * 100);
    const dir = pct >= 0 ? 'up' : 'down';
    title += ` · ${top.category} ${dir} ${Math.abs(pct)}%`;
  } else if (top) {
    title += ` · ${top.category}`;
  }

  const insightCount = data.openInsightCount;
  const upcomingCount = data.upcomingExpectations.length;
  const body =
    `Net ${sign}${abs} ${data.currency} this week. ` +
    `${insightCount} open insight${insightCount === 1 ? '' : 's'}, ` +
    `${upcomingCount} due next week. Tap to review.`;

  return { title, body };
}
