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
        `(@huggingface/transformers could not be loaded, or its model files are ` +
        `missing from the image). ${rows} were left for the AI fallback instead.`
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
 * One stage's contribution: its warning, but only if it actually had cold rows
 * in front of it — a stage with nothing to work on cannot have failed to help.
 * Spread-shaped so the caller reads as pipeline order.
 */
function stageWarning(coldRowCount: number, warning: string | null): string[] {
  if (coldRowCount === 0) return [];
  return warning == null ? [] : [warning];
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
  return [
    ...stageWarning(embedding.coldRowCount, embeddingWarning(embedding)),
    ...stageWarning(ai.coldRowCount, aiWarning(ai)),
  ];
}
