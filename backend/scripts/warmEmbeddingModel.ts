/**
 * Bake the local sentence-embedding model into the build.
 *
 * `@huggingface/transformers` fetches model weights and tokenizer files from the
 * Hugging Face hub on FIRST USE, not at install time, into
 * `node_modules/@huggingface/transformers/.cache/`. That default is the exact
 * failure mode the embedding-match stage was built to avoid: a container with no
 * egress (or slow egress) would import a statement, reach the embedding stage,
 * fail to load a model, emit nothing, and log a warning — indistinguishable from
 * an import with nothing to categorise. The stage would look installed and stay
 * dead.
 *
 * So the image warms the cache at BUILD time (see `backend/Dockerfile`, which
 * runs this immediately before the runner stage copies `node_modules`). Running
 * the real `getDefaultEmbedder()` rather than a hand-written `pipeline()` call
 * means the files fetched are exactly the files production loads — the model id
 * and the quantisation cannot drift between this script and the code that uses
 * them.
 *
 * It is deliberately FAIL-LOUD, which is the opposite of the runtime posture.
 * At runtime an embedding failure must never fail an import; at build time an
 * embedding failure must fail the build, or the build has shipped a dead stage.
 */
import { getDefaultEmbedder, DEFAULT_EMBEDDING_MODEL } from '../src/ai/merchantEmbeddings';

/** all-MiniLM-L6-v2's output width. A model that loads but returns a different
 *  width would make every cached vector incomparable with the rest. */
const EXPECTED_DIMENSIONS = 384;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const embed = await getDefaultEmbedder();
  if (embed == null) {
    throw new Error(
      `getDefaultEmbedder() returned null: could not load ${DEFAULT_EMBEDDING_MODEL}. ` +
        'The image would ship an embedding-match stage that silently emits nothing. ' +
        'Check that @huggingface/transformers installed and that the build has ' +
        'network access to huggingface.co.',
    );
  }

  const vector = await embed('WARMUP MERCHANT');
  if (vector.length !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `${DEFAULT_EMBEDDING_MODEL} returned ${vector.length} dimensions, expected ` +
        `${EXPECTED_DIMENSIONS}. The model files are wrong or truncated.`,
    );
  }
  if (!vector.every((n) => Number.isFinite(n))) {
    throw new Error(
      `${DEFAULT_EMBEDDING_MODEL} returned a non-finite component; the weights are corrupt.`,
    );
  }

  process.stdout.write(
    `embedding model ready: ${DEFAULT_EMBEDDING_MODEL}, ${vector.length} dims, ` +
      `${Date.now() - startedAt}ms\n`,
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`embedding model warm-up FAILED: ${String(err)}\n`);
    process.exit(1);
  },
);
