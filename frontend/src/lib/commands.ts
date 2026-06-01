/**
 * Finance command palette registry (issue #237).
 *
 * A command is a discoverable, runnable action exposed through the global
 * ⌘K / Ctrl+K palette. Each command has:
 *   - id: stable string used as React key and for analytics.
 *   - label: primary text shown in the palette.
 *   - description: optional secondary text.
 *   - keywords: extra search terms that should match this command (e.g.
 *     "create" matches "Add planned bill" via the keyword "add").
 *   - category: groups commands in the palette ("Navigate", "Create",
 *     "Search", "Run", "Context").
 *   - destination: react-router path to navigate to when run.
 *
 * Some commands are *contextual* — they only make sense on certain
 * pages. Those carry a `contextMatch` predicate evaluated against the
 * current URL path.
 *
 * No backend coupling: the registry is a static array. Contextual
 * commands are activated by passing the current pathname into
 * `filterCommands`.
 */

export type CommandCategory =
  | 'Navigate'
  | 'Create'
  | 'Search'
  | 'Run'
  | 'Context'

export type Command = {
  id: string
  label: string
  description?: string
  keywords?: string[]
  category: CommandCategory
  /**
   * react-router path to navigate to when this command runs.
   *
   * Most commands navigate. Modal-opening commands deep-link to a page
   * that owns the modal (e.g. `/rules` for "Create rule") — keeps the
   * registry decoupled from feature-specific modal state.
   */
  destination: string
  /**
   * Predicate determining whether this command is available given the
   * current URL pathname. When omitted, the command is always
   * available.
   */
  contextMatch?: (pathname: string) => boolean
}

/**
 * Built-in commands. Order here drives the order shown in the empty
 * search state; once the user types, results are re-sorted by match
 * score (see `scoreCommand`).
 */
export const COMMANDS: Command[] = [
  // Navigate — primary routes -----------------------------------------------
  {
    id: 'nav-dashboard',
    label: 'Go to Dashboard',
    description: 'Open the household overview',
    category: 'Navigate',
    destination: '/',
    keywords: ['home', 'overview'],
  },
  {
    id: 'nav-transactions',
    label: 'Go to Transactions',
    description: 'Browse and filter every transaction',
    category: 'Navigate',
    destination: '/transactions',
    keywords: ['ledger', 'expenses', 'list'],
  },
  {
    id: 'nav-review',
    label: 'Go to Review Inbox',
    description: 'Clear unreviewed imported rows',
    category: 'Navigate',
    destination: '/review',
    keywords: ['inbox', 'queue', 'triage'],
  },
  {
    id: 'nav-refunds',
    label: 'Go to Refunds Review',
    category: 'Navigate',
    destination: '/refunds',
    keywords: ['returns', 'credits'],
  },
  {
    id: 'nav-rules',
    label: 'Go to Rules',
    description: 'Manage automatic categorization rules',
    category: 'Navigate',
    destination: '/rules',
    keywords: ['automation', 'patterns'],
  },
  {
    id: 'nav-import',
    label: 'Go to Import',
    description: 'Upload a new bank or card statement',
    category: 'Navigate',
    destination: '/import',
    keywords: ['upload', 'csv', 'statement'],
  },
  {
    id: 'nav-reports',
    label: 'Go to Reports',
    category: 'Navigate',
    destination: '/reports',
    keywords: ['analytics', 'charts'],
  },
  {
    id: 'nav-explain-month',
    label: 'Go to Explain Month',
    description: 'Per-month breakdown of where the money went',
    category: 'Navigate',
    destination: '/reports/explain-month',
    keywords: ['monthly', 'summary', 'report'],
  },
  {
    id: 'nav-sankey',
    label: 'Go to Cashflow chart',
    description: 'Sankey view of inflows and outflows',
    category: 'Navigate',
    destination: '/sankey',
    keywords: ['sankey', 'flow', 'visualization'],
  },
  {
    id: 'nav-accounts',
    label: 'Go to Accounts',
    category: 'Navigate',
    destination: '/accounts',
    keywords: ['banks', 'cards'],
  },
  {
    id: 'nav-recurring',
    label: 'Go to Recurring',
    category: 'Navigate',
    destination: '/recurring',
    keywords: ['subscriptions', 'monthly'],
  },
  {
    id: 'nav-subscriptions',
    label: 'Go to Subscriptions',
    category: 'Navigate',
    destination: '/subscriptions',
  },
  {
    id: 'nav-planned',
    label: 'Go to Planned events',
    description: 'Upcoming bills and known future expenses',
    category: 'Navigate',
    destination: '/planned',
    keywords: ['bills', 'upcoming', 'calendar'],
  },
  {
    id: 'nav-calendar',
    label: 'Go to Calendar',
    category: 'Navigate',
    destination: '/calendar',
  },
  {
    id: 'nav-goals',
    label: 'Go to Goals',
    category: 'Navigate',
    destination: '/goals',
    keywords: ['targets', 'saving'],
  },
  {
    id: 'nav-forecast',
    label: 'Go to Forecast',
    category: 'Navigate',
    destination: '/forecast',
    keywords: ['projection', 'future'],
  },
  {
    id: 'nav-debt',
    label: 'Go to Debt payoff',
    category: 'Navigate',
    destination: '/debt',
    keywords: ['debt', 'payoff', 'avalanche', 'snowball', 'loan', 'credit card'],
  },
  {
    id: 'nav-net-worth',
    label: 'Go to Net worth',
    category: 'Navigate',
    destination: '/net-worth',
    keywords: ['wealth', 'assets'],
  },
  {
    id: 'nav-portfolio',
    label: 'Go to Portfolio',
    category: 'Navigate',
    destination: '/portfolio',
    keywords: ['investments', 'securities'],
  },
  {
    id: 'nav-insights',
    label: 'Go to Insights',
    category: 'Navigate',
    destination: '/insights',
  },
  {
    id: 'nav-data-quality',
    label: 'Go to Data quality',
    category: 'Navigate',
    destination: '/data-quality',
  },
  {
    id: 'nav-money-leaks',
    label: 'Go to Money leaks',
    category: 'Navigate',
    destination: '/money-leaks',
  },
  {
    id: 'nav-receipts',
    label: 'Go to Receipts',
    category: 'Navigate',
    destination: '/receipts',
  },
  {
    id: 'nav-amazon',
    label: 'Go to Amazon orders',
    category: 'Navigate',
    destination: '/receipts?vendor=amazon',
  },
  {
    id: 'nav-items',
    label: 'Go to Items',
    category: 'Navigate',
    destination: '/items',
  },
  {
    id: 'nav-tax',
    label: 'Go to Tax',
    category: 'Navigate',
    destination: '/tax',
  },
  {
    id: 'nav-return-warranty',
    label: 'Go to Returns and warranties',
    category: 'Navigate',
    destination: '/return-warranty',
    keywords: ['warranty', 'return'],
  },
  {
    id: 'nav-settings',
    label: 'Go to Settings',
    category: 'Navigate',
    destination: '/settings',
  },
  {
    id: 'nav-partner',
    label: 'Go to Partner fairness',
    category: 'Navigate',
    destination: '/partner',
    keywords: ['split', 'shared'],
  },

  // Create — primary creation flows ----------------------------------------
  {
    id: 'create-rule',
    label: 'Create rule',
    description: 'Add a new auto-categorization rule',
    category: 'Create',
    destination: '/rules',
    keywords: ['new', 'add', 'rule', 'automation'],
  },
  {
    id: 'create-planned-bill',
    label: 'Add planned bill',
    description: 'Track an upcoming bill in Planned events',
    category: 'Create',
    destination: '/planned',
    keywords: ['new', 'add', 'bill', 'upcoming'],
  },
  {
    id: 'create-goal',
    label: 'Add saving goal',
    category: 'Create',
    destination: '/goals',
    keywords: ['new', 'add', 'target', 'savings'],
  },

  // Search — discovery surfaces --------------------------------------------
  {
    id: 'search-transactions',
    label: 'Search transactions',
    description: 'Find transactions by merchant, amount, or note',
    category: 'Search',
    destination: '/transactions',
    keywords: ['find', 'lookup'],
  },
  {
    id: 'search-merchants',
    label: 'Search merchants',
    category: 'Search',
    destination: '/transactions',
    keywords: ['vendor', 'business'],
  },

  // Run — workflows --------------------------------------------------------
  {
    id: 'run-import-statement',
    label: 'Import statement',
    description: 'Upload a bank or card export',
    category: 'Run',
    destination: '/import',
    keywords: ['upload', 'csv', 'bank'],
  },
  {
    id: 'run-attach-receipts',
    label: 'Attach receipts',
    description: 'Open the Items page to attach receipts',
    category: 'Run',
    destination: '/items',
    keywords: ['receipt', 'attach', 'pdf', 'photo'],
  },
  {
    id: 'run-monthly-close',
    label: 'Run monthly close',
    description: 'Open Explain Month for the close workflow',
    category: 'Run',
    destination: '/reports/explain-month',
    keywords: ['close', 'monthly', 'review'],
  },
  {
    id: 'run-ask-cashflow',
    label: 'Ask Cashflow',
    description: 'Ask a natural-language question about your data',
    category: 'Run',
    destination: '/ask',
    keywords: ['ai', 'query', 'natural language'],
  },

  // Context — only available on specific pages -----------------------------
  {
    id: 'ctx-create-rule-from-merchant',
    label: 'Create rule for this merchant',
    description: 'Open the rules page to add a rule for the current merchant',
    category: 'Context',
    destination: '/rules',
    keywords: ['rule', 'merchant'],
    contextMatch: (path) => path.startsWith('/merchants/'),
  },
  {
    id: 'ctx-view-merchant-transactions',
    label: 'View all merchant transactions',
    description: 'Filter the transactions table to this merchant',
    category: 'Context',
    destination: '/transactions',
    keywords: ['transactions', 'merchant'],
    contextMatch: (path) => path.startsWith('/merchants/'),
  },
  {
    id: 'ctx-add-bulk-rule',
    label: 'Bulk-categorize visible transactions',
    description: 'Open Review Inbox to create a rule from the current rows',
    category: 'Context',
    destination: '/review',
    keywords: ['bulk', 'review', 'rule'],
    contextMatch: (path) => path === '/transactions',
  },
]

/**
 * Normalize a string for matching. Lowercases and strips diacritics so
 * `"Cafe"` matches `"Café"`.
 */
function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * Compute a score for how well `command` matches `query`. Higher is better.
 *
 * Heuristic:
 *   - exact label match → 100
 *   - label starts with query → 80
 *   - label substring → 60
 *   - description substring → 40
 *   - any keyword starts with query → 30
 *   - any keyword substring → 20
 *   - category substring → 10
 *   - no match → 0
 *
 * Used by `filterCommands` to rank visible commands. Returns 0 for an
 * empty query (caller treats that as "show everything").
 */
export function scoreCommand(command: Command, query: string): number {
  const q = normalize(query.trim())
  if (q.length === 0) return 0

  const label = normalize(command.label)
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  if (label.includes(q)) return 60

  if (command.description && normalize(command.description).includes(q)) {
    return 40
  }

  const keywords = command.keywords ?? []
  for (const kw of keywords) {
    const n = normalize(kw)
    if (n.startsWith(q)) return 30
    if (n.includes(q)) return 20
  }

  if (normalize(command.category).includes(q)) return 10

  return 0
}

export type FilterCommandsOptions = {
  /** Search query. Empty → show all (within `pathname` context). */
  query: string
  /**
   * Current router pathname. Drives whether contextual commands are
   * included. Pass `''` to suppress all contextual commands.
   */
  pathname: string
  /**
   * Optional explicit registry override (useful for tests).
   */
  registry?: Command[]
  /**
   * Cap on returned results. Defaults to `Infinity`.
   */
  limit?: number
}

/**
 * Filter the command registry to those available given the current
 * route, optionally narrowed by `query` and ordered by match score.
 *
 * Empty-query behaviour: return commands in registry order, but
 * contextual commands always sort to the top.
 */
export function filterCommands(opts: FilterCommandsOptions): Command[] {
  const { query, pathname, registry = COMMANDS, limit = Infinity } = opts

  // Stage 1 — drop contextual commands that don't match this path.
  const available = registry.filter((cmd) => {
    if (!cmd.contextMatch) return true
    return cmd.contextMatch(pathname)
  })

  const trimmed = query.trim()
  if (trimmed.length === 0) {
    // Empty query: keep registry order but float Context commands up.
    const sorted = [...available].sort((a, b) => {
      const aCtx = a.category === 'Context' ? 0 : 1
      const bCtx = b.category === 'Context' ? 0 : 1
      return aCtx - bCtx
    })
    return sorted.slice(0, limit)
  }

  // Stage 2 — score, drop zero-score entries, sort descending. Stable
  // ordering: tie-break by registry position so the same query always
  // yields the same list.
  const scored = available
    .map((cmd, idx) => ({ cmd, score: scoreCommand(cmd, trimmed), idx }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.idx - b.idx
    })

  return scored.slice(0, limit).map((entry) => entry.cmd)
}

/**
 * Group commands by category, preserving order within each group.
 * Returned in a stable category order for consistent UI.
 */
export function groupCommandsByCategory(
  commands: Command[],
): Array<{ category: CommandCategory; commands: Command[] }> {
  const order: CommandCategory[] = ['Context', 'Navigate', 'Create', 'Search', 'Run']
  const buckets = new Map<CommandCategory, Command[]>()
  for (const cat of order) buckets.set(cat, [])
  for (const cmd of commands) {
    const list = buckets.get(cmd.category)
    if (list) list.push(cmd)
  }
  return order
    .map((category) => ({ category, commands: buckets.get(category) ?? [] }))
    .filter((group) => group.commands.length > 0)
}
