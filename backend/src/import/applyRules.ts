import { Rule } from '../models';

export interface RuleRow {
  id: number;
  merchantPattern: string;
  priority: number;
  matchKind: string;
  category: string | null;
  isBusiness: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  /** Inclusive lower bound on Transaction.date (YYYY-MM-DD); null = "always". */
  effectiveFrom: string | null;
  /** Exclusive upper bound on Transaction.date (YYYY-MM-DD); null = "forever". */
  effectiveTo: string | null;
}

export function findBestRule(
  rulesAll: RuleRow[],
  merchantClean: string,
  txnDate?: string
): { rule: RuleRow | null; ambiguous: boolean } {
  const candidates: RuleRow[] = [];
  for (const rule of rulesAll) {
    if (txnDate != null) {
      if (rule.effectiveFrom != null && txnDate < rule.effectiveFrom) continue;
      if (rule.effectiveTo != null && txnDate >= rule.effectiveTo) continue;
    }
    const pattern = rule.merchantPattern || '';
    let ok = false;
    if (rule.matchKind === 'regex') {
      try {
        const re = new RegExp(pattern, 'i');
        ok = re.test(merchantClean);
      } catch {
        ok = false;
      }
    } else {
      ok = merchantClean.toLowerCase().includes(pattern.toLowerCase());
    }
    if (ok) candidates.push(rule);
  }
  if (candidates.length === 0) return { rule: null, ambiguous: false };

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const la = (a.merchantPattern || '').length;
    const lb = (b.merchantPattern || '').length;
    if (lb !== la) return lb - la;
    return b.id - a.id;
  });

  const best = candidates[0];
  const second = candidates[1];
  if (second) {
    const samePriority = second.priority === best.priority;
    const sameLen =
      (second.merchantPattern || '').length === (best.merchantPattern || '').length;
    if (samePriority && sameLen) {
      return { rule: null, ambiguous: true };
    }
  }
  return { rule: best, ambiguous: false };
}

export async function loadAllRules(householdId?: number | null): Promise<RuleRow[]> {
  const rows = await Rule.findAll({
    where: householdId != null ? { householdId } : undefined,
    order: [['id', 'ASC']],
  });
  return rows.map((r) => r.toJSON() as RuleRow);
}

export function applyRuleToAuto(rule: RuleRow): {
  autoCategory: string | null;
  autoBusiness: boolean;
  autoSplitType: string;
  autoPctMe: string | null;
  autoPctPartner: string | null;
} {
  return {
    autoCategory: rule.category || null,
    autoBusiness: rule.isBusiness,
    autoSplitType: rule.splitType,
    autoPctMe: rule.pctMe != null ? String(rule.pctMe) : null,
    autoPctPartner: rule.pctPartner != null ? String(rule.pctPartner) : null,
  };
}
