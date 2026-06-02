import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { Entity, TaxReturn, TaxSlip, Carryforward, ShareholderLoan, InstalmentPayment, Transaction, sequelize } from '../models';
import { buildPersonalFacts } from '../tax/builders/buildPersonalFacts';
import { buildCorpFacts } from '../tax/builders/buildCorpFacts';
import { buildT1 } from '../tax/engine/t1';
import { buildT2 } from '../tax/engine/t2';
import { ratesFor, supportedYears, RateTableMissingError } from '../tax/engine/brackets';
import { factsHash } from '../tax/util/factsHash';
import type { CorpFiscalYear } from '../tax/engine/types';
import { rollPersonalCarryforwards } from '../tax/services/rollPersonalCarryforwards';
import { buildReconciliationReport } from '../tax/reconciliation/buildReport';

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
        entityId,
        date: { [Op.between]: [start, end] },
        txnType: 'transfer',
        linkedTransactionId: { [Op.ne]: null },
        taxTreatmentOverride: null,
      },
    });
    const corpDistributions: Array<{ personal: unknown; corp: unknown }> = [];
    for (const leg of personalLegs) {
      const other = await Transaction.findByPk(leg.linkedTransactionId as number);
      if (other && other.entityId != null && corpEntityIds.has(other.entityId)) {
        corpDistributions.push({ personal: leg, corp: other });
      }
    }

    const payroll = await Transaction.findAll({
      where: { entityId, date: { [Op.between]: [start, end] }, txnType: 'income', taxTreatmentOverride: null },
    });

    res.json({ corpDistributions, payroll });
  } catch (e) {
    next(e);
  }
});

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
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
    if (!entity) {
      res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household. POST /api/tax/entities to create one.',
      });
      return;
    }

    const facts = await buildPersonalFacts(entity.id, year);
    const hash = factsHash(serializeFacts(facts));

    const cached = await TaxReturn.findOne({ where: { entityId: entity.id, year } });
    if (cached && cached.factsHash === hash) {
      res.json({
        cached: true,
        computedAt: cached.computedAt,
        lines: cached.lines,
        totals: cached.totals,
        warnings: cached.warnings,
      });
      return;
    }

    const ret = buildT1(facts, ratesFor(year));
    const lines = serializeLines(ret.lines);
    const totals = serializeTotals(ret.totals);
    const computedAt = new Date();

    if (cached) {
      await cached.update({
        factsHash: hash,
        computedAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lines: lines as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        totals: totals as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        warnings: ret.warnings as any,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (TaxReturn.create as any)({
        entityId: entity.id,
        year,
        factsHash: hash,
        computedAt,
        lines,
        totals,
        warnings: ret.warnings,
      });
    }

    // Optional ?roll=true: after snapshot, auto-roll carryforwards for this year
    if (req.query.roll === 'true') {
      try {
        await rollPersonalCarryforwards(entity.id, year, ret, facts, ratesFor(year));
      } catch {
        // Roll failure is non-fatal; include a warning but still return the return
        ret.warnings.push('carryforward_roll_failed');
      }
    }

    res.json({ cached: false, computedAt, lines, totals, warnings: ret.warnings });
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      res.status(409).json({
        error: 'rate_table_missing',
        message: (err as Error).message,
      });
      return;
    }
    next(err);
  }
});

// GET /api/tax/personal/:year/reconciliation — slip / txn / categorisation issues.
router.get('/personal/:year/reconciliation', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }
    const entity = await Entity.findOne({
      where: { householdId: household.id, kind: 'personal' },
    });
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
    const { household } = currentAuth(req);
    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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

// POST /api/tax/slips — create a tax slip.
router.post('/slips', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { entityId, year, slipType, issuer, boxValues } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    const entity = await Entity.findOne({
      where: { id: entityId as number, householdId: household.id },
    });
    if (!entity) {
      res.status(404).json({ error: 'entity_not_found' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slip = await (TaxSlip.create as any)({
      entityId: entity.id,
      year,
      slipType,
      issuer,
      boxValues,
    });
    res.status(201).json({ slip });
  } catch (err) {
    next(err);
  }
});

// POST /api/tax/personal/:year/roll-forward — explicit carryforward roll for year N.
router.post('/personal/:year/roll-forward', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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
    const { household } = currentAuth(req);
    const fromYear = req.query.from ? Number(req.query.from) : new Date().getFullYear() - 2;
    const toYear = req.query.to ? Number(req.query.to) : new Date().getFullYear();

    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
      res.status(400).json({ error: 'invalid_range', message: 'from and to must be integers with from <= to.' });
      return;
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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

// GET /api/tax/personal/:year/instalments — list instalment payments for the year.
router.get('/personal/:year/instalments', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }

    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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
    const { household } = currentAuth(req);
    const entity = await Entity.findOne({ where: { householdId: household.id, kind: 'personal' } });
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
      res.json({ shareholderLoans: [] });
      return;
    }
    const rows = await ShareholderLoan.findAll({
      where: { entityId: entity.id },
      order: [['date', 'DESC']],
    });
    res.json({ shareholderLoans: rows });
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
    const hash = factsHash(serializeFacts(facts));

    const snapshotYear = Number(fiscalYear.startDate.slice(0, 4));
    const cached = await TaxReturn.findOne({ where: { entityId: entity.id, year: snapshotYear } });
    if (cached && cached.factsHash === hash) {
      res.json({
        cached: true,
        computedAt: cached.computedAt,
        lines: cached.lines,
        totals: cached.totals,
        warnings: cached.warnings,
      });
      return;
    }

    const rateTable = ratesFor(snapshotYear);
    const ret = buildT2(facts, rateTable);
    const lines = serializeLines(ret.lines);
    const totals = serializeTotals(ret.totals);
    const computedAt = new Date();

    if (cached) {
      await cached.update({
        factsHash: hash,
        computedAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lines: lines as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        totals: totals as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        warnings: ret.warnings as any,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (TaxReturn.create as any)({
        entityId: entity.id,
        year: snapshotYear,
        factsHash: hash,
        computedAt,
        lines,
        totals,
        warnings: ret.warnings,
      });
    }

    res.json({ cached: false, computedAt, lines, totals, warnings: ret.warnings });
  } catch (err) {
    if (err instanceof RateTableMissingError) {
      res.status(409).json({
        error: 'rate_table_missing',
        message: (err as Error).message,
      });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Serialization helpers: convert Decimal → string before DB storage / response.
// ---------------------------------------------------------------------------

/**
 * Deep-serialize facts: converts Decimal instances to fixed-precision strings
 * so that `factsHash` produces a stable, JSON-encodable representation.
 */
function serializeFacts(facts: unknown): unknown {
  return JSON.parse(
    JSON.stringify(facts, (_k, v) => {
      if (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
        (v as { constructor?: { name?: string } }).constructor?.name === 'Decimal'
      ) {
        return (v as { toFixed: (n: number) => string }).toFixed(8);
      }
      return v;
    })
  );
}

function serializeLines(lines: Array<{
  code: string;
  label: string;
  amount: { toFixed: (n: number) => string };
  inputs: Array<{ source: string; amount: { toFixed: (n: number) => string } }>;
  formula?: string;
}>): unknown {
  return lines.map((l) => ({
    ...l,
    amount: l.amount.toFixed(2),
    inputs: l.inputs.map((i) => ({ ...i, amount: i.amount.toFixed(2) })),
  }));
}

function serializeTotals(totals: Record<string, { toFixed: (n: number) => string }>): unknown {
  return Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)])
  );
}

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
