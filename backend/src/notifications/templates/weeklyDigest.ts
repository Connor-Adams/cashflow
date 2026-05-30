/**
 * Weekly-digest HTML + plain-text email template (issue #267).
 *
 * Pure functions — no IO, no env reads. The job hands us a `WeeklyDigestData`
 * payload and we return the strings to send. Kept simple per issue spec:
 * single-column layout, 600px max width, inline CSS, no images.
 *
 * Sections render only when their data exists, so a week with no biggest
 * transaction (e.g. only income rows) silently skips that block.
 */
import type { WeeklyDigestData } from '../digest';

const EMPTY_BODY = 'Nothing new this week. We\'re still here when you need us.';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatCurrency(value: number, currency: string): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  // Avoid Intl.NumberFormat to keep behavior deterministic across Node
  // versions / locales — the digest renders the same in every test env.
  const whole = abs.toFixed(2);
  return `${sign}${currency} ${whole}`;
}

export function formatDate(iso: string): string {
  // iso = YYYY-MM-DD. Render as e.g. "Mon, May 26".
  const d = new Date(`${iso}T12:00:00Z`);
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    d.getUTCDay()
  ];
  const monthName = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getUTCMonth()];
  return `${dayName}, ${monthName} ${d.getUTCDate()}`;
}

export interface WeeklyDigestEmail {
  subject: string;
  html: string;
  text: string;
  /** In-app notification title — short, scannable. */
  inAppTitle: string;
  /** In-app notification body — one-line summary. */
  inAppBody: string;
}

export function renderWeeklyDigest(
  data: WeeklyDigestData,
): WeeklyDigestEmail {
  if (data.isEmptyWeek) {
    return renderEmptyWeek(data);
  }
  const subject = `Your Cashflow week: ${formatCurrency(
    data.totalSpend,
    data.currency,
  )} spent, ${formatCurrency(data.totalIncome, data.currency)} income`;

  const inAppTitle = `Weekly digest: ${formatDate(
    data.weekStart,
  )} – ${formatDate(data.weekEnd)}`;
  const topCat = data.topCategories[0]?.category;
  const inAppBody =
    `${formatCurrency(data.totalSpend, data.currency)} spent, ` +
    `${formatCurrency(data.totalIncome, data.currency)} income` +
    (topCat ? `, top: ${topCat}` : '');

  const text = renderText(data);
  const html = renderHtml(data);
  return { subject, html, text, inAppTitle, inAppBody };
}

function renderEmptyWeek(data: WeeklyDigestData): WeeklyDigestEmail {
  const subject = 'Your Cashflow week: nothing new';
  const inAppTitle = `Weekly digest: ${formatDate(
    data.weekStart,
  )} – ${formatDate(data.weekEnd)}`;
  const text = `Here's how your week looked.\n\n${EMPTY_BODY}\n`;
  const html = wrapHtml(
    `<p style="margin:0 0 16px 0">Here&#39;s how your week looked.</p>` +
      `<p style="margin:0">${escapeHtml(EMPTY_BODY)}</p>`,
  );
  return { subject, html, text, inAppTitle, inAppBody: EMPTY_BODY };
}

function renderText(data: WeeklyDigestData): string {
  const lines: string[] = [];
  lines.push("Here's how your week looked.");
  lines.push('');
  lines.push(
    `Week: ${formatDate(data.weekStart)} – ${formatDate(data.weekEnd)}`,
  );
  lines.push('');
  lines.push('Spend & income');
  lines.push(`  Spent:  ${formatCurrency(data.totalSpend, data.currency)}`);
  lines.push(
    `  Income: ${formatCurrency(data.totalIncome, data.currency)}`,
  );
  const deltaSpend = data.totalSpend - data.priorTotalSpend;
  lines.push(
    `  Vs last week: ${
      deltaSpend === 0
        ? 'no change'
        : deltaSpend > 0
          ? `+${formatCurrency(deltaSpend, data.currency)} spent`
          : `${formatCurrency(deltaSpend, data.currency)} spent`
    }`,
  );
  if (data.topCategories.length > 0) {
    lines.push('');
    lines.push('Top categories');
    for (const c of data.topCategories) {
      const sign = c.delta > 0 ? '+' : c.delta < 0 ? '' : '±';
      lines.push(
        `  ${c.category}: ${formatCurrency(c.total, c.currency)} (${sign}${formatCurrency(
          c.delta,
          c.currency,
        )} vs last week)`,
      );
    }
  }
  if (data.biggestTransaction) {
    lines.push('');
    lines.push('Biggest transaction');
    const t = data.biggestTransaction;
    lines.push(
      `  ${t.merchant} — ${formatCurrency(t.amount, t.currency)} (${formatDate(t.date)})`,
    );
  }
  if (data.pendingCount > 0) {
    lines.push('');
    lines.push('Pending');
    lines.push(
      `  ${data.pendingCount} transaction${data.pendingCount === 1 ? '' : 's'} awaiting review`,
    );
  }
  if (data.budgets.length > 0) {
    lines.push('');
    lines.push('Budgets');
    for (const b of data.budgets) {
      const status =
        b.spent >= b.amount
          ? `OVER by ${formatCurrency(b.spent - b.amount, b.currency)}`
          : `${formatCurrency(b.remaining, b.currency)} remaining`;
      lines.push(
        `  ${b.name}: ${formatCurrency(b.spent, b.currency)} of ${formatCurrency(
          b.amount,
          b.currency,
        )} — ${status}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderHtml(data: WeeklyDigestData): string {
  const sections: string[] = [];
  sections.push(
    `<p style="margin:0 0 16px 0">Here&#39;s how your week looked.</p>`,
  );
  sections.push(
    `<p style="margin:0 0 16px 0;color:#555">Week: ${escapeHtml(
      formatDate(data.weekStart),
    )} – ${escapeHtml(formatDate(data.weekEnd))}</p>`,
  );

  sections.push(sectionSpendIncome(data));

  if (data.topCategories.length > 0) {
    sections.push(sectionTopCategories(data));
  }
  if (data.biggestTransaction) {
    sections.push(sectionBiggestTransaction(data));
  }
  if (data.pendingCount > 0) {
    sections.push(sectionPending(data));
  }
  if (data.budgets.length > 0) {
    sections.push(sectionBudgets(data));
  }
  return wrapHtml(sections.join('\n'));
}

function sectionSpendIncome(data: WeeklyDigestData): string {
  const deltaSpend = data.totalSpend - data.priorTotalSpend;
  const deltaLabel =
    deltaSpend === 0
      ? 'no change'
      : deltaSpend > 0
        ? `+${escapeHtml(formatCurrency(deltaSpend, data.currency))} vs last week`
        : `${escapeHtml(formatCurrency(deltaSpend, data.currency))} vs last week`;
  return (
    `<h2 style="margin:24px 0 8px 0;font-size:18px">Spend &amp; income</h2>` +
    `<table style="width:100%;border-collapse:collapse">` +
    `<tr><td style="padding:4px 0;color:#555">Spent</td>` +
    `<td style="padding:4px 0;text-align:right;font-weight:bold">${escapeHtml(
      formatCurrency(data.totalSpend, data.currency),
    )}</td></tr>` +
    `<tr><td style="padding:4px 0;color:#555">Income</td>` +
    `<td style="padding:4px 0;text-align:right;font-weight:bold">${escapeHtml(
      formatCurrency(data.totalIncome, data.currency),
    )}</td></tr>` +
    `<tr><td colspan="2" style="padding:4px 0;color:#888;font-size:12px">${deltaLabel}</td></tr>` +
    `</table>`
  );
}

function sectionTopCategories(data: WeeklyDigestData): string {
  const rows = data.topCategories
    .map((c) => {
      const sign = c.delta > 0 ? '+' : c.delta < 0 ? '−' : '±';
      const deltaText =
        c.delta === 0
          ? 'no change vs last week'
          : `${sign}${escapeHtml(formatCurrency(Math.abs(c.delta), c.currency))} vs last week`;
      return (
        `<tr><td style="padding:6px 0;color:#333">${escapeHtml(c.category)}</td>` +
        `<td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(
          formatCurrency(c.total, c.currency),
        )}</td></tr>` +
        `<tr><td colspan="2" style="padding:0 0 6px 0;color:#888;font-size:12px">${deltaText}</td></tr>`
      );
    })
    .join('');
  return (
    `<h2 style="margin:24px 0 8px 0;font-size:18px">Top categories</h2>` +
    `<table style="width:100%;border-collapse:collapse">${rows}</table>`
  );
}

function sectionBiggestTransaction(data: WeeklyDigestData): string {
  const t = data.biggestTransaction!;
  return (
    `<h2 style="margin:24px 0 8px 0;font-size:18px">Biggest transaction</h2>` +
    `<p style="margin:0">` +
    `<strong>${escapeHtml(t.merchant)}</strong>` +
    ` — ${escapeHtml(formatCurrency(t.amount, t.currency))}` +
    ` <span style="color:#888">(${escapeHtml(formatDate(t.date))}` +
    (t.category ? ` · ${escapeHtml(t.category)}` : '') +
    `)</span>` +
    `</p>`
  );
}

function sectionPending(data: WeeklyDigestData): string {
  return (
    `<h2 style="margin:24px 0 8px 0;font-size:18px">Pending</h2>` +
    `<p style="margin:0">${data.pendingCount} transaction${data.pendingCount === 1 ? '' : 's'} awaiting review.</p>`
  );
}

function sectionBudgets(data: WeeklyDigestData): string {
  const rows = data.budgets
    .map((b) => {
      const over = b.spent >= b.amount;
      const status = over
        ? `<span style="color:#b91c1c">OVER by ${escapeHtml(
            formatCurrency(b.spent - b.amount, b.currency),
          )}</span>`
        : `${escapeHtml(formatCurrency(b.remaining, b.currency))} remaining`;
      return (
        `<tr><td style="padding:6px 0">${escapeHtml(b.name)}</td>` +
        `<td style="padding:6px 0;text-align:right">${escapeHtml(
          formatCurrency(b.spent, b.currency),
        )} / ${escapeHtml(formatCurrency(b.amount, b.currency))}</td></tr>` +
        `<tr><td colspan="2" style="padding:0 0 6px 0;color:#888;font-size:12px">${status}</td></tr>`
      );
    })
    .join('');
  return (
    `<h2 style="margin:24px 0 8px 0;font-size:18px">Budgets</h2>` +
    `<table style="width:100%;border-collapse:collapse">${rows}</table>`
  );
}

function wrapHtml(inner: string): string {
  return (
    `<!doctype html><html><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Your Cashflow week</title>` +
    `</head><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;line-height:1.5">` +
    `<table style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff">` +
    `<tr><td>` +
    inner +
    `</td></tr>` +
    `</table>` +
    `</body></html>`
  );
}
