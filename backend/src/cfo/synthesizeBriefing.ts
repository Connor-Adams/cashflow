/**
 * LLM synthesis pass over the briefing's deterministic action items.
 *
 * The items themselves stay deterministic — the model may only order them and
 * write a narrative over them. It never sees raw transactions and never
 * supplies a figure, so it has no way to invent one. Any ranking entry naming
 * an id we did not send is dropped.
 *
 * Follows the degradation contract already used by routes/reports.ts
 * `maybeBuildAiSummary`: no key or any failure returns nulls and the caller
 * keeps its deterministic output.
 */
import type {
  CfoBriefingActionItem,
  CfoBriefingSafeToSpendSnapshot,
} from '../models/CfoBriefing';
import { getOpenAiConfig } from '../config/openai';
import { openaiJson } from '../ai/openaiJson';
import { logger } from '../observability/logger';

export interface SynthesisResult {
  summary: string | null;
  ordered: CfoBriefingActionItem[];
}

export function parseSynthesis(
  raw: Record<string, unknown>,
  items: CfoBriefingActionItem[],
): SynthesisResult {
  const summary =
    typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : null;

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered: CfoBriefingActionItem[] = [];
  const used = new Set<string>();

  if (Array.isArray(raw.ranking)) {
    for (const entry of raw.ranking) {
      const id =
        entry && typeof entry === 'object'
          ? (entry as { id?: unknown }).id
          : undefined;
      if (typeof id !== 'string') continue;
      if (used.has(id)) continue;
      const match = byId.get(id);
      if (!match) continue; // fabricated id — drop it
      used.add(id);
      ordered.push(match);
    }
  }

  // Anything the model omitted keeps its original relative order, after the
  // ranked items.
  for (const i of items) {
    if (!used.has(i.id)) ordered.push(i);
  }

  return { summary, ordered };
}

const SYSTEM_PROMPT = [
  'You are a household CFO writing a short briefing.',
  'You receive a JSON list of action items that were computed deterministically, plus an optional safe-to-spend snapshot.',
  'Write a 2-4 sentence plain-English summary of what needs attention, and rank the items by what the household should deal with first.',
  'Refer only to figures that appear in the input. Never introduce a number that is not there.',
  'Never invent an item id. Only use ids present in the input.',
  'Return strict JSON: { "summary": "...", "ranking": [{ "id": "...", "why": "..." }] }.',
].join(' ');

export async function synthesizeBriefing(args: {
  items: CfoBriefingActionItem[];
  safeToSpend: CfoBriefingSafeToSpendSnapshot | null;
  currency: string;
  /** Test seam — defaults to the real client. */
  openaiJsonImpl?: typeof openaiJson;
}): Promise<SynthesisResult> {
  const { items, safeToSpend, currency } = args;
  if (items.length === 0) return { summary: null, ordered: [] };

  const call = args.openaiJsonImpl ?? openaiJson;
  if (!args.openaiJsonImpl && !getOpenAiConfig()) {
    return { summary: null, ordered: items };
  }

  try {
    const payload = {
      currency,
      safeToSpend,
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        title: i.title,
        summary: i.summary,
      })),
    };
    const raw = await call([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ]);
    return parseSynthesis(raw, items);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'cfo_briefing_synthesis_failed',
    );
    return { summary: null, ordered: items };
  }
}
