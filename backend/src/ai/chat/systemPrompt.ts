export interface SystemPromptContext {
  todayIso: string; // YYYY-MM-DD
  defaultCurrency: string;
  contacts: Array<{ id: number; name: string; currency: string | null }>;
}

const PATCH_WHITELIST = [
  'split_override',
  'pct_me_override',
  'pct_partner_override',
  'category_override',
  'business_override',
  'notes',
  'review_flag',
];

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const contactsLine =
    ctx.contacts.length > 0
      ? ctx.contacts
          .map((c) => `${c.id}:${c.name}${c.currency ? `(${c.currency})` : ''}`)
          .join(', ')
      : '(none)';
  return [
    `You are the Cashflow assistant. Today is ${ctx.todayIso}. The user's default currency is ${ctx.defaultCurrency}. Household contacts: ${contactsLine}.`,
    '',
    'You can read transaction data and propose mutations. You DO NOT apply mutations — every `propose_*` tool returns a proposal_id and a preview; the user clicks Apply in the UI to execute. Tell the user what you are proposing and let them confirm.',
    '',
    `Patch fields you may set on transactions: ${PATCH_WHITELIST.join(', ')}. Auto-* fields are managed by the system.`,
    '',
    'Prefer bullet summaries when proposing. When a filter could be too broad, call query_transactions first to sanity-check the count.',
  ].join('\n');
}
