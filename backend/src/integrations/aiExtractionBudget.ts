/**
 * Per-household/day AI-extraction budget (issue #870).
 *
 * The email scan + discovery pipelines fall back to an OpenAI extraction for any
 * receipt-shaped message a deterministic vendor parser can't handle. A flooded
 * inbox would otherwise turn into one billed OpenAI call per *new* attacker
 * email — `ProcessedEmailMessage` dedup only stops re-billing the *same* message.
 *
 * This module bounds the daily blast radius: every AI extraction is recorded in
 * `processed_email_messages` with `parser = 'ai'`, so the count of today's AI
 * rows IS the household's spend so far. A scan opens a budget at start (cap minus
 * today's spend), each AI call decrements it, and once exhausted the pipeline
 * stops calling AI for the rest of the run — deterministic parses still proceed.
 */
import { Op } from 'sequelize';
import { ProcessedEmailMessage } from '../models';
import { dailyAiExtractionCap } from '../config/env';

/** Start of the current UTC day (00:00:00.000Z). */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Count AI extractions already billed to a household today (UTC). Reads the
 * durable scan log (`parser = 'ai'`, `scannedAt >= start of UTC day`), so the
 * count survives across separate scan/discover requests within the same day.
 */
export async function countTodaysAiExtractions(householdId: number, now: Date = new Date()): Promise<number> {
  return ProcessedEmailMessage.count({
    where: {
      householdId,
      parser: 'ai',
      scannedAt: { [Op.gte]: startOfUtcDay(now) },
    },
  });
}

/**
 * A consumable budget of AI extractions for a single scan/discover run. Created
 * with whatever remains of the household's daily cap. `tryConsume()` returns
 * `true` (and decrements) while budget is left, `false` once exhausted.
 */
export interface AiExtractionBudget {
  /** Whether an AI call is still affordable; decrements on `true`. */
  tryConsume(): boolean;
  /** Remaining AI extractions before the cap is hit. */
  remaining(): number;
  /** True once the cap has been reached (no budget left). */
  exhausted(): boolean;
  /** Number of AI calls this run skipped because the cap was hit. */
  capped(): number;
}

/** Build a budget from an explicit remaining count (already cap-minus-spent). */
export function makeAiExtractionBudget(remaining: number): AiExtractionBudget {
  let left = Math.max(0, Math.floor(remaining));
  let cappedCount = 0;
  return {
    tryConsume() {
      if (left <= 0) {
        cappedCount++;
        return false;
      }
      left--;
      return true;
    },
    remaining() {
      return left;
    },
    exhausted() {
      return left <= 0;
    },
    capped() {
      return cappedCount;
    },
  };
}

/**
 * Open a daily AI-extraction budget for a household: the configured cap minus
 * what's already been spent today. A `null` householdId (anonymous/default
 * scans, which never persist a count) gets the full cap.
 */
export async function openDailyAiBudget(
  householdId: number | null,
  now: Date = new Date(),
): Promise<AiExtractionBudget> {
  const cap = dailyAiExtractionCap();
  const spent = householdId == null ? 0 : await countTodaysAiExtractions(householdId, now);
  return makeAiExtractionBudget(cap - spent);
}
