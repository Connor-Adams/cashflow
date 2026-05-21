import type { Request } from 'express';
import { Op } from 'sequelize';
import { Transaction } from '../models';
import { visibleTransactionWhere } from '../auth/scope';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';

export type AiFinancialInsight = {
  title: string;
  summary: string;
  severity: 'info' | 'watch' | 'action';
  metric: string;
  amount: number;
  comparison: string;
  supportingTransactionIds: number[];
  rationale: string;
  suggestedAction: string;
};

function monthRange(period: string): { from: string; to: string } {
  const d = /^\d{4}-\d{2}$/.test(period) ? new Date(`${period}-01T00:00:00`) : new Date();
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  return { from, to };
}

function previousMonth(period: string): string {
  const d = /^\d{4}-\d{2}$/.test(period) ? new Date(`${period}-01T00:00:00`) : new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export type FinancialInsightRange = {
  from?: string | null;
  to?: string | null;
  label?: string | null;
};

function dateWhere(range: FinancialInsightRange): { [Op.gte]?: string; [Op.lte]?: string } | undefined {
  const date: { [Op.gte]?: string; [Op.lte]?: string } = {};
  if (range.from) date[Op.gte] = range.from;
  if (range.to) date[Op.lte] = range.to;
  return Object.keys(date).length ? date : undefined;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function previousComparableRange(
  range: FinancialInsightRange,
): FinancialInsightRange | null {
  const from = parseDate(range.from);
  const to = parseDate(range.to);
  if (!from || !to || from > to) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.floor((to.getTime() - from.getTime()) / dayMs) + 1;
  const prevTo = new Date(from.getTime() - dayMs);
  const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * dayMs);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

function rangeFromPeriod(period: string): FinancialInsightRange {
  const range = monthRange(period);
  return { from: range.from, to: range.to, label: range.from.slice(0, 7) };
}

function rangeLabel(range: FinancialInsightRange): string {
  if (range.label) return range.label;
  if (range.from && range.to) return `${range.from} to ${range.to}`;
  if (range.from) return `from ${range.from}`;
  if (range.to) return `through ${range.to}`;
  return 'all time';
}

export async function buildFinancialInsights(
  req: Request,
  period: string,
  currency: string,
  explicitRange?: FinancialInsightRange,
): Promise<{ period: string; currency: string; insights: AiFinancialInsight[] }> {
  const range = explicitRange ?? rangeFromPeriod(period);
  const previousRange = explicitRange
    ? previousComparableRange(range)
    : monthRange(previousMonth(range.from?.slice(0, 7) ?? period));
  const currentDateWhere = dateWhere(range);
  const previousDateWhere = previousRange ? dateWhere(previousRange) : undefined;
  const attributes = [
      'id',
      'date',
      'merchantClean',
      'merchantRaw',
      'amount',
      'finalCategory',
      'finalBusiness',
      'finalSplitType',
      'reviewFlag',
    ];
  const [rows, previousRows] = await Promise.all([
    Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        currency,
        ...(currentDateWhere ? { date: currentDateWhere } : {}),
      },
      attributes,
      raw: true,
    }),
    Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        currency,
        ...(previousDateWhere ? { date: previousDateWhere } : {}),
      },
      attributes,
      raw: true,
    }),
  ]);
  type Row = {
    id: number;
    merchantClean: string;
    merchantRaw: string;
    amount: unknown;
    finalCategory: string | null;
    finalBusiness: boolean;
    finalSplitType: string;
    reviewFlag: boolean;
  };
  const byCategory = new Map<string, { amount: number; ids: number[] }>();
  const previousByCategory = new Map<string, number>();
  const byMerchant = new Map<string, { amount: number; ids: number[] }>();
  let reviewCount = 0;
  let businessSpend = 0;
  let sharedSpend = 0;
  let totalSpend = 0;
  for (const row of previousRows as unknown as Row[]) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const category = row.finalCategory || 'Uncategorized';
    previousByCategory.set(category, (previousByCategory.get(category) ?? 0) + -amount);
  }
  for (const row of rows as unknown as Row[]) {
    const amount = num(row.amount);
    if (amount == null) continue;
    if (row.reviewFlag) reviewCount += 1;
    if (amount >= 0 && classifyPositiveFlow(row) === 'payment') continue;
    if (amount >= 0) continue;
    const spend = -amount;
    totalSpend += spend;
    if (row.finalBusiness) businessSpend += spend;
    if (row.finalSplitType === 'shared') sharedSpend += spend;
    const category = row.finalCategory || 'Uncategorized';
    const merchant = row.merchantClean || row.merchantRaw || 'Unknown merchant';
    const cat = byCategory.get(category) ?? { amount: 0, ids: [] };
    cat.amount += spend;
    cat.ids.push(row.id);
    byCategory.set(category, cat);
    const mer = byMerchant.get(merchant) ?? { amount: 0, ids: [] };
    mer.amount += spend;
    mer.ids.push(row.id);
    byMerchant.set(merchant, mer);
  }
  const topCategory = Array.from(byCategory.entries()).sort((a, b) => b[1].amount - a[1].amount)[0];
  const topMerchant = Array.from(byMerchant.entries()).sort((a, b) => b[1].amount - a[1].amount)[0];
  const insights: AiFinancialInsight[] = [];
  if (topCategory) {
    insights.push({
      title: `Top category: ${topCategory[0]}`,
      summary: `${topCategory[0]} is the largest spend category for this period.`,
      severity: topCategory[1].amount > totalSpend * 0.35 ? 'watch' : 'info',
      metric: 'category_spend',
      amount: Number(topCategory[1].amount.toFixed(2)),
      comparison: `${Math.round((topCategory[1].amount / Math.max(totalSpend, 1)) * 100)}% of period spend`,
      supportingTransactionIds: topCategory[1].ids.slice(0, 8),
      rationale: 'Calculated from finalized transaction categories.',
      suggestedAction: 'Review the supporting transactions if this category looks high.',
    });
  }
  const biggestCategoryIncrease = Array.from(byCategory.entries())
    .map(([category, current]) => ({
      category,
      current,
      previous: previousByCategory.get(category) ?? 0,
      delta: current.amount - (previousByCategory.get(category) ?? 0),
    }))
    .filter((row) => row.delta > 0 && row.current.amount >= 25)
    .sort((a, b) => b.delta - a.delta)[0];
  if (biggestCategoryIncrease && biggestCategoryIncrease.delta >= 25) {
    insights.push({
      title: `${biggestCategoryIncrease.category} is up`,
      summary: `${biggestCategoryIncrease.category} increased versus the previous month.`,
      severity:
        biggestCategoryIncrease.previous > 0 &&
        biggestCategoryIncrease.delta / biggestCategoryIncrease.previous > 0.35
          ? 'watch'
          : 'info',
      metric: 'category_month_over_month_delta',
      amount: Number(biggestCategoryIncrease.delta.toFixed(2)),
      comparison: `${previousRange ? rangeLabel(previousRange) : 'previous comparable period'}: ${biggestCategoryIncrease.previous.toFixed(2)}; ${rangeLabel(range)}: ${biggestCategoryIncrease.current.amount.toFixed(2)}`,
      supportingTransactionIds: biggestCategoryIncrease.current.ids.slice(0, 8),
      rationale: 'Computed from finalized category totals for the current and previous month.',
      suggestedAction: 'Review the supporting transactions to see which merchants caused the increase.',
    });
  }
  const uncategorized = byCategory.get('Uncategorized');
  if (uncategorized && uncategorized.ids.length > 0) {
    insights.push({
      title: 'Uncategorized spend is blocking clean reports',
      summary: `${uncategorized.ids.length} transaction${uncategorized.ids.length === 1 ? '' : 's'} have no final category.`,
      severity: 'action',
      metric: 'uncategorized_spend',
      amount: Number(uncategorized.amount.toFixed(2)),
      comparison: `${uncategorized.ids.length} rows`,
      supportingTransactionIds: uncategorized.ids.slice(0, 8),
      rationale: 'Rows without final categories reduce report quality and rule learning.',
      suggestedAction: 'Use the import cleanup queue or AI suggestions to categorize these rows.',
    });
  }
  if (topMerchant) {
    insights.push({
      title: `Top merchant: ${topMerchant[0]}`,
      summary: `${topMerchant[0]} has the highest merchant-level spend this period.`,
      severity: topMerchant[1].amount > totalSpend * 0.25 ? 'watch' : 'info',
      metric: 'merchant_spend',
      amount: Number(topMerchant[1].amount.toFixed(2)),
      comparison: `${topMerchant[1].ids.length} transaction${topMerchant[1].ids.length === 1 ? '' : 's'}`,
      supportingTransactionIds: topMerchant[1].ids.slice(0, 8),
      rationale: 'Calculated from merchant-clean transaction grouping.',
      suggestedAction: 'Check whether this merchant should have a rule or category adjustment.',
    });
  }
  if (reviewCount > 0) {
    insights.push({
      title: 'Uncategorized transactions',
      summary: `${reviewCount} transaction${reviewCount === 1 ? '' : 's'} have no category.`,
      severity: 'action',
      metric: 'review_count',
      amount: reviewCount,
      comparison: `${rows.length} transactions in period`,
      supportingTransactionIds: (rows as unknown as Row[])
        .filter((r) => r.reviewFlag)
        .map((r) => r.id)
        .slice(0, 8),
      rationale: 'Review flags come from transaction state.',
      suggestedAction: 'Use AI suggestions or rules to clear the queue.',
    });
  }
  if (businessSpend > 0 || sharedSpend > 0) {
    insights.push({
      title: 'Business and shared spend split',
      summary: `Business spend is ${businessSpend.toFixed(2)} and shared spend is ${sharedSpend.toFixed(2)} ${currency}.`,
      severity: 'info',
      metric: 'split_business_spend',
      amount: Number((businessSpend + sharedSpend).toFixed(2)),
      comparison: `${Math.round(((businessSpend + sharedSpend) / Math.max(totalSpend, 1)) * 100)}% of spend`,
      supportingTransactionIds: [],
      rationale: 'Calculated from finalized business and split fields.',
      suggestedAction: 'Audit split fields if household sharing feels off.',
    });
  }
  return { period: rangeLabel(range), currency, insights };
}
