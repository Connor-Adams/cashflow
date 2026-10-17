/**
 * Shared building blocks for the two "action item" list builders that
 * independently grew near-identical logic: the CFO briefing
 * (`buildCfoBriefing` in `./briefingBuilder`) and the AI review runner
 * (`buildReviewActionItems` in `../ai/reviewRunner`). Both surface an
 * "overdue planned event" forecast warning and a "rule suggestion" item
 * from the same underlying data.
 *
 * The two callers build genuinely DIFFERENT types though —
 * `CfoBriefingActionItem` (status: 'open'|'resolved'|'dismissed', its own
 * `link` field) vs `AiReviewActionItem` (status:
 * 'suggested'|'accepted'|'dismissed', no `link`) — so this module only
 * extracts the part that is byte-for-byte identical between the two: the
 * overdue-events query, and the title/summary/rationale content for each
 * item kind. Each caller still assembles its own item literal, attaching
 * its own `status`, `type` literal, and any fields the other primitive
 * doesn't have.
 */

import { Op } from 'sequelize';
import { PlannedEvent } from '../models';
import { num } from '../util/numbers';
import type { RuleProposal } from '../ai/ruleProposals';

/** Row shape returned by {@link loadOverduePlannedEvents}. */
export interface OverduePlannedEventRow {
  id: number;
  name: string;
  expectedDate: string;
  amount: unknown;
  type: string;
}

/**
 * Planned events (kind='planned') still in 'planned' status whose
 * `expectedDate` is before `beforeDate` — i.e. they should have posted by
 * now but haven't. Shared by the CFO briefing and the AI review runner,
 * which both surface these rows as "forecast warning" action items.
 */
export async function loadOverduePlannedEvents(
  householdId: number,
  beforeDate: string,
): Promise<OverduePlannedEventRow[]> {
  const rows = await PlannedEvent.findAll({
    where: {
      householdId,
      kind: 'planned',
      status: 'planned',
      expectedDate: { [Op.lt]: beforeDate },
    },
    attributes: ['id', 'name', 'expectedDate', 'amount', 'type'],
    raw: true,
  });
  return rows as unknown as OverduePlannedEventRow[];
}

/**
 * Absolute value of a possibly-null / decimal-string amount, 0 when
 * unparsable. Both callers had their own copy of this under different
 * names (`safeAbsNumber`, `safeNumber`) with identical bodies — genuinely
 * the same helper, not a deliberate divergence.
 */
export function safeAbsNumber(value: unknown): number {
  const n = num(value);
  return n == null ? 0 : Math.abs(n);
}

/**
 * Shared content for a "forecast warning" item built from an overdue
 * planned event. `title`/`summary`/`rationale` are identical in both
 * callers; only `status` (and the CFO briefing's `link`) differ, so each
 * caller wraps this with its own status + type literal.
 */
export interface OverdueEventItemContent {
  id: string;
  refType: 'event';
  refId: number;
  severity: 'watch';
  title: string;
  summary: string;
  rationale: string;
  supportingTransactionIds: number[];
}

export function buildOverdueEventItemContent(
  row: OverduePlannedEventRow,
  currency: string,
): OverdueEventItemContent {
  return {
    id: `forecast_warning-${row.id}`,
    refType: 'event',
    refId: row.id,
    severity: 'watch',
    title: `Planned ${row.type} overdue: ${row.name}`,
    summary: `${row.name} (${safeAbsNumber(row.amount).toFixed(2)} ${currency}) expected on ${row.expectedDate} but not posted.`,
    rationale: 'Planned event still in "planned" status past its expected date.',
    supportingTransactionIds: [],
  };
}

/**
 * Shared content for a "rule suggestion" item built from a rule proposal.
 * `summary`/`rationale`/`id` are identical between callers, but the
 * *title* text itself deliberately differs ("Suggested rule: ..." in the
 * CFO briefing vs "Create rule for ..." in the AI review runner) — so
 * `title` is a required parameter here rather than baked in, letting each
 * caller keep its own wording while still sharing everything else.
 */
export interface RuleSuggestionItemContent {
  id: string;
  refType: 'rule';
  refId: null;
  severity: 'info';
  title: string;
  summary: string;
  rationale: string;
  supportingTransactionIds: number[];
}

export function buildRuleSuggestionItemContent(
  proposal: RuleProposal,
  title: string,
): RuleSuggestionItemContent {
  return {
    id: `rule_suggestion-${proposal.merchantPattern}`,
    refType: 'rule',
    refId: null,
    severity: 'info',
    title,
    summary: `${proposal.supportCount} reviewed transactions match "${proposal.merchantPattern}" → ${proposal.category ?? '(no category)'}.`,
    rationale: 'Detected by repeated manual categorizations sharing a merchant pattern.',
    supportingTransactionIds: proposal.exampleTransactionIds,
  };
}
