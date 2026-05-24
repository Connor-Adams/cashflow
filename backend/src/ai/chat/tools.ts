import { Op } from 'sequelize';
import {
  Transaction,
  Rule,
  Contact,
} from '../../models';
import { sequelize } from '../../db';
import type { ChatToolDefinition } from './openaiClient';

/**
 * Escape LIKE wildcards in user-supplied substrings. We use LIKE (not REGEXP)
 * because the sqlite3 npm package this repo uses does not register a REGEXP
 * function by default; LIKE works on both SQLite and Postgres without extra
 * setup. The tool's `merchant_pattern` field is documented as a case-insensitive
 * substring — if the LLM needs alternation it can call the tool multiple times
 * and union the results.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ToolContext {
  userId: number;
  householdId: number | null;
  threadId: number;
  messageId: number;
}

export interface ToolResult {
  ok: true;
  data: unknown;
}
export interface ToolError {
  ok: false;
  error: string;
}
export type ToolReturn = ToolResult | ToolError;

interface ToolImpl {
  schema: ChatToolDefinition;
  execute(args: unknown, ctx: ToolContext): Promise<ToolReturn>;
}

const tools: Record<string, ToolImpl> = {};

export function registerTool(name: string, impl: ToolImpl) {
  tools[name] = impl;
}

export function getToolDefinitions(): ChatToolDefinition[] {
  return Object.values(tools).map((t) => t.schema);
}

export async function dispatchTool(
  name: string,
  argsJson: string,
  ctx: ToolContext
): Promise<ToolReturn> {
  const t = tools[name];
  if (!t) return { ok: false, error: `unknown tool: ${name}` };
  let parsed: unknown;
  try {
    parsed = argsJson.trim().length === 0 ? {} : JSON.parse(argsJson);
  } catch {
    return { ok: false, error: 'tool arguments must be valid JSON' };
  }
  try {
    return await t.execute(parsed, ctx);
  } catch (e) {
    return {
      ok: false,
      error: `tool execution failed: ${(e as Error).message}`,
    };
  }
}

// ============================================================================
// query_transactions
// ============================================================================
registerTool('query_transactions', {
  schema: {
    type: 'function',
    function: {
      name: 'query_transactions',
      description:
        'Search the user transactions by filter. Returns up to `limit` matching rows plus the total matched count. Use to ground answers and to sanity-check the scope of a future bulk mutation.',
      parameters: {
        type: 'object',
        properties: {
          merchant_pattern: {
            type: 'string',
            description:
              'Case-insensitive substring applied to merchant_clean. Call the tool multiple times if you need alternation (`grocer` then `loblaws`).',
          },
          category: { type: 'string' },
          currency: { type: 'string' },
          date_from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          date_to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          account_id: { type: 'integer' },
          split_type: {
            type: 'string',
            enum: ['me', 'partner', 'shared', 'business'],
          },
          review_flag: { type: 'boolean' },
          min_amount: { type: 'number' },
          max_amount: { type: 'number' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    if (typeof a.merchant_pattern === 'string')
      where.merchantClean = { [Op.like]: `%${escapeLikePattern(a.merchant_pattern)}%` };
    if (typeof a.category === 'string') where.finalCategory = a.category;
    if (typeof a.currency === 'string') where.currency = a.currency;
    if (typeof a.account_id === 'number') where.accountId = a.account_id;
    if (typeof a.split_type === 'string') where.finalSplitType = a.split_type;
    if (typeof a.review_flag === 'boolean') where.reviewFlag = a.review_flag;
    const dateRange: Record<string, unknown> = {};
    if (typeof a.date_from === 'string') dateRange[Op.gte as unknown as string] = a.date_from;
    if (typeof a.date_to === 'string') dateRange[Op.lte as unknown as string] = a.date_to;
    if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
    const amountRange: Record<string, unknown> = {};
    if (typeof a.min_amount === 'number') amountRange[Op.gte as unknown as string] = a.min_amount;
    if (typeof a.max_amount === 'number') amountRange[Op.lte as unknown as string] = a.max_amount;
    if (Object.getOwnPropertySymbols(amountRange).length > 0) where.amount = amountRange;

    const limit = Math.min(
      Math.max(typeof a.limit === 'number' ? Math.floor(a.limit) : 20, 1),
      50
    );
    const matchedCount = await Transaction.count({ where });
    const rows = await Transaction.findAll({
      where,
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });
    return {
      ok: true,
      data: {
        matched_count: matchedCount,
        rows: rows.map((r) => {
          const j = r.toJSON();
          return {
            id: j.id,
            date: j.date,
            merchant_clean: j.merchantClean,
            amount: j.amount,
            currency: j.currency,
            final_category: j.finalCategory,
            final_business: j.finalBusiness,
            final_split_type: j.finalSplitType,
            final_pct_me: j.finalPctMe,
            final_pct_partner: j.finalPctPartner,
            review_flag: j.reviewFlag,
          };
        }),
      },
    };
  },
});

// ============================================================================
// get_summary
// ============================================================================
registerTool('get_summary', {
  schema: {
    type: 'function',
    function: {
      name: 'get_summary',
      description:
        'Aggregated totals. Wraps the existing /api/summary endpoints. Pick scope based on what the user is asking — dashboard for overall spend, partner for partner-split totals, business for business spend, monthly for a month-by-month breakdown.',
      parameters: {
        type: 'object',
        required: ['scope'],
        properties: {
          scope: { type: 'string', enum: ['dashboard', 'partner', 'business', 'monthly'] },
          currency: { type: 'string' },
          date_from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          date_to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    if (typeof a.scope !== 'string') {
      return { ok: false, error: 'scope is required' };
    }
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    if (typeof a.currency === 'string') where.currency = a.currency;
    const dateRange: Record<string, unknown> = {};
    if (typeof a.date_from === 'string') dateRange[Op.gte as unknown as string] = a.date_from;
    if (typeof a.date_to === 'string') dateRange[Op.lte as unknown as string] = a.date_to;
    if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;

    if (a.scope === 'dashboard') {
      const [count, sumRow] = await Promise.all([
        Transaction.count({ where }),
        Transaction.findOne({
          where,
          attributes: [
            [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
            [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'total_my_share'],
            [
              sequelize.fn('SUM', sequelize.col('partner_share_amount')),
              'total_partner_share',
            ],
            [sequelize.fn('SUM', sequelize.col('business_amount')), 'total_business'],
          ],
          raw: true,
        }),
      ]);
      return {
        ok: true,
        data: { count, ...(sumRow as unknown as Record<string, unknown>) },
      };
    }
    if (a.scope === 'partner') {
      const grouped = await Transaction.findAll({
        where,
        attributes: [
          'finalSplitType',
          [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'my_share'],
          [
            sequelize.fn('SUM', sequelize.col('partner_share_amount')),
            'partner_share',
          ],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['finalSplitType'],
        raw: true,
      });
      return { ok: true, data: { by_split_type: grouped } };
    }
    if (a.scope === 'business') {
      const total = await Transaction.findOne({
        where: { ...where, finalBusiness: true },
        attributes: [
          [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        raw: true,
      });
      return { ok: true, data: total };
    }
    if (a.scope === 'monthly') {
      const dialect = sequelize.getDialect();
      const monthExpr =
        dialect === 'postgres'
          ? sequelize.fn('to_char', sequelize.col('date'), 'YYYY-MM')
          : sequelize.fn('strftime', '%Y-%m', sequelize.col('date'));
      const grouped = await Transaction.findAll({
        where,
        attributes: [
          [monthExpr, 'month'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['month'],
        order: [[sequelize.literal('month'), 'ASC']],
        raw: true,
      });
      return { ok: true, data: { by_month: grouped } };
    }
    return { ok: false, error: `unknown scope: ${a.scope}` };
  },
});

// ============================================================================
// get_rules
// ============================================================================
registerTool('get_rules', {
  schema: {
    type: 'function',
    function: {
      name: 'get_rules',
      description:
        'List all rules visible to the user, optionally filtered to those effective on a given date.',
      parameters: {
        type: 'object',
        properties: {
          active_on: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    const all = await Rule.findAll({
      where,
      order: [
        ['priority', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const active_on = typeof a.active_on === 'string' ? a.active_on : null;
    const filtered = active_on
      ? all.filter((r) => {
          const j = r.toJSON();
          if (j.effectiveFrom != null && active_on < j.effectiveFrom) return false;
          if (j.effectiveTo != null && active_on >= j.effectiveTo) return false;
          return true;
        })
      : all;
    return { ok: true, data: filtered.map((r) => r.toJSON()) };
  },
});

// ============================================================================
// get_contacts
// ============================================================================
registerTool('get_contacts', {
  schema: {
    type: 'function',
    function: {
      name: 'get_contacts',
      description:
        'List the household contacts (partner, payees). Useful for resolving a name to a contact id when proposing transaction edits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async execute(_args, ctx) {
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    const rows = await Contact.findAll({ where, order: [['id', 'ASC']] });
    return {
      ok: true,
      data: rows.map((r) => {
        const j = r.toJSON() as { id: number; name: string; currency?: string | null };
        return { id: j.id, name: j.name, currency: j.currency ?? null };
      }),
    };
  },
});

// ============================================================================
// get_categories
// ============================================================================
registerTool('get_categories', {
  schema: {
    type: 'function',
    function: {
      name: 'get_categories',
      description:
        'List the distinct categories already in use across rules and transactions. Use this for category vocabulary grounding before proposing a category change.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async execute(_args, ctx) {
    const tWhere: Record<string, unknown> = {
      finalCategory: { [Op.ne]: null },
    };
    if (ctx.householdId != null) tWhere.householdId = ctx.householdId;
    const txnRows = await Transaction.findAll({
      where: tWhere,
      attributes: [
        [sequelize.fn('DISTINCT', sequelize.col('final_category')), 'category'],
      ],
      raw: true,
    });
    const rWhere: Record<string, unknown> = {
      category: { [Op.ne]: null },
    };
    if (ctx.householdId != null) rWhere.householdId = ctx.householdId;
    const ruleRows = await Rule.findAll({
      where: rWhere,
      attributes: [
        [sequelize.fn('DISTINCT', sequelize.col('category')), 'category'],
      ],
      raw: true,
    });
    const set = new Set<string>();
    for (const r of txnRows as unknown as Array<{ category: string | null }>) {
      if (r.category) set.add(r.category);
    }
    for (const r of ruleRows as unknown as Array<{ category: string | null }>) {
      if (r.category) set.add(r.category);
    }
    return { ok: true, data: { categories: [...set].sort() } };
  },
});
