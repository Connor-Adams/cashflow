/**
 * Turns "the cold-row fallback did not run" into something an operator can see.
 *
 * Both fallbacks were designed to fail soft — an embedding or OpenAI failure
 * must never fail an import — and both did so completely silently. The result
 * was that an import which categorised nothing because a fallback was
 * *unavailable* was indistinguishable from an import with nothing left to
 * categorise. Two mechanisms sat switched off in production for months, with
 * `merchant_embeddings` empty and no `auto_source = 'ai'` row anywhere, and
 * nothing in any import result said so.
 *
 * Shared by every import route (statement commit and folder CSV) so the text
 * and the thresholds for "worth saying" cannot fork between them.
 *
 * Deliberately quiet about the non-faults: a household with no reviewed
 * merchants yet (`no_priors`) is a genuine cold start, and zero cold rows means
 * the deterministic stages did their job. Neither earns a warning.
 */
import type { AiBatchSummary } from './aiBatchOverColdRows';
import type { EmbeddingMatchSummary } from './embeddingMatchOverColdRows';

function embeddingWarning(summary: EmbeddingMatchSummary): string | null {
  const rows = `${summary.coldRowCount} uncategorised row(s)`;
  switch (summary.skipReason) {
    case 'embedder_unavailable':
      return (
        `Embedding match did not run: no local embedding model is available ` +
        `(@xenova/transformers is not installed). ${rows} were left for the AI ` +
        `fallback instead.`
      );
    case 'disabled':
      return (
        `Embedding match is switched off (ENRICHMENT_EMBEDDING_ENABLED=false). ` +
        `${rows} were not matched against this household's known merchants.`
      );
    case 'stage_error':
      return (
        `Embedding match failed, so ${rows} were not matched locally. ` +
        `The rest of the import was unaffected.`
      );
    default:
      // ran, no_cold_rows, no_household, no_priors — nothing an operator can act on.
      return null;
  }
}

function aiWarning(summary: AiBatchSummary): string | null {
  const rows = `${summary.coldRowCount} uncategorised row(s)`;
  switch (summary.skipReason) {
    case 'no_openai_config':
      return (
        `AI categorisation did not run: no OpenAI configuration (OPENAI_API_KEY ` +
        `is unset), so it is unavailable. ${rows} were left uncategorised.`
      );
    case 'disabled':
      return (
        `AI categorisation is switched off (ENRICHMENT_AI_ENABLED=false). ` +
        `${rows} were left uncategorised.`
      );
    default:
      return null;
  }
}

/**
 * Warnings for the fallbacks that could not run, in pipeline order (embedding
 * before AI). Empty when both ran, or when there was nothing cold for them to
 * work on.
 */
export function coldRowFallbackWarnings(
  embedding: EmbeddingMatchSummary,
  ai: AiBatchSummary,
): string[] {
  const out: string[] = [];
  // A stage with no cold rows in front of it cannot have failed to help.
  if (embedding.coldRowCount > 0) {
    const w = embeddingWarning(embedding);
    if (w != null) out.push(w);
  }
  if (ai.coldRowCount > 0) {
    const w = aiWarning(ai);
    if (w != null) out.push(w);
  }
  return out;
}
