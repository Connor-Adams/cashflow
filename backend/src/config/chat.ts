/**
 * Chat-feature config. Reads env vars on each call (rather than caching) so
 * tests can manipulate process.env freely.
 */
export interface ChatConfig {
  enabled: boolean;
  /** OpenAI model for chat turns. Falls back to OPENAI_MODEL, then gpt-4o-mini. */
  model: string;
  /** Per-user per-day token budget. Hard stop when exceeded. */
  dailyTokenBudget: number;
  /** Max tool calls per user turn before the loop summarizes and stops. */
  maxToolCallsPerTurn: number;
  /** Drift threshold for proposal apply (0..1). e.g. 0.2 = ±20%. */
  proposalDriftPct: number;
  /** Hours until a pending proposal auto-expires. */
  proposalExpiryHours: number;
  /** Per-thread message rate limit: max user messages per hour. */
  perThreadMessagesPerHour: number;
  /** Hard cap on conversation history replayed to the model each turn. */
  historyWindowMessages: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getChatConfig(): ChatConfig {
  return {
    enabled: process.env.CHAT_ENABLED === 'true',
    model:
      process.env.CHAT_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-4o-mini',
    dailyTokenBudget: numEnv('CHAT_DAILY_TOKEN_BUDGET', 200_000),
    maxToolCallsPerTurn: numEnv('CHAT_MAX_TOOL_CALLS_PER_TURN', 8),
    proposalDriftPct: (() => {
      const raw = process.env.CHAT_PROPOSAL_DRIFT_PCT;
      if (!raw) return 0.2;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
    })(),
    proposalExpiryHours: numEnv('CHAT_PROPOSAL_EXPIRY_HOURS', 24),
    perThreadMessagesPerHour: numEnv('CHAT_PER_THREAD_MSGS_PER_HOUR', 30),
    historyWindowMessages: numEnv('CHAT_HISTORY_WINDOW_MESSAGES', 20),
  };
}
