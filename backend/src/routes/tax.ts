import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { Account, Entity, TaxReturn, TaxSlip, Carryforward, ShareholderLoan, InstalmentPayment, Transaction, sequelize } from '../models';
import { buildPersonalFacts } from '../tax/builders/buildPersonalFacts';
import { buildCorpFacts } from '../tax/builders/buildCorpFacts';
import { buildT1 } from '../tax/engine/t1';
import { buildT2 } from '../tax/engine/t2';
import { ratesFor, supportedYears, RateTableMissingError } from '../tax/engine/brackets';
import { computeEntityReturn } from '../tax/services/computeEntityReturn';
import { assertRatesUsable, ProjectedRatesError } from '../tax/engine/rateProvenance';
import { buildCompletenessReport } from '../tax/completeness/buildCompletenessReport';
import { buildOutlook } from '../tax/forward/buildOutlook';
import type { CorpFiscalYear } from '../tax/engine/types';
import { rollPersonalCarryforwards } from '../tax/services/rollPersonalCarryforwards';
import { buildReconciliationReport } from '../tax/reconciliation/buildReport';
import { computeShareholderLoanBalance } from '../tax/services/shareholderLoanBalance';
import { resolvePersonalEntity } from '../tax/services/personalEntityOwner';
import { parseSlipAmount } from '../tax/util/parseSlipAmount';
import type { SlipType, TaxSlipBoxValues } from '../models/TaxSlip';
import { isTaxTreatment, type TaxTreatment } from '@cashflow/shared';

const router = Router();

// GET /api/tax/years — list years the engine has rate tables for.
router.get('/years', (_req, res) => {
  res.json({ years: supportedYears() });
});

// GET /api/tax/classification-queue?entityId=&year=
// Unclassified corp→personal transfer pairs + detected payroll deposits for a
// personal entity in a calendar year. Read-only derivation (no table).
router.get('/classification-queue', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.query.entityId);
    const year = Number(req.query.year);
    if (!Number.isInteger(entityId) || !Number.isInteger(year) || isNaN(entityId) || isNaN(year)) {
      res.status(400).json({ error: 'entityId and year query params required' });
      return;
    }
    const statusRaw = req.query.status;
    const status = statusRaw === undefined ? 'unclassified' : String(statusRaw);
    if (status !== 'unclassified' && status !== 'classified') {
      res.status(400).json({ error: 'invalid status' });
      return;
    }
    const overrideWhere = status === 'classified' ? { [Op.ne]: null } : null;
    const personal = await Entity.findByPk(entityId);
    if (!personal || personal.kind !== 'personal' || personal.householdId !== household.id) {
      res.status(404).json({ error: 'personal entity not found' });
      return;
    }
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    const corpEntities = await Entity.findAll({ where: { householdId: personal.householdId, kind: 'corp' } });
    const corpEntityIds = new Set(corpEntities.map((e) => e.id));

    const personalLegs = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        entityId,
        date: { [Op.between]: [start, end] },
        txnType: 'transfer',
        linkedTransactionId: { [Op.ne]: null },
        taxTreatmentOverride: overrideWhere,
        // Money ARRIVING only. A personal→corp leg is a loan or an injection of
        // capital; listing it let an injection be classified as a dividend.
        // Mirrors detectUnclassifiedCorpDraws' cadAmount > 0.
        amount: { [Op.gt]: 0 },
      },
    });

    const linkedIds = personalLegs
      .map((l) => l.linkedTransactionId)
      .filter((x): x is number => x != null);
    const linkedTxns = linkedIds.length
      ? await Transaction.findAll({ where: { id: { [Op.in]: linkedIds } } })
      : [];
    const linkedById = new Map(linkedTxns.map((t) => [t.id, t]));
    const corpDistributions: Array<{ personal: Transaction; corp: Transaction }> = [];
    for (const leg of personalLegs) {
      const other = linkedById.get(leg.linkedTransactionId as number);
      if (other && other.entityId != null && corpEntityIds.has(other.entityId)) {
        corpDistributions.push({ personal: leg, corp: other });
      }
    }

    const payroll = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        entityId,
        date: { [Op.between]: [start, end] },
        txnType: 'income',
        taxTreatmentOverride: overrideWhere,
        amount: { [Op.gt]: 0 },
      },
    });

    const allTxns = [
      ...corpDistributions.flatMap((d) => [d.personal, d.corp]),
      ...payroll,
    ] as Transaction[];
    const acctIds = Array.from(new Set(allTxns.map((t) => t.accountId)));
    const accts = acctIds.length
      ? await Account.findAll({ where: { id: acctIds } })
      : [];
    const acctName = new Map(accts.map((a) => [a.id, a.name]));
    const slim = (t: Transaction) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      currency: t.currency,
      merchantClean: t.merchantClean,
      accountId: t.accountId,
      accountName: acctName.get(t.accountId) ?? null,
      txnType: t.txnType,
      taxTreatmentOverride: t.taxTreatmentOverride,
    });
    res.json({
      corpDistributions: corpDistributions.map((d) => ({
        personal: slim(d.personal as Transaction),
        corp: slim(d.corp as Transaction),
      })),
      payroll: payroll.map(slim),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/tax/classification-queue/bulk
// Body: { ids: number[], taxTreatmentOverride: TaxTreatment | null }
// Clears a slice of the classification queue in one request.
//
// A dedicated endpoint rather than N calls to PATCH
// /api/transfers/:id/tax-treatment: the queue is worked in batches of dozens
// (the 2026 corp-draw backlog was 50+ rows), and N independent requests can
// half-apply — leaving the T1 and T2 sides of the same draws disagreeing
// about what the money was. One transaction means the batch either lands or
// does not.
//
// Response carries the updated rows so the caller can patch its list in
// place; a refetch would re-run the whole queue derivation and lose the
// user's scroll position mid-batch.
router.post('/classification-queue/bulk', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body || {}) as { ids?: unknown; taxTreatmentOverride?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (body.ids.length > 200) {
      res.status(400).json({ error: 'At most 200 ids per request' });
      return;
    }
    const ids: number[] = [];
    for (const raw of body.ids) {
      const id = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'Each id must be a positive integer' });
        return;
      }
      if (!ids.includes(id)) ids.push(id);
    }

    const raw = body.taxTreatmentOverride;
    let treatment: TaxTreatment | null;
    if (raw === null || raw === undefined || raw === '') {
      treatment = null;
    } else if (isTaxTreatment(raw)) {
      treatment = raw;
    } else {
      res.status(400).json({ error: 'invalid taxTreatment' });
      return;
    }

    const entityKind = await entityKindsFor(household.id);
    const written = await sequelize.transaction(async (t) => {
      const rows: Transaction[] = [];
      const reviewedAt = new Date();
      for (const id of ids) {
        // visibleTransactionWhere is the household + visibility gate, so a row
        // from another household simply isn't found — and throwing here rolls
        // back every row already written in this transaction.
        const txn = await Transaction.findOne({
          where: { id, ...visibleTransactionWhere(req) },
          transaction: t,
        });
        if (!txn) {
          const err = new Error(`Transaction ${id} not found`) as Error & { status?: number };
          err.status = 404;
          throw err;
        }
        if (treatment != null && DISTRIBUTION_TREATMENTS.has(treatment)
          && !isDistributionDirection(txn, entityKind)) {
          // Throwing rolls back the whole batch, like an unknown id.
          const err = new Error(
            `Transaction ${id} moves money into the corporation; it cannot be a ${treatment}. `
            + 'Classify it as a loan or capital instead.',
          ) as Error & { status?: number };
          err.status = 400;
          throw err;
        }
        txn.set('taxTreatmentOverride', treatment);
        txn.set('reviewedAt', reviewedAt);
        await txn.save({ transaction: t });
        rows.push(txn);

        // Both legs of a transfer pair must carry the same treatment — the T1
        // and T2 builders read whichever leg they own, and a one-sided write
        // makes the personal return disagree with the corp return.
        if (txn.linkedTransactionId != null) {
          const sibling = await Transaction.findOne({
            where: { id: txn.linkedTransactionId, ...visibleTransactionWhere(req) },
            transaction: t,
          });
          // Only a RECIPROCAL sibling is this row's other leg. A one-way link
          // (two rows both pointing at one) would otherwise overwrite the
          // treatment of a different pair.
          if (sibling && sibling.linkedTransactionId === txn.id
            && sibling.taxTreatmentOverride !== treatment) {
            sibling.set('taxTreatmentOverride', treatment);
            sibling.set('reviewedAt', reviewedAt);
            await sibling.save({ transaction: t });
            rows.push(sibling);
          }
        }
      }
      return rows;
    });

    const acctIds = Array.from(new Set(written.map((r) => r.accountId)));
    const accts = acctIds.length ? await Account.findAll({ where: { id: acctIds } }) : [];
    const acctName = new Map(accts.map((a) => [a.id, a.name]));
    res.json({
      updated: written.map((r) => ({
        id: r.id,
        date: r.date,
        amount: r.amount,
        currency: r.currency,
        merchantClean: r.merchantClean,
        accountId: r.accountId,
        accountName: acctName.get(r.accountId) ?? null,
        txnType: r.txnType,
        taxTreatmentOverride: r.taxTreatmentOverride,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** Treatments that say money went FROM the corporation TO the person. */
const DISTRIBUTION_TREATMENTS = new Set<string>([
  'eligible_dividend', 'non_eligible_dividend', 'salary', 'employment_income',
]);

async function entityKindsFor(householdId: number): Promise<Map<number, string>> {
  const entities = await Entity.findAll({ where: { householdId }, attributes: ['id', 'kind'] });
  return new Map(entities.map((e) => [e.id, e.kind]));
}

/**
 * Whether a row could be one leg of a corp→person distribution: an inflow on a
 * personal entity, or an outflow on a corporate one. The queue only lists such
 * rows, but this route takes ids, so it checks for itself.
 */
function isDistributionDirection(txn: Transaction, kinds: Map<number, string>): boolean {
  const amount = Number(txn.amount);
  const kind = txn.entityId != null ? kinds.get(txn.entityId) : undefined;
  if (kind === 'corp') return amount < 0;
  return amount > 0;
}

// GET /api/tax/entities — list all entities for the authenticated household.
router.get('/entities', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entities = await Entity.findAll({ where: { householdId: household.id } });
    res.json({ entities });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tax/entities/:id — partial entity updates.
// Body: { associatedGroupId?: string | null }.
// v1 supports only `associatedGroupId` on `kind=corp` entities (used to link
// corps into a shared SBD/AAII associated group). Null clears the group. Other
// fields are ignored. Personal entities cannot be grouped (engine ignores
// associatedGroupId on non-corp anyway, but reject at the API for clarity).
router.patch('/entities/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.params.id);
    if (!Number.isInteger(entityId)) {
      res.status(400).json({ error: 'invalid_entity_id' });
      return;
    }

    const body = (req.body ?? {}) as { associatedGroupId?: unknown; ownerEntityId?: unknown };
    const hasGroup = Object.prototype.hasOwnProperty.call(body, 'associatedGroupId');
    const hasOwner = Object.prototype.hasOwnProperty.call(body, 'ownerEntityId');
    if (!hasGroup && !hasOwner) {
      res.status(400).json({
        error: 'invalid_body',
        message: 'associatedGroupId or ownerEntityId required',
      });
      return;
    }

    const entity = await Entity.findByPk(entityId);
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    if (entity.householdId !== household.id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (entity.kind !== 'corp') {
      res.status(400).json({
        error: 'invalid_kind',
        message: 'associatedGroupId / ownerEntityId can only be set on kind=corp entities',
      });
      return;
    }

    const patch: { associatedGroupId?: string | null; ownerEntityId?: number | null } = {};

    if (hasGroup) {
      const raw = body.associatedGroupId;
      if (raw === null) {
        patch.associatedGroupId = null;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        patch.associatedGroupId = trimmed === '' ? null : trimmed;
      } else {
        res.status(400).json({ error: 'invalid_body', message: 'associatedGroupId must be a string or null' });
        return;
      }
    }

    if (hasOwner) {
      const raw = body.ownerEntityId;
      if (raw === null) {
        patch.ownerEntityId = null;
      } else if (Number.isInteger(raw)) {
        const target = await Entity.findByPk(raw as number);
        if (!target || target.householdId !== household.id) {
          res.status(400).json({ error: 'invalid_owner', message: 'ownerEntityId must be an entity in this household' });
          return;
        }
        if (target.kind !== 'personal') {
          res.status(400).json({ error: 'invalid_owner', message: 'ownerEntityId must be a personal entity' });
          return;
        }
        patch.ownerEntityId = raw as number;
      } else {
        res.status(400).json({ error: 'invalid_body', message: 'ownerEntityId must be an integer or null' });
        return;
      }
    }

    await entity.update(patch);
    res.status(200).json({ entity });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/entities/:id/spouse — link two personal entities as spouses.
// Body: { spouseEntityId: number }. Sets both reciprocal directions atomically.
// Validations:
//   1. Both entities must belong to caller's household (else 403).
//   2. Both must be kind === 'personal' (else 400).
//   3. Idempotent if already linked to the same spouse (200, no-op).
//   4. 409 if either entity already linked to a DIFFERENT spouse.
router.post('/entities/:id/spouse', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.params.id);
    if (!Number.isInteger(entityId)) {
      res.status(400).json({ error: 'invalid_entity_id' });
      return;
    }

    const body = (req.body ?? {}) as { spouseEntityId?: unknown };
    const spouseEntityId = Number(body.spouseEntityId);
    if (!Number.isInteger(spouseEntityId)) {
      res.status(400).json({
        error: 'invalid_body',
        message: 'spouseEntityId (int) required',
      });
      return;
    }

    if (entityId === spouseEntityId) {
      res.status(400).json({
        error: 'invalid_spouse',
        message: 'Cannot link an entity to itself as spouse',
      });
      return;
    }

    const a = await Entity.findByPk(entityId);
    if (!a) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    if (a.householdId !== household.id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const b = await Entity.findByPk(spouseEntityId);
    if (!b) {
      res.status(404).json({ error: 'spouse_entity_not_found' });
      return;
    }
    if (b.householdId !== household.id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    if (a.kind !== 'personal' || b.kind !== 'personal') {
      res.status(400).json({
        error: 'invalid_kind',
        message: 'Both entities must be kind=personal',
      });
      return;
    }

    // Idempotent re-link: if both already point at each other, no-op success.
    if (a.spouseEntityId === b.id && b.spouseEntityId === a.id) {
      res.status(200).json({ entity: a });
      return;
    }

    // Conflict: either side already linked to someone else.
    if (a.spouseEntityId !== null && a.spouseEntityId !== b.id) {
      res.status(409).json({
        error: 'spouse_conflict',
        message: `Entity ${a.id} already linked to spouse ${a.spouseEntityId}`,
      });
      return;
    }
    if (b.spouseEntityId !== null && b.spouseEntityId !== a.id) {
      res.status(409).json({
        error: 'spouse_conflict',
        message: `Entity ${b.id} already linked to spouse ${b.spouseEntityId}`,
      });
      return;
    }

    // Set both directions atomically.
    await sequelize.transaction(async (t) => {
      await a.update({ spouseEntityId: b.id }, { transaction: t });
      await b.update({ spouseEntityId: a.id }, { transaction: t });
    });

    res.status(200).json({ entity: a });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tax/entities/:id/spouse — unlink both reciprocal directions.
// Idempotent: returns 204 even if no spouse is currently set.
router.delete('/entities/:id/spouse', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entityId = Number(req.params.id);
    if (!Number.isInteger(entityId)) {
      res.status(400).json({ error: 'invalid_entity_id' });
      return;
    }

    const a = await Entity.findByPk(entityId);
    if (!a) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    if (a.householdId !== household.id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Idempotent: no spouse set, nothing to do.
    if (a.spouseEntityId === null) {
      res.status(204).send();
      return;
    }

    const spouseId = a.spouseEntityId;
    const b = await Entity.findByPk(spouseId);

    await sequelize.transaction(async (t) => {
      await a.update({ spouseEntityId: null }, { transaction: t });
      // Only clear the reciprocal side if it actually points back at us;
      // otherwise leave the stale field alone (defensive against drift).
      if (b && b.spouseEntityId === a.id) {
        await b.update({ spouseEntityId: null }, { transaction: t });
      }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal/:year/return — compute (or return cached) T1 for the personal entity.
router.get('/personal/:year/return', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household. POST /api/tax/entities to create one.',
      });
      return;
    }

    const facts = await buildPersonalFacts(entity.id, year);
    const rates = ratesFor(year);
    assertRatesUsable(rates, { periodEnd: `${year}-12-31`, now: new Date() });
    const result = await computeEntityReturn({
      entityId: entity.id,
      cacheYear: year,
      facts,
      run: (f) => buildT1(f, rates),
    });

    // Computed on EVERY request and merged into BOTH responses. The cache-hit path
    // below returns early, so attaching this only to the miss path would ship a gate
    // that vanishes whenever the cache is warm — a gate that disappears under exactly
    // the common case is worse than none.
    //
    // Deliberately not part of `factsHash`: import coverage changes without any fact
    // changing.
    const completeness = await buildCompletenessReport({
      entityId: entity.id, year, facts, rates,
    });

    if (result.cached) {
      res.json({
        cached: true,
        computedAt: result.computedAt,
        lines: result.lines,
        totals: result.totals,
        warnings: result.warnings,
        completeness,
      });
      return;
    }

    // Optional ?roll=true: after snapshot, auto-roll carryforwards for this year
    if (req.query.roll === 'true') {
      try {
        await rollPersonalCarryforwards(entity.id, year, result.engineReturn, facts, rates);
      } catch {
        // Roll failure is non-fatal; include a warning but still return the return
        result.warnings.push('carryforward_roll_failed');
      }
    }

    res.json({
      cached: false,
      computedAt: result.computedAt,
      lines: result.lines,
      totals: result.totals,
      warnings: result.warnings,
      completeness,
    });
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      res.status(409).json({
        error: 'rate_table_missing',
        message: (err as Error).message,
      });
      return;
    }
    if (err instanceof ProjectedRatesError) {
      res.status(409).json({
        error: 'rate_table_projected',
        message: err.message,
        year: err.year,
      });
      return;
    }
    next(err);
  }
});

// GET /api/tax/personal/:year/reconciliation — slip / txn / categorisation issues.
router.get('/personal/:year/reconciliation', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }
    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household.',
      });
      return;
    }
    const report = await buildReconciliationReport(entity.id, year);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/carryforwards — list carryforwards for the personal entity.
router.get('/carryforwards', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.json({ carryforwards: [] });
      return;
    }
    const rows = await Carryforward.findAll({
      where: { entityId: entity.id },
      order: [['asOfYear', 'DESC']],
    });
    res.json({ carryforwards: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/carryforwards — upsert a carryforward entry.
router.post('/carryforwards', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { entityId, kind, asOfYear, amount, notes } = (req.body ?? {}) as Record<string, unknown>;
    const entity = await Entity.findOne({
      where: { id: entityId as number, householdId: household.id },
    });
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [row] = await (Carryforward.upsert as any)({
      entityId: entity.id,
      kind,
      asOfYear,
      amount,
      notes,
    });
    res.status(201).json({ carryforward: row });
  } catch (err) {
    next(err);
  }
});

const SLIP_TYPES: readonly SlipType[] = ['T4', 'T5', 'T3', 'T4A', 'T5008'];

/**
 * Validate a slip before it is stored. Box values are typed in by hand from the
 * paper slip, and anything stored here is read by buildPersonalFacts on every
 * return — an unchecked "twelve" used to surface as a 500 on the whole T1.
 * Values are normalised to plain decimal strings ("1,200.50" → "1200.50").
 */
function parseSlipInput(body: { year: unknown; slipType: unknown; issuer: unknown; boxValues: unknown }):
  | { value: { year: number; slipType: SlipType; issuer: string; boxValues: TaxSlipBoxValues } }
  | { error: string } {
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: 'year must be an integer between 2000 and 2100' };
  }
  if (!SLIP_TYPES.includes(body.slipType as SlipType)) {
    return { error: `slipType must be one of ${SLIP_TYPES.join(', ')}` };
  }
  // The column is NOT NULL but the form allows a blank issuer, so '' is kept.
  if (typeof body.issuer !== 'string') {
    return { error: 'issuer must be a string' };
  }
  const raw = body.boxValues ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'boxValues must be an object of box → amount' };
  }
  const boxValues: TaxSlipBoxValues = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^box\d{1,3}[A-Za-z]?$/.test(key)) return { error: `"${key}" is not a box key (e.g. box14, box16A)` };
    const amount = parseSlipAmount(v);
    if (!amount) return { error: `${key}: "${String(v)}" is not an amount` };
    boxValues[key] = amount.toFixed(2);
  }
  return { value: { year, slipType: body.slipType as SlipType, issuer: body.issuer.trim(), boxValues } };
}

// POST /api/tax/slips — create a tax slip.
router.post('/slips', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { entityId, year, slipType, issuer, boxValues } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    const parsed = parseSlipInput({ year, slipType, issuer, boxValues });
    if ('error' in parsed) {
      res.status(400).json({ error: 'invalid_slip', message: parsed.error });
      return;
    }
    const entity = await Entity.findOne({
      where: { id: entityId as number, householdId: household.id },
    });
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    const slip = await TaxSlip.create({ entityId: entity.id, ...parsed.value });
    res.status(201).json({ slip });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal/:year/roll-forward — explicit carryforward roll for year N.
router.post('/personal/:year/roll-forward', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household.',
      });
      return;
    }

    const facts = await buildPersonalFacts(entity.id, year);
    let rates;
    try {
      rates = ratesFor(year);
    } catch (err) {
      if (err instanceof RateTableMissingError) {
        res.status(409).json({ error: 'rate_table_missing', message: (err as Error).message });
        return;
      }
      throw err;
    }

    // Build a minimal synthetic TaxReturn for roll — we only need the return shell
    const ret = buildT1(facts, rates);
    const result = await rollPersonalCarryforwards(entity.id, year, ret, facts, rates);

    res.status(200).json({
      rolled: true,
      year,
      written: result.written.map(w => ({ kind: w.kind, amount: w.amount.toFixed(4) })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal/years?from=YYYY&to=YYYY — multi-year compare.
router.get('/personal/years', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const fromYear = req.query.from ? Number(req.query.from) : new Date().getFullYear() - 2;
    const toYear = req.query.to ? Number(req.query.to) : new Date().getFullYear();

    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
      res.status(400).json({ error: 'invalid_range', message: 'from and to must be integers with from <= to.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({ error: 'no_personal_entity', message: 'No Personal entity for this household.' });
      return;
    }

    const snapshots = await TaxReturn.findAll({
      where: { entityId: entity.id },
      order: [['year', 'ASC']],
    });

    const years = snapshots
      .filter(s => s.year >= fromYear && s.year <= toYear)
      .map(s => ({
        year: s.year,
        computedAt: s.computedAt,
        totals: s.totals,
        warnings: s.warnings,
      }));

    res.json({ years });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/personal/:year/outlook — what is coming: whether instalments are
// required, what the three CRA options come to, when the balance is due, and the
// year at its current run rate.
//
// Every other tax endpoint answers what happened. This is the one that answers what
// Connor actually asked — "so I know what I'm getting myself into" — and his next
// cash obligation is a date nothing in the app named.
//
// Not cached. The run-rate projection changes as the calendar advances with no fact
// changing, which is the same reason the completeness report is recomputed per
// request.
router.get('/personal/:year/outlook', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({ error: 'no_personal_entity', message: 'No Personal entity for this household.' });
      return;
    }

    res.json(serializeOutlook(await buildOutlook({ entityId: entity.id, year })));
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      res.status(409).json({ error: 'rate_table_missing', message: err.message });
      return;
    }
    next(err);
  }
});

/** Decimals to fixed strings; the outlook is Decimal-valued throughout. */
function serializeOutlook(outlook: Awaited<ReturnType<typeof buildOutlook>>): unknown {
  const money = (d: { toFixed: (n: number) => string }) => d.toFixed(2);
  const instalments = (list: { dueOn: string; amount: { toFixed: (n: number) => string } }[]) =>
    list.map((i) => ({ dueOn: i.dueOn, amount: money(i.amount) }));
  return {
    year: outlook.year,
    netOwingByYear: outlook.netOwingByYear,
    projectedCurrentYearNetOwing: outlook.projectedCurrentYearNetOwing,
    provenanceWarnings: outlook.provenanceWarnings,
    obligation: {
      year: outlook.obligation.year,
      required: outlook.obligation.required,
      reason: outlook.obligation.reason,
      balanceDueOn: outlook.obligation.balanceDueOn,
      recommended: outlook.obligation.recommended,
      instalments: instalments(outlook.obligation.instalments),
      options: outlook.obligation.options.map((o) => ({
        basis: o.basis,
        total: money(o.total),
        balanceWithReturn: money(o.balanceWithReturn),
        carriesInterestRisk: o.carriesInterestRisk,
        instalments: instalments(o.instalments),
      })),
    },
    forward: {
      year: outlook.forward.year,
      isProjection: outlook.forward.isProjection,
      currentTotalPayable: outlook.forward.currentTotalPayable,
      projectedTotalPayable: outlook.forward.projectedTotalPayable,
      projectedAdditionalTax: outlook.forward.projectedAdditionalTax,
      draws: {
        actualToDate: money(outlook.forward.draws.actualToDate),
        monthlyRunRate: money(outlook.forward.draws.monthlyRunRate),
        projectedRemainder: money(outlook.forward.draws.projectedRemainder),
        projectedTotal: money(outlook.forward.draws.projectedTotal),
        coveredMonths: outlook.forward.draws.coveredMonths,
        uncoveredMonths: outlook.forward.draws.uncoveredMonths,
        basis: outlook.forward.draws.basis,
      },
    },
  };
}

// GET /api/tax/personal/:year/instalments — list instalment payments for the year.
router.get('/personal/:year/instalments', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({ error: 'no_personal_entity', message: 'No Personal entity for this household.' });
      return;
    }

    const payments = await InstalmentPayment.findAll({
      where: { entityId: entity.id, year },
      order: [['paidOn', 'ASC']],
    });

    res.json({ instalments: payments });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal/:year/instalments — record a new instalment payment.
router.post('/personal/:year/instalments', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.status(404).json({ error: 'no_personal_entity', message: 'No Personal entity for this household.' });
      return;
    }

    const { quarter, amount, paidOn, notes } = (req.body ?? {}) as Record<string, unknown>;

    if (!amount || !paidOn) {
      res.status(400).json({ error: 'missing_fields', message: 'amount and paidOn are required.' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payment = await (InstalmentPayment.create as any)({
      entityId: entity.id,
      year,
      quarter: quarter != null ? Number(quarter) : null,
      amount: String(amount),
      paidOn: String(paidOn),
      notes: notes != null ? String(notes) : null,
    });

    res.status(201).json({ instalment: payment });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/slips — list slips for the personal entity, optionally filtered by year.
router.get('/slips', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const entity = await resolvePersonalEntity(household.id, user.id);
    if (!entity) {
      res.json({ slips: [] });
      return;
    }
    const year = req.query.year ? Number(req.query.year) : undefined;
    const where: Record<string, unknown> = { entityId: entity.id };
    if (year !== undefined && Number.isInteger(year)) where.year = year;
    const rows = await TaxSlip.findAll({ where });
    res.json({ slips: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Corp routes
// ---------------------------------------------------------------------------

// GET /api/tax/corp/shareholder-loans — list shareholder loan entries for the corp entity.
// NOTE: this route must appear BEFORE /corp/:fiscalYear/return to avoid Express treating
// "shareholder-loans" as a :fiscalYear param.
router.get('/corp/shareholder-loans', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'corp' } });
    if (!entity) {
      res.json({ shareholderLoans: [], balance: '0.00' });
      return;
    }
    const rows = await ShareholderLoan.findAll({
      where: { entityId: entity.id },
      order: [['date', 'DESC']],
    });
    const balance = await computeShareholderLoanBalance(entity.id);
    res.json({ shareholderLoans: rows, balance: balance.toFixed(2) });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/corp/shareholder-loans — create a shareholder loan entry.
router.post('/corp/shareholder-loans', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { entityId, date, kind, amount, description } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    const entity = await Entity.findOne({
      where: { id: entityId as number, householdId: household.id, kind: 'corp' },
    });
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (ShareholderLoan.create as any)({
      entityId: entity.id,
      date,
      kind,
      amount,
      description: description ?? null,
    });
    res.status(201).json({ shareholderLoan: row });
  } catch (err) {
    next(err);
  }
});

// GET /api/tax/corp/:fiscalYear/return — compute (or return cached) T2 for the corp entity.
// fiscalYear param: 'YYYY' (calendar year) or 'YYYY-MM-DD/YYYY-MM-DD'
router.get('/corp/:fiscalYear/return', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const rawParam = req.params.fiscalYear;

    let fiscalYear: CorpFiscalYear;
    if (rawParam.includes('/')) {
      const parts = rawParam.split('/');
      if (parts.length !== 2) {
        res.status(400).json({ error: 'invalid_fiscal_year', message: 'Use YYYY or YYYY-MM-DD/YYYY-MM-DD.' });
        return;
      }
      fiscalYear = { startDate: parts[0], endDate: parts[1] };
    } else {
      const year = Number(rawParam);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        res.status(400).json({ error: 'invalid_fiscal_year', message: 'Year must be between 2000 and 2100.' });
        return;
      }
      fiscalYear = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'corp' } });
    if (!entity) {
      res.status(404).json({
        error: 'no_corp_entity',
        message: 'No Corp entity for this household. POST /api/tax/entities to create one.',
      });
      return;
    }

    const facts = await buildCorpFacts(entity.id, fiscalYear);
    // Keyed on the fiscal year's START year, which is not always the calendar
    // year the facts cover — an off-calendar year end straddles two.
    const snapshotYear = Number(fiscalYear.startDate.slice(0, 4));
    const rateTable = ratesFor(snapshotYear);
    // The fiscal year's own end date, not December 31: an off-calendar year end
    // closes mid-calendar-year and a year-based check would call it open.
    assertRatesUsable(rateTable, { periodEnd: fiscalYear.endDate, now: new Date() });
    const result = await computeEntityReturn({
      entityId: entity.id,
      cacheYear: snapshotYear,
      facts,
      run: (f) => buildT2(f, rateTable),
    });

    res.json({
      cached: result.cached,
      computedAt: result.computedAt,
      lines: result.lines,
      totals: result.totals,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      res.status(409).json({
        error: 'rate_table_missing',
        message: (err as Error).message,
      });
      return;
    }
    if (err instanceof ProjectedRatesError) {
      res.status(409).json({
        error: 'rate_table_projected',
        message: err.message,
        year: err.year,
      });
      return;
    }
    next(err);
  }
});

// POST /api/tax/corp/:fiscalYear/roll-forward
// Triggers rollCorpCarryforwards from the most recent snapshot for the fiscal year.
router.post('/corp/:fiscalYear/roll-forward', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const householdId = household.id;
    const entity = await Entity.findOne({ where: { householdId, kind: 'corp' } });
    if (!entity) {
      res.status(404).json({ error: 'no_corp_entity' });
      return;
    }
    // Parse fiscalYear param: 'YYYY' or 'YYYY-MM-DD/YYYY-MM-DD'
    const fy = String(req.params.fiscalYear);
    const yearStr = fy.includes('/') ? fy.split('/')[1].slice(0, 4) : fy;
    const asOfYear = Number(yearStr);
    if (!Number.isInteger(asOfYear) || asOfYear < 2000 || asOfYear > 2100) {
      res.status(400).json({ error: 'invalid_fiscal_year' });
      return;
    }
    // Look up the snapshot
    const snapshot = await TaxReturn.findOne({ where: { entityId: entity.id, year: asOfYear } });
    if (!snapshot) {
      res.status(404).json({
        error: 'no_snapshot',
        message: 'Compute corp return first via GET /api/tax/corp/:fiscalYear/return',
      });
      return;
    }
    // Reconstruct minimal CorpTaxReturn from snapshot.totals (stored as Decimal toFixed(2) strings)
    const totals = snapshot.totals as Record<string, string>;
    const { D } = await import('../tax/util/decimal');
    const corpRet = {
      fiscalYear: { startDate: `${asOfYear}-01-01`, endDate: `${asOfYear}-12-31` },
      lines: [],
      totals: {
        activeBusinessIncome: D(totals.activeBusinessIncome ?? '0'),
        sbdEligibleIncome: D(totals.sbdEligibleIncome ?? '0'),
        generalRateIncome: D(totals.generalRateIncome ?? '0'),
        aii: D(totals.aii ?? '0'),
        taxableIncome: D(totals.taxableIncome ?? '0'),
        federalTax: D(totals.federalTax ?? '0'),
        provincialTax: D(totals.provincialTax ?? '0'),
        refundableTaxOnAii: D(totals.refundableTaxOnAii ?? '0'),
        dividendRefund: D(totals.dividendRefund ?? '0'),
        netTaxPayable: D(totals.netTaxPayable ?? '0'),
        gripEnding: D(totals.gripEnding ?? '0'),
        cdaEnding: D(totals.cdaEnding ?? '0'),
        erdtohEnding: D(totals.erdtohEnding ?? '0'),
        nerdtohEnding: D(totals.nerdtohEnding ?? '0'),
      },
      warnings: [],
    };
    const { rollCorpCarryforwards } = await import('../tax/services/rollCorpCarryforwards');
    const result = await rollCorpCarryforwards(entity.id, asOfYear, corpRet as any);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
