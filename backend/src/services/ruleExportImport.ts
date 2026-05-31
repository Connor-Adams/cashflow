import { format } from 'date-fns';
import { Op } from 'sequelize';
import { Rule, sequelize } from '../models';

export const EXPORT_SCHEMA_VERSION = 1;

export type ExportedRule = {
  merchantPattern: string;
  matchKind: string;
  priority: number;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

export type RulesExport = {
  schemaVersion: number;
  exportedAt: string;
  exportedBy: string;
  rules: ExportedRule[];
};

export type ImportResult = {
  imported: number;
  skipped: number;
  errors: { name: string; reason: string }[];
};

function toExportedRule(r: InstanceType<typeof Rule>): ExportedRule {
  return {
    merchantPattern: r.merchantPattern,
    matchKind: r.matchKind,
    priority: r.priority,
    category: r.category,
    isBusiness: r.isBusiness,
    splitType: r.splitType,
    pctMe: r.pctMe,
    pctPartner: r.pctPartner,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  };
}

export async function exportRulesForHousehold(
  householdId: number,
  userId: number,
): Promise<RulesExport> {
  const rules = await Rule.findAll({
    where: { householdId },
    order: [
      ['priority', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: String(userId),
    rules: rules.map(toExportedRule),
  };
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateExportedRule(
  rule: unknown,
  idx: number,
): { ok: true; value: ExportedRule } | { ok: false; reason: string } {
  if (!rule || typeof rule !== 'object') {
    return { ok: false, reason: `Rule at index ${idx} is not an object` };
  }
  const r = rule as Record<string, unknown>;
  if (!r.merchantPattern || typeof r.merchantPattern !== 'string') {
    return { ok: false, reason: 'Missing or invalid merchantPattern' };
  }
  const matchKind = typeof r.matchKind === 'string' ? r.matchKind : 'substring';
  const priority = typeof r.priority === 'number' ? r.priority : 0;
  const splitType = typeof r.splitType === 'string' ? r.splitType : 'me';
  const isBusiness = Boolean(r.isBusiness);
  const category = r.category != null ? String(r.category) : null;
  const pctMe = r.pctMe != null ? String(r.pctMe) : null;
  const pctPartner = r.pctPartner != null ? String(r.pctPartner) : null;

  function parseOptionalDate(val: unknown, field: string): string | null | { error: string } {
    if (val == null) return null;
    if (typeof val !== 'string' || !DATE_ONLY_RE.test(val)) {
      return { error: `${field} must be YYYY-MM-DD or null` };
    }
    return val;
  }

  const fromResult = parseOptionalDate(r.effectiveFrom, 'effectiveFrom');
  if (fromResult && typeof fromResult === 'object' && 'error' in fromResult) {
    return { ok: false, reason: fromResult.error };
  }
  const toResult = parseOptionalDate(r.effectiveTo, 'effectiveTo');
  if (toResult && typeof toResult === 'object' && 'error' in toResult) {
    return { ok: false, reason: toResult.error };
  }

  return {
    ok: true,
    value: {
      merchantPattern: r.merchantPattern,
      matchKind,
      priority,
      category,
      isBusiness,
      splitType,
      pctMe,
      pctPartner,
      effectiveFrom: fromResult as string | null,
      effectiveTo: toResult as string | null,
    },
  };
}

export async function importRulesForHousehold(
  payload: RulesExport,
  mode: 'append' | 'replace',
  householdId: number,
  userId: number,
): Promise<ImportResult> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const validRules: ExportedRule[] = [];
  const errors: { name: string; reason: string }[] = [];

  for (let i = 0; i < payload.rules.length; i++) {
    const result = validateExportedRule(payload.rules[i], i);
    if (!result.ok) {
      const name =
        (payload.rules[i] as Record<string, unknown>)?.merchantPattern as string ??
        `rule[${i}]`;
      errors.push({ name, reason: result.reason });
    } else {
      validRules.push(result.value);
    }
  }

  if (mode === 'replace') {
    await sequelize.transaction(async (t) => {
      await Rule.destroy({ where: { householdId }, transaction: t });
      if (validRules.length > 0) {
        await Rule.bulkCreate(
          validRules.map((r) => ({ ...r, householdId, createdByUserId: userId })),
          { transaction: t },
        );
      }
    });
  } else {
    if (validRules.length > 0) {
      const existing = await Rule.findAll({
        where: {
          householdId,
          merchantPattern: { [Op.in]: validRules.map((r) => r.merchantPattern) },
        },
        attributes: ['merchantPattern'],
      });
      const taken = new Set(existing.map((r) => r.merchantPattern));
      const rows = validRules.map((r) => ({
        ...r,
        merchantPattern: taken.has(r.merchantPattern)
          ? `${r.merchantPattern} (imported ${today})`
          : r.merchantPattern,
        householdId,
        createdByUserId: userId,
      }));
      await Rule.bulkCreate(rows);
    }
  }

  return { imported: validRules.length, skipped: 0, errors };
}
