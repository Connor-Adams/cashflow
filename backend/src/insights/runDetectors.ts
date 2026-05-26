/**
 * Run every deterministic detector against a household and upsert the
 * resulting `Insight` rows.
 *
 * Idempotency: detectors return a stable `fingerprint` (e.g. sorted txn ids).
 * We upsert by `(household_id, type, fingerprint)`. A re-run of the same
 * detector will refresh `metadata`/`detected_at` but won't churn statuses —
 * if the user already dismissed/resolved a finding, we preserve that. That
 * means a "dismissed" duplicate stays dismissed even if the detector still
 * surfaces it. To re-surface, drop the row.
 *
 * Scope: this is the deterministic layer. Issue #210 (future) layers an AI
 * review pass on top — it reads the same `insights` table.
 */
import { Op } from 'sequelize';
import { Insight, Transaction, PartnerSettlement, Contact, Receipt, sequelize } from '../models';
import {
  detectDuplicateTransactions,
  detectMerchantSpendSpike,
  detectRecurringIncrease,
  detectMissingReceipt,
  detectUnusualCategorySpend,
  detectSettlementImbalance,
} from './detectors';
import type {
  DetectorTransaction,
  DetectorSettlement,
  DetectedInsight,
} from './detectors';

const TRANSACTION_LOOKBACK_DAYS = 180;

export type RunDetectorsResult = {
  created: number;
  refreshed: number;
  total: number;
  detectorCounts: Record<string, number>;
};

async function loadTransactions(
  householdId: number,
  now: Date,
): Promise<DetectorTransaction[]> {
  const cutoff = new Date(now.getTime() - TRANSACTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const rows = await Transaction.findAll({
    where: { householdId, date: { [Op.gte]: cutoffIso } },
    attributes: ['id', 'date', 'merchantClean', 'amount', 'currency', 'finalCategory'],
    raw: true,
  });
  const ids = rows.map((r) => r.id);
  // Receipt counts per transaction — single query, single pass aggregate
  const receipts = ids.length === 0 ? [] : await Receipt.findAll({
    where: { transactionId: { [Op.in]: ids } },
    attributes: ['transactionId'],
    raw: true,
  });
  const countByTxn = new Map<number, number>();
  for (const r of receipts) {
    countByTxn.set(r.transactionId, (countByTxn.get(r.transactionId) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.id,
    date: String(r.date),
    merchantClean: String(r.merchantClean ?? ''),
    amount: Number(r.amount),
    currency: String(r.currency),
    finalCategory: r.finalCategory ?? null,
    receiptCount: countByTxn.get(r.id) ?? 0,
  }));
}

async function loadSettlements(householdId: number): Promise<DetectorSettlement[]> {
  // Pair with contact names so the insight description reads natural.
  const rows = await PartnerSettlement.findAll({
    where: { householdId },
    raw: true,
  });
  const contactIds = Array.from(new Set(rows.map((r) => r.contactId)));
  const contacts = contactIds.length === 0 ? [] : await Contact.findAll({
    where: { id: { [Op.in]: contactIds } },
    attributes: ['id', 'name'],
    raw: true,
  });
  const nameById = new Map<number, string>();
  for (const c of contacts) nameById.set(c.id, c.name || `Contact #${c.id}`);
  return rows.map((r) => ({
    contactId: r.contactId,
    contactName: nameById.get(r.contactId) || `Contact #${r.contactId}`,
    direction: r.direction,
    currency: r.currency,
    amount: Number(r.amount),
  }));
}

export async function runDetectorsForHousehold(
  householdId: number,
  options?: { now?: Date; userId?: number | null },
): Promise<RunDetectorsResult> {
  const now = options?.now ?? new Date();
  const userId = options?.userId ?? null;

  const transactions = await loadTransactions(householdId, now);
  const settlements = await loadSettlements(householdId);

  const findings: DetectedInsight[] = [
    ...detectDuplicateTransactions(transactions, { now }),
    ...detectMerchantSpendSpike(transactions, { now }),
    ...detectRecurringIncrease(transactions, { now }),
    ...detectMissingReceipt(transactions, { now }),
    ...detectUnusualCategorySpend(transactions, { now }),
    ...detectSettlementImbalance(settlements),
  ];

  const detectorCounts: Record<string, number> = {};
  for (const f of findings) {
    detectorCounts[f.type] = (detectorCounts[f.type] ?? 0) + 1;
  }

  let created = 0;
  let refreshed = 0;

  // Persist inside a transaction so a partial run doesn't leave inconsistent
  // state. Upsert by (household_id, type, fingerprint).
  await sequelize.transaction(async (t) => {
    for (const f of findings) {
      const existing = await Insight.findOne({
        where: {
          householdId,
          type: f.type,
          fingerprint: f.fingerprint,
        },
        transaction: t,
      });
      if (existing) {
        // Don't reopen a dismissed/resolved row — preserve the user's state.
        existing.set('severity', f.severity);
        existing.set('title', f.title);
        existing.set('description', f.description);
        existing.set('entityType', f.entityType);
        existing.set('entityId', f.entityId);
        existing.set('metadata', f.metadata);
        existing.set('detectedAt', now);
        await existing.save({ transaction: t });
        refreshed++;
      } else {
        await Insight.create(
          {
            householdId,
            userId,
            type: f.type,
            severity: f.severity,
            title: f.title,
            description: f.description,
            entityType: f.entityType,
            entityId: f.entityId,
            status: 'open',
            fingerprint: f.fingerprint,
            metadata: f.metadata,
            detectedAt: now,
          },
          { transaction: t },
        );
        created++;
      }
    }
  });

  return { created, refreshed, total: findings.length, detectorCounts };
}
