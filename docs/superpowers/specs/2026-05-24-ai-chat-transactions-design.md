# AI Chat for Transactions — Design

**Date:** 2026-05-24
**Status:** Draft (pending spec review)
**Driver:** Editing splits / categories / rules through the existing forms is slow for life-events that change policy across many transactions ("I moved in with my partner — groceries after Dec 2026 should split 50/50"). A conversational interface can express a temporal policy change in one sentence and apply it across both the existing data and the rules that govern future imports.

## Goal

A `/chat` page where the user converses with an OpenAI-backed assistant that can:

- Read transactions, rules, contacts, categories, and the existing summary aggregations.
- Propose mutations to transactions (single + bulk) and to rules (create / update / delete, including date-scoped rules).
- Show every proposed mutation as a preview card the user must Apply or Reject.

The assistant never executes mutations directly — every mutation is staged as a `ChatProposal` and applied via a user-driven HTTP call from the UI.

## Non-goals (deferred)

- Settlements (`PartnerSettlement`) via chat.
- Receipt analysis / vision triggered from chat.
- AI suggestion (existing `/transactions/:id/ai-suggest`) re-exposed as a chat tool.
- Account / household / contact / portfolio mutations.
- Recurring-detection mutations.
- Pluggable LLM providers — OpenAI only.
- Shared (household-wide) threads — per-user only.
- Background sweeper for expired proposals — lazy expiry only.

## Current state (what already exists)

- `backend/src/ai/openaiJson.ts` — single-shot JSON completion helper used by `suggestTransaction.ts`, `auditTransactions.ts`, `ruleProposals.ts`, `insights.ts`, etc.
- `backend/src/ai/suggestionStore.ts` — persists AI suggestions with model / prompt / token / latency / provider-request-id metadata.
- `backend/src/routes/transactions.ts:219` — `POST /transactions/bulk-patch` (by ids, max 200).
- `backend/src/routes/transactions.ts:281` — `POST /transactions/bulk-patch-filter` (by filter; capped by `BULK_PATCH_FILTER_MAX`).
- `backend/src/routes/transactions.ts:348` — `GET /transactions/category-hints` (categories in use).
- `backend/src/routes/summary.ts` — `/api/summary/dashboard | partner | business | monthly`.
- `backend/src/routes/rules.ts` — full CRUD on rules. **Rule schema has no date scoping** (no `effective_from` / `effective_to`).
- `backend/src/routes/aiRateLimit.ts` — per-user AI rate-limit middleware.
- `backend/src/import/applyRules.ts` — selects the highest-priority matching rule at import time; takes no date into account.
- `frontend/src/pages/` — existing pages use a shared sidebar/nav; `/review`, `/portfolio`, `/settings`, etc.

No chat infrastructure exists today.

## Architecture

### Walkthrough — motivating example

> User: "I moved in with my partner so transactions after December 2026 for groceries should be split 50/50."

1. `POST /api/chat/threads/:id/messages` appends the user message and enters a tool-calling loop.
2. Model calls `query_transactions({ merchant_pattern: "grocer|grocery|loblaws|...", date_from: "2026-12-01", limit: 5 })` → backend returns sample rows + `matched_count`.
3. Model calls `propose_rule_create({ merchant_pattern, match_kind: "regex", split_type: "shared", pct_me: 0.5, pct_partner: 0.5, effective_from: "2026-12-01" })` → backend creates `ChatProposal { kind: "rule_create", status: "pending" }`, returns `{ proposal_id, preview }`.
4. Model calls `propose_bulk_patch({ filter: { merchant_pattern, date_from: "2026-12-01" }, patch: { split_override: "shared", pct_me_override: 0.5, pct_partner_override: 0.5 } })` → backend creates `ChatProposal { kind: "bulk_patch" }`, returns `{ proposal_id, preview }`.
5. Model emits assistant text: "Proposing a rule for groceries split 50/50 starting Dec 1 2026, plus a bulk patch on 23 existing transactions in that date range. Confirm to apply."
6. UI renders two proposal cards inline with the assistant message; user clicks **Apply both**.
7. Frontend `POST /api/chat/proposals/:id/apply` for each. Backend executes inside a Sequelize transaction, updates the proposal status, appends a `role=tool` message with the result.

A follow-up "actually make it 60/40" runs the same loop with `propose_rule_update` (on the rule just created) + `propose_bulk_patch` on the same filter, with the new percentages.

### Data model — schema changes

**Modify `rules` table** (one migration, additive, no backfill needed):

```
effective_from  DATE  NULL   -- inclusive; NULL = "always"
effective_to    DATE  NULL   -- exclusive; NULL = "forever"
```

Rule selection at import time becomes:

```
SELECT rules WHERE merchant matches AND
  (effective_from IS NULL OR txn_date >= effective_from) AND
  (effective_to   IS NULL OR txn_date <  effective_to)
ORDER BY priority DESC, id ASC LIMIT 1
```

Existing rules remain unchanged in behavior (both columns null).

**New tables:**

`chat_threads`:

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| user_id | INTEGER FK | scoping; not nullable |
| title | STRING(256) | nullable; auto-generated from first user message |
| archived_at | DATE | nullable |
| last_message_at | DATE | indexed; for thread-list ordering |
| created_at / updated_at | DATE | standard |

`chat_messages`:

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| thread_id | INTEGER FK | indexed |
| role | STRING(16) | `"user" \| "assistant" \| "tool"` |
| content_text | TEXT | nullable (assistant turns with only tool_calls have null content) |
| tool_calls | JSON | nullable; OpenAI tool-call array on assistant turns |
| tool_call_id | STRING(128) | nullable; set on `role="tool"` messages |
| tool_name | STRING(64) | nullable; set on `role="tool"` messages |
| model | STRING(64) | nullable; recorded on assistant turns |
| prompt_tokens / completion_tokens | INTEGER | nullable; recorded on assistant turns |
| latency_ms | INTEGER | nullable |
| provider_request_id | STRING(128) | nullable |
| created_at | DATE | |

Shape mirrors what OpenAI Chat Completions expects, so the conversation can be replayed verbatim on the next turn.

`chat_proposals`:

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| thread_id | INTEGER FK | indexed |
| message_id | INTEGER FK | the assistant message that proposed it |
| kind | STRING(32) | `"transaction_edit" \| "bulk_patch" \| "rule_create" \| "rule_update" \| "rule_delete"` |
| payload | JSON | exact patch / rule body to apply |
| preview | JSON | matched_count / sample / diff |
| status | STRING(16) | `"pending" \| "applied" \| "rejected" \| "expired"` |
| expires_at | DATE | `created_at + 24h` |
| applied_at | DATE | nullable |
| applied_result | JSON | nullable; ids touched + counts |
| created_at | DATE | |

### Tool surface

Read tools (auto-execute, no confirmation):

| Tool | Signature | Returns |
|---|---|---|
| `query_transactions` | `(filter, limit=20)` | up to N matching rows + `matched_count`. Filter fields: `merchant_pattern` (regex), `category`, `currency`, `date_from`, `date_to`, `account_id`, `split_type`, `review_flag`, `min_amount`, `max_amount`. |
| `get_summary` | `(scope, currency?, date_from?, date_to?)` | wraps `/api/summary/*`. `scope ∈ {dashboard, partner, business, monthly}`. |
| `get_rules` | `(active_on?)` | all visible rules, optionally filtered to those effective on a given date. |
| `get_contacts` | `()` | partner / payee contacts (id, name, currency). |
| `get_categories` | `()` | distinct `final_category` + rule categories. |

Mutation tools (return preview + `proposal_id`; **never execute**):

| Tool | Preview shape |
|---|---|
| `propose_transaction_edit` | `{ proposal_id, before, after }` for one row. |
| `propose_bulk_patch` | `{ proposal_id, matched_count, sample (≤10 rows with before/after), filter_summary }`. If `matched_count > BULK_PATCH_FILTER_MAX`, returns `{ error: "filter_too_broad", matched_count, max }` as the tool result (not an exception) so the model can refine and retry. |
| `propose_rule_create` | `{ proposal_id, rule_preview, would_affect_existing_count }`. |
| `propose_rule_update` | `{ proposal_id, before, after, would_affect_existing_count }`. |
| `propose_rule_delete` | `{ proposal_id, rule_summary }`. |

**Patch field whitelist** (transaction edits): `split_override`, `pct_me_override`, `pct_partner_override`, `category_override`, `business_override`, `notes`, `review_flag`. Auto-* fields remain system-managed.

**Apply is not a tool.** `POST /api/chat/proposals/:id/apply` is called by the UI when the user clicks Apply. The model has no path to apply directly.

### Proposal lifecycle

1. `propose_*` → `ChatProposal { status: "pending", expires_at: +24h }`.
2. Model emits assistant text referencing the proposals; UI renders cards.
3. User clicks Apply → `POST /api/chat/proposals/:id/apply`:
   - Asserts `status === "pending"` and not expired (else `409`).
   - Re-runs the matching query inside a Sequelize transaction.
   - Executes the mutation.
   - Sets `status = "applied"`, stores `applied_result`.
   - Appends a `role=tool` message to the thread with the result.
4. User clicks Reject → `POST /api/chat/proposals/:id/reject` → `status = "rejected"`, tool message recorded.
5. Expired proposals (`now > expires_at`) are marked `expired` lazily on access — no background sweeper.

**Count drift:** if at apply time `current_count` differs from `preview.matched_count` by more than 20%, the apply endpoint returns `409 { error: "count_drifted", preview_count, current_count }` and the UI surfaces a "data changed — review again?" prompt. ≤20% drift applies silently. Threshold (`CHAT_PROPOSAL_DRIFT_PCT`, default `0.2`) is env-configurable.

**Cross-tab safety:** apply uses the proposal row as the lock — `UPDATE chat_proposals SET status='applied' WHERE id = ? AND status = 'pending'` — zero rows updated → somebody else already applied / rejected.

### Tool-calling loop

`backend/src/ai/chat/loop.ts` exposes `runChatTurn({ thread, userMessage, signal })` → AsyncIterable of SSE events.

```
loop:
  messages = [systemPrompt, ...last20FromThread, userMessage]
  for step in 0..MAX_TOOL_CALLS (=8):
    response = await openai.streamChat({ messages, tools })
    yield assistant tokens as they stream
    if response has tool_calls:
      persist assistant message
      for each tool_call (parallel where safe):
        result = dispatch(tool_call)
        persist role=tool message
        append to messages
        yield tool_result event
      continue
    else:
      persist assistant message
      break
  if step == MAX_TOOL_CALLS:
    append synthetic system "tool budget exhausted; summarize and ask user"
    one more streamChat call without tools → final assistant text
```

The loop is interruptible via `AbortSignal` (UI cancel button → request abort).

### System prompt (server-built per turn)

```
You are the Cashflow assistant. Today is {YYYY-MM-DD}. The user's
default currency is {CAD/USD/...}. Household contacts: {id, name,
currency}[].

You can read transaction data and propose mutations. You DO NOT apply
mutations — every `propose_*` tool returns a proposal_id and a preview;
the user clicks Apply in the UI to execute. Tell the user what you're
proposing and let them confirm.

Patch fields you may set on transactions: split_override,
pct_me_override, pct_partner_override, category_override,
business_override, notes, review_flag. Auto-* fields are managed by
the system.

Prefer bullet summaries when proposing. When a filter could be too
broad, call query_transactions first to sanity-check the count.
```

User-controllable content (thread messages) is sent as `role=user` messages only — never spliced into the system prompt.

### Cost & safety controls

| Control | Setting | Behavior |
|---|---|---|
| Tool-call cap / turn | `CHAT_MAX_TOOL_CALLS_PER_TURN=8` | Loop terminates; final summary turn runs without tools. |
| Conversation context window | last 20 messages | Older messages elided with a system note. |
| Per-user rate limit | reuse `aiRateLimit.ts` | Existing middleware. |
| Per-thread message rate | 30 user messages / hour | `429` with `Retry-After`. |
| Per-day token budget | `CHAT_DAILY_TOKEN_BUDGET=200000` | Hard stop with friendly error. |
| AI gate | `OPENAI_API_KEY` present | `/api/ai/status` reports chat-enabled; UI shows setup hint when off. |
| Model | `CHAT_MODEL` (defaults to `OPENAI_MODEL`, which currently defaults to `gpt-4o-mini` in `backend/src/config/openai.ts`) | Chat reads its own env var so the user can run chat on a stronger model than single-shot AI features. Reliable tool-calling generally needs `gpt-4o` / `gpt-4.1` or better. |
| Logging | every turn | `{thread_id, message_id, model, prompt_tokens, completion_tokens, tool_calls_count, latency_ms, provider_request_id}` via existing observability. |

### Streaming transport

Server-Sent Events from `POST /api/chat/threads/:id/messages`. Event types:

- `assistant_token` — partial text delta.
- `tool_call_start` — `{ tool_name, args }`.
- `tool_call_result` — `{ tool_name, result_summary }` (preview JSON minus large arrays).
- `proposal` — `{ proposal_id, kind, preview }` (full preview for card rendering).
- `assistant_done` — final message id.
- `error` — `{ message, code }`.

No WebSocket. Reuses Express.

### Frontend

`frontend/src/pages/ChatPage.tsx` and `frontend/src/components/chat/`:

- Two-pane layout. Left (~280px): thread list with title + last-message timestamp, "+ New thread" button. Right: conversation pane.
- Conversation header: editable thread title (auto-generated from first user message), archive button.
- Message list: user right-aligned plain text; assistant left-aligned markdown; `role=tool` rendered as compact system rows ("Applied 23 transaction edits.").
- **Proposal cards** render inline with the assistant message that produced them, one per `proposal_id`:
  - `bulk_patch`: matched count + filter summary, collapsible sample rows (≤10) with before/after, Apply + Reject buttons, status badge.
  - `rule_create` / `rule_update` / `rule_delete`: rule before/after diff, would-affect-existing count, Apply + Reject.
  - `transaction_edit`: single-row diff, Apply + Reject.
- Composer at bottom: textarea + send (Cmd-Enter). Send disabled mid-turn. Cancel button while streaming.
- Empty state: a few seeded prompts.

Route added to `frontend/src/App.tsx`; nav item in existing sidebar.

## Error handling

- OpenAI errors: surfaced as `error` SSE events; assistant message recorded with `content_text="(error: <code>)"` so the conversation history stays coherent.
- Tool errors (e.g., `propose_bulk_patch` exceeding `BULK_PATCH_FILTER_MAX`): returned as the tool's result so the model can react ("that's too broad — try filtering by date").
- Apply errors:
  - Proposal not pending → `409 { error: "not_pending", status }`.
  - Proposal expired → `409 { error: "expired" }`.
  - Count drift > threshold → `409 { error: "count_drifted", preview_count, current_count }`.
  - DB transaction failure → `500`; status stays `"pending"` so retry is safe.
- Network drop mid-stream: UI shows "connection lost — retry" button that re-issues the same request (the thread state on the server is the source of truth; partial assistant text from before the drop is discarded if `assistant_done` never arrived).

## Testing

**Backend unit (`cashflow-backend` vitest):**
- Each `propose_*` builds the correct preview from a fixture DB.
- `apply_proposal`: idempotency (second apply → 409), drift detection at 20% threshold, transaction rollback on partial failure, status transitions (pending → applied / rejected / expired).
- Date-scoped rule selection at import time: ties broken by priority then id; `effective_to` is exclusive; null endpoints mean open-ended.
- System prompt builder produces stable output given fixture user/household.

**Backend integration:**
- `POST /api/chat/threads/:id/messages` with a stubbed `OpenAIClient` that returns a scripted sequence of tool calls + assistant chunks. Verifies the full server loop: tool dispatch, proposal persistence, SSE event ordering, message-row writes. No real tokens spent.
- Apply / reject HTTP endpoints end-to-end.

**Frontend (vitest):**
- ProposalCard renders each kind correctly.
- Apply click hits the right endpoint and updates status.
- Streaming events update message + card state in the right order.

**Manual smoke:**
- One real OpenAI call exercising the motivating example end-to-end before merging the frontend PR.

## Suggested PR split

1. **Schema + date-scoped rule selection.** Migration adds `effective_from` / `effective_to` to `rules`; creates `chat_threads`, `chat_messages`, `chat_proposals`. Updates rule selection in `backend/src/import/applyRules.ts`. No chat surface yet.
2. **Chat backend.** Routes (`/api/chat/threads`, `/api/chat/threads/:id/messages`, `/api/chat/proposals/:id/apply|reject`), tool-calling loop, tools, OpenAI streaming client, system-prompt builder. Feature-flagged via `CHAT_ENABLED` env var.
3. **Chat frontend.** `/chat` page, components, route + nav item. Flips the flag on in production.

Each PR independently testable and rollback-safe.

## Files (rough — exact list belongs in the plan)

Backend:
- `backend/src/migrations/<timestamp>-chat-and-date-scoped-rules.cjs`
- `backend/src/models/Rule.ts` (modify)
- `backend/src/models/{ChatThread,ChatMessage,ChatProposal}.ts`
- `backend/src/models/index.ts` (register)
- `backend/src/routes/chat.ts`
- `backend/src/ai/chat/{openaiClient,tools,systemPrompt,loop}.ts`
- `backend/src/import/applyRules.ts` (modify rule selection)
- `backend/src/app.ts` (register router)

Frontend:
- `frontend/src/pages/ChatPage.tsx`
- `frontend/src/components/chat/{ThreadList,MessageList,ProposalCard,Composer}.tsx`
- `frontend/src/App.tsx` (route + nav)

Shared:
- `shared/api-types.ts` (chat types)

Tests alongside each new module.
