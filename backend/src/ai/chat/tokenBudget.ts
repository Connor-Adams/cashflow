/**
 * Per-day per-user token budget accounting (PR2 Task 14).
 *
 * `todaysTokenUsage` sums prompt + completion tokens across all ChatMessage
 * rows whose thread belongs to `userId` since the most recent UTC midnight.
 * Implemented via a two-step query (thread ids → SUM) instead of a JOIN
 * because there's no Sequelize association between ChatMessage and ChatThread
 * yet; this keeps the model layer untouched and the SQL straightforward.
 */
import { ChatMessage, ChatThread } from '../../models';
import { Op } from 'sequelize';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  total: number;
}

/** Sum tokens used by `userId` since UTC midnight today. */
export async function todaysTokenUsage(userId: number): Promise<TokenUsage> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  // Get thread ids for this user
  const threads = await ChatThread.findAll({
    where: { userId },
    attributes: ['id'],
    raw: true,
  });
  const threadIds = (threads as Array<{ id: number }>).map((t) => t.id);
  if (threadIds.length === 0) {
    return { promptTokens: 0, completionTokens: 0, total: 0 };
  }
  const row = (await ChatMessage.findOne({
    where: { threadId: { [Op.in]: threadIds }, createdAt: { [Op.gte]: since } },
    attributes: [
      [sequelize.fn('SUM', sequelize.col('prompt_tokens')), 'p'],
      [sequelize.fn('SUM', sequelize.col('completion_tokens')), 'c'],
    ],
    raw: true,
  })) as { p: number | null; c: number | null } | null;
  const p = Number(row?.p ?? 0);
  const c = Number(row?.c ?? 0);
  return { promptTokens: p, completionTokens: c, total: p + c };
}

export async function isUserOverBudget(userId: number): Promise<{
  over: boolean;
  used: number;
  budget: number;
}> {
  const usage = await todaysTokenUsage(userId);
  const budget = getChatConfig().dailyTokenBudget;
  return { over: usage.total >= budget, used: usage.total, budget };
}
