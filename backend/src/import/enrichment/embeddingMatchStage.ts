/**
 * Stage 5.5 — embedding-match. A local, offline-capable semantic generalization
 * of merchant-memory (#792). Runs over the cold rows the deterministic pipeline
 * (stages 1-7) and merchant-memory (stage 5) left behind, BEFORE the OpenAI
 * batch (`aiBatchStage`). For each cold row it embeds the row's `merchant_clean`
 * and compares (cosine similarity) against the household's previously-reviewed
 * merchants. If the best similarity clears the threshold (inclusive `>=`), it
 * emits a `Signal{source:'embedding'}` carrying the matched merchant's category /
 * business / split, a similarity-derived confidence, and a rationale naming the
 * matched merchant. Below threshold → no signal; the row stays cold and reaches
 * the OpenAI batch unchanged.
 *
 * This module is PURE/synchronous over already-computed vectors — the embed +
 * cache + household-prior load happen in the orchestrator
 * (`embeddingMatchOverColdRows.ts`), so this stage is trivially unit-testable
 * with hand-crafted vectors.
 */
import { cosineSimilarity, type HouseholdMerchant } from '../../ai/merchantEmbeddings';
import type { Confidence, Signal } from './types';

/** A household prior paired with its (already-computed) embedding vector. */
export type PriorEmbedding = {
  merchant: HouseholdMerchant;
  vector: number[];
};

export type EmbeddingMatchInput = {
  /** The cold row's merchant_clean embedding. */
  rowVector: number[];
  priors: PriorEmbedding[];
  /** Inclusive cosine threshold; default ~0.85. */
  threshold: number;
};

export type EmbeddingMatch = {
  merchantClean: string;
  category: string | null;
  business: boolean;
  splitType: string;
  pctMe: string | null;
  pctPartner: string | null;
  similarity: number;
  supportCount: number;
};

/** Map a cosine similarity into the existing high/medium/low confidence band.
 *  Anything reaching the stage is >= threshold (default 0.85) so it is at least
 *  medium; >= 0.92 is high. */
export function similarityToConfidence(similarity: number): Confidence {
  if (similarity >= 0.92) return 'high';
  return 'medium';
}

export function similarityToPct(similarity: number): number {
  return Math.round(similarity * 100);
}

/**
 * Pick the best prior at/above threshold. Tie-break: highest similarity, then
 * (on an exact similarity tie) the higher support count. Returns null when no
 * prior clears the threshold.
 */
export function bestEmbeddingMatch(input: EmbeddingMatchInput): EmbeddingMatch | null {
  let best: EmbeddingMatch | null = null;
  for (const p of input.priors) {
    const sim = cosineSimilarity(input.rowVector, p.vector);
    if (sim < input.threshold) continue;
    const candidate: EmbeddingMatch = {
      merchantClean: p.merchant.merchantClean,
      category: p.merchant.category,
      business: p.merchant.business,
      splitType: p.merchant.splitType,
      pctMe: p.merchant.pctMe,
      pctPartner: p.merchant.pctPartner,
      similarity: sim,
      supportCount: p.merchant.supportCount,
    };
    if (
      best == null ||
      candidate.similarity > best.similarity ||
      (candidate.similarity === best.similarity && candidate.supportCount > best.supportCount)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Produce the embedding signal(s) for one cold row. Empty array when no prior
 * clears the threshold (row stays cold → OpenAI batch). Mirrors the field shape
 * carried by merchant-memory so downstream merge/persist treat it identically.
 */
export function runEmbeddingMatchStage(input: EmbeddingMatchInput): Signal[] {
  const match = bestEmbeddingMatch(input);
  if (match == null) return [];

  const pct = similarityToPct(match.similarity);
  const note = `Matched to "${match.merchantClean}" you categorized before (${pct}% similar).`;

  return [
    {
      source: 'embedding',
      confidence: similarityToConfidence(match.similarity),
      fields: {
        autoCategory: match.category,
        autoBusiness: match.business,
        autoSplitType: match.splitType,
        autoPctMe: match.pctMe,
        autoPctPartner: match.pctPartner,
        notes: note,
      },
      rationale: `similar merchant: "${match.merchantClean}" (${pct}% similar, ${match.supportCount} prior decision(s))`,
    },
  ];
}
