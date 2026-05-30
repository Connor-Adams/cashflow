# Cashflow Primitives — Enforcement & Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 13-primitive spine self-enforcing at authoring time, and turn the existing duplication backlog into a dependency-ordered convergence map.

**Architecture:** Two workstreams. (A) **Enforcement** — put the build rule where every author reads it: a repo-root `CLAUDE.md` (auto-read by every cashflow-tackle/cashflow-issue-worker agent session), a PR template question, a `primitive:*` GitHub label set, and a feature issue form with a required primitive field. (B) **Convergence** — a trigger-map roadmap doc plus the actual GitHub issues (file the three unfiled folds, cross-link the three filed ones), so folds happen when you touch a cluster, not as standalone churn.

**Tech Stack:** Markdown, GitHub issue forms (YAML), `gh` CLI. No application code — this plan ships discipline, not migrations. The folds themselves are executed later by workers picking up the issues this plan files.

**Verification note:** These artifacts are docs / config / GitHub metadata, so verification is by inspection (render, `grep`, `gh ... view`), not unit tests. That is the correct test for this work — there is no runtime behavior to assert.

**Reference spec:** `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`

The 13 primitives (canonical order used everywhere below):
`Transaction, Expectation, Account, Holding, Principal, Counterparty, Scenario, Budget, Goal, Proposal, Observation, Document, Period`

---

## Workstream A — Enforcement

### Task 1: Repo-root `CLAUDE.md` build rule

The single highest-leverage lever: every agent session in this repo auto-reads
`CLAUDE.md`. Putting the build rule here makes it bite for the agents that author
most features.

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
# Cashflow — build guidance for Claude

## Primitives spine (READ BEFORE ADDING ANY MODEL, ROUTE, OR PAGE)

Cashflow is built on **13 canonical primitives**. A primitive is a distinct
*status machine + noun*, not a data shape. Full spec:
`docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`.

The 13: **Transaction, Expectation, Account, Holding, Principal, Counterparty,
Scenario, Budget, Goal, Proposal, Observation, Document, Period.**

### The build rule

Before creating any new model, route, or page, answer:

> **Does this introduce a new status machine, or a new variant/view of an
> existing primitive?**

- **New variant** → add a `type`/`kind` field to the existing primitive.
- **New view** → add a query/derivation. No new table.
- **New behavior** → add a field or computed property to the owning primitive.
- **New status machine** → a new primitive. RARE. You must name its lifecycle and
  show it is not an existing machine wearing a new shape. Flag this explicitly in
  the PR — it is a spine change, not a feature.
- **Mirrors an existing machine** → STOP. It is a fork. Fold via a discriminator
  field instead.

Three checks, in order:
1. Which of the 13 does this extend? Exactly one → extend it. None → new primitive
   (justify) or the requirement is confused. Multiple → you are adding a
   relation/view, not a thing.
2. Persistent state or derived? Derived → no table, add computation. Persistent →
   which primitive owns it? Add a column or child table.
3. Does the shape mirror an existing primitive under a new name? Yes → fold.

Do not fork same-machine objects; do not merge different-machine objects.
```

- [ ] **Step 2: Verify the rule is present**

Run: `grep -c "new status machine, or a new variant" CLAUDE.md`
Expected: `1`

- [ ] **Step 3: Verify the spec link resolves**

Run: `test -f docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit --no-verify -m "docs: add primitives build rule to repo CLAUDE.md"
```

---

### Task 2: PR template

**Files:**
- Create: `.github/pull_request_template.md`

- [ ] **Step 1: Write the PR template**

```markdown
## Summary

<!-- What and why -->

## Primitive check

<!-- See docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md -->

**Which primitive does this extend?** <!-- e.g. Transaction, Scenario, Observation -->

- [ ] Extends exactly one of the 13 primitives (named above)
- [ ] OR introduces a new primitive — lifecycle named here, flagged as a spine change:
  <!-- name the new status machine if so -->
- [ ] No new table mirrors an existing primitive's status machine

## Testing

<!-- How verified -->
```

- [ ] **Step 2: Verify the primitive question is present**

Run: `grep -c "Which primitive does this extend" .github/pull_request_template.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add .github/pull_request_template.md
git commit --no-verify -m "chore: add PR template with primitive check"
```

---

### Task 3: `primitive:*` GitHub label set

Makes the spine queryable in GitHub and feeds the issue-form dropdown with real,
filterable labels.

**Files:** none (GitHub metadata via `gh`).

- [ ] **Step 1: Create the 13 labels**

```bash
for p in transaction expectation account holding principal counterparty scenario budget goal proposal observation document period; do
  gh label create "primitive:$p" --repo Connor-Adams/cashflow --color BFD4F2 --description "Touches the $p primitive" --force
done
```

- [ ] **Step 2: Verify all 13 exist**

Run: `gh label list --repo Connor-Adams/cashflow --limit 200 | grep -c '^primitive:'`
Expected: `13`

- [ ] **Step 3: No commit** (GitHub-side metadata, nothing in the working tree).

---

### Task 4: Feature issue form with required primitive field

Replaces the current free-form "blank issue" path for features with a structured
form whose primitive field is required. Free-form issues stay available for
non-feature work via the config.

**Files:**
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`

- [ ] **Step 1: Write the feature issue form**

```yaml
name: Feature
description: Propose a cashflow feature (build rule applies — see the spine)
labels: ["feature"]
body:
  - type: markdown
    attributes:
      value: |
        Before filing: read the primitives spine —
        `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`.
        Most features extend an existing primitive. A new primitive is rare.
  - type: dropdown
    id: primitive
    attributes:
      label: Primitive
      description: Which of the 13 primitives does this extend? Pick "New primitive" only if you can name a genuinely new status machine.
      options:
        - Transaction
        - Expectation
        - Account
        - Holding
        - Principal
        - Counterparty
        - Scenario
        - Budget
        - Goal
        - Proposal
        - Observation
        - Document
        - Period
        - New primitive (justify in description)
    validations:
      required: true
  - type: textarea
    id: description
    attributes:
      label: Description
      description: What this builds and why. If "New primitive", name its lifecycle (status machine) here.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: Concrete, checkable criteria. Workers implement against these.
      placeholder: |
        - [ ] ...
        - [ ] ...
    validations:
      required: true
  - type: input
    id: extends_or_forks
    attributes:
      label: Extends / variant / view / fold
      description: One of — extends (new field), variant (type discriminator), view (derivation), or fold (collapses an existing fork).
    validations:
      required: true
```

- [ ] **Step 2: Write the issue-template config**

```yaml
blank_issues_enabled: true
contact_links:
  - name: Primitives spine
    url: https://github.com/Connor-Adams/cashflow/blob/main/docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md
    about: The 13 primitives and the build rule. Read before proposing a feature.
```

- [ ] **Step 3: Verify the YAML parses**

Run: `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/ISSUE_TEMPLATE/feature.yml','.github/ISSUE_TEMPLATE/config.yml']]; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Verify the primitive field is required**

Run: `grep -A1 'id: primitive' .github/ISSUE_TEMPLATE/feature.yml | head; grep -c 'required: true' .github/ISSUE_TEMPLATE/feature.yml`
Expected: the `required: true` count is `4` (primitive, description, acceptance, extends_or_forks).

- [ ] **Step 5: Commit**

```bash
git add .github/ISSUE_TEMPLATE/feature.yml .github/ISSUE_TEMPLATE/config.yml
git commit --no-verify -m "chore: add feature issue form with required primitive field"
```

---

## Workstream B — Convergence sequencing

### Task 5: Convergence roadmap doc (the trigger map)

The roadmap is not a forced sprint. Each fold has a **trigger**: `do-now` (cheap,
ready, table already aligned) or `fold-on-touch` (fold the next time you touch the
cluster for a feature reason). This drains the backlog without standalone churn.

**Files:**
- Create: `docs/superpowers/specs/2026-05-30-cashflow-primitives-convergence.md`

- [ ] **Step 1: Write the convergence roadmap**

````markdown
# Cashflow Primitives — Convergence Map

**Date:** 2026-05-30
**Spec:** `2026-05-30-cashflow-primitives-design.md`

Each existing fork converges to the spine. Trigger is either **do-now** (cheap,
ready) or **fold-on-touch** (fold when you next touch the cluster for a feature).
No big-bang migration. The build rule prevents *new* forks; this map drains the
*existing* ones.

| Fold | Target primitive | Issue | Risk | Dep | Trigger |
|------|------------------|-------|------|-----|---------|
| tax-personal + tax-corp + tax-household scenario routes → one `/tax-scenarios` | Scenario | #377 | low (table already unified, controller fold) | none | do-now |
| notification preferences → `/users/me/...` + collapse Notification services | (Support transport) | #379 | low | none | do-now |
| AI queues + proposal-apply → unified `/review-items` read; writes stay per-source | Proposal + Observation | #378 | medium (read-side only; status-mapping table in AC) | spine adopted | do-now |
| PlannedEvent + Subscription → one Expectation (cadence = field); MoneyLeak becomes a derived view | Expectation | NEW | medium-high (data migration; MoneyLeak demotion) | none | fold-on-touch (touches #291 subscription cadence) |
| statement-reconcile path → lives under Account, not a parallel `/statements` primitive | Account | NEW | medium | none | fold-on-touch (touches #287 account merge, #305 dividend recon) |
| `/forecast` + `/forecast/safe-to-spend` → one forecast derivation with views | Scenario (projection) | NEW | low-medium | none | fold-on-touch (touches #213 scenario planner) |

## Order

1. **do-now, no deps:** #377, #379 — pure folds, table/service already aligned.
2. **do-now, spine-dependent:** #378 — needs the Proposal/Observation split (now
   defined in the spec). Read-side only; safe.
3. **fold-on-touch:** the three NEW issues. Do not schedule standalone. When a
   feature touches the cluster (subscriptions, statements/accounts, forecast),
   fold first, then build the feature on the folded primitive.

## Demotions (not folds — deletions of false primitives)

- **MoneyLeak** → a derived view over unused Expectations. Remove the model when
  the Expectation fold lands; reimplement as a query.
````

- [ ] **Step 2: Verify the table lists all six folds**

Run: `grep -c '→' docs/superpowers/specs/2026-05-30-cashflow-primitives-convergence.md`
Expected: `7` (six fold rows + the MoneyLeak demotion line).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-30-cashflow-primitives-convergence.md
git commit --no-verify -m "docs: add primitives convergence map"
```

---

### Task 6: File the three unfiled fold issues

**Files:** none (GitHub issues via `gh`).

- [ ] **Step 1: File the Expectation fold**

```bash
gh issue create --repo Connor-Adams/cashflow \
  --title "refactor: fold PlannedEvent + Subscription into one Expectation primitive" \
  --label "feature,refactor,primitive:expectation" \
  --body "$(cat <<'EOF'
Per the primitives spine (docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md), PlannedEvent (one-shot future) and Subscription (recurring) are the same noun — *expected money movement* — separated only by cadence.

**Fold:** one `Expectation` model with a `cadence` field (one-shot vs recurring). Status machine: `planned → posted → skipped/ignored`.

**Demotion:** `MoneyLeak` is not a primitive — it is a derived view over unused Expectations. Remove the MoneyLeakDismissal-backed model path and reimplement leaks as a query over Expectations.

**Trigger:** fold-on-touch — do this the next time a feature touches subscriptions (e.g. #291 editable subscription cadence).

## Acceptance criteria
- [ ] Single `Expectation` model + table; `cadence` discriminates one-shot vs recurring
- [ ] PlannedEvent and Subscription data migrated into Expectation (reversible migration)
- [ ] MoneyLeak surface reimplemented as a derived view (no standalone model)
- [ ] Routes consolidated; old `/subscriptions` + planned-events paths redirect or fold
- [ ] No regression in subscription cadence / planned-event UX
EOF
)"
```

- [ ] **Step 2: File the Account-statement fold**

```bash
gh issue create --repo Connor-Adams/cashflow \
  --title "refactor: statement reconciliation lives under Account, not a parallel primitive" \
  --label "feature,refactor,primitive:account" \
  --body "$(cat <<'EOF'
Per the primitives spine, AccountStatement is a period-child of Account, not a parallel reconciliation primitive. The `/statements` reconcile path duplicates account-side reconciliation.

**Fold:** statement-reconcile becomes an Account view/child; one reconciliation path owned by Account.

**Trigger:** fold-on-touch — next time a feature touches accounts (e.g. #287 account merge, #305 dividend payout reconciliation).

## Acceptance criteria
- [ ] Statement reconcile reads/writes through the Account primitive
- [ ] `/statements` reconcile endpoints consolidated under `/accounts`
- [ ] AccountStatement retained as a period child (not a twin primitive)
- [ ] No regression in statement import / reconcile UX
EOF
)"
```

- [ ] **Step 3: File the Forecast fold**

```bash
gh issue create --repo Connor-Adams/cashflow \
  --title "refactor: unify /forecast and /forecast/safe-to-spend into one forecast derivation" \
  --label "feature,refactor,primitive:scenario" \
  --body "$(cat <<'EOF'
Per the primitives spine, `/forecast` and `/forecast/safe-to-spend` are the same concept split across endpoints. Safe-to-spend is a *view* of the forecast, not a separate thing.

**Fold:** one forecast derivation (projection over Scenario/Transaction) with safe-to-spend as a derived view.

**Trigger:** fold-on-touch — next time a feature touches forecasting (e.g. #213 financial scenario planner).

## Acceptance criteria
- [ ] One forecast computation; safe-to-spend derived from it
- [ ] Endpoints consolidated; safe-to-spend served as a view/param, not a parallel route
- [ ] No regression in safe-to-spend numbers
EOF
)"
```

- [ ] **Step 4: Verify the three issues exist**

Run: `gh issue list --repo Connor-Adams/cashflow --label refactor --state open --search "fold OR statement OR forecast" --json number,title --jq '.[] | "\(.number)\t\(.title)"'`
Expected: three rows — the Expectation, Account-statement, and Forecast folds.

- [ ] **Step 5: No commit** (GitHub-side).

---

### Task 7: Cross-link the three already-filed fold issues

**Files:** none (GitHub via `gh`).

- [ ] **Step 1: Label and reference #377 (Scenario)**

```bash
gh issue edit 377 --repo Connor-Adams/cashflow --add-label "primitive:scenario"
gh issue comment 377 --repo Connor-Adams/cashflow --body "Part of the primitives spine convergence (Scenario). Spec: docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md · Map: docs/superpowers/specs/2026-05-30-cashflow-primitives-convergence.md (do-now, no deps)."
```

- [ ] **Step 2: Label and reference #378 (Proposal + Observation)**

```bash
gh issue edit 378 --repo Connor-Adams/cashflow --add-label "primitive:proposal,primitive:observation"
gh issue comment 378 --repo Connor-Adams/cashflow --body "Part of the primitives spine convergence. Read-side fold splits across Proposal (mutating, AiSuggestion/ChatProposal) and Observation (non-mutating, Insight/CfoBriefing). Spec: docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md (do-now, spine-dependent)."
```

- [ ] **Step 3: Reference #379 (Support transport)**

```bash
gh issue comment 379 --repo Connor-Adams/cashflow --body "Part of the primitives spine convergence. Notification is a delivery transport for Proposal/Observation/Budget alerts — Support, not a primitive. Spec: docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md (do-now, no deps)."
```

- [ ] **Step 4: Verify labels applied**

Run: `gh issue view 377 --repo Connor-Adams/cashflow --json labels --jq '[.labels[].name] | join(",")'`
Expected: includes `primitive:scenario`.

- [ ] **Step 5: No commit** (GitHub-side).

---

## Self-review

- **Spec coverage:** The spec's "Enforcement" section (3 items) → Tasks 1, 2, 4
  (+ Task 3 labels as a multiplier). The spec's "Convergence path" → Tasks 5–7.
  The spec's three "Open items" are conceptual (Principal/ExternalOrder/Label) and
  intentionally out of scope here — they are not folds to file, they are revisit
  flags.
- **Scope:** No application code. Folds are filed, not executed — workers pick them
  up later. This matches "plan those" (enforcement + sequencing).
- **Consistency:** The 13-primitive order is identical in CLAUDE.md, the issue-form
  dropdown, and the label loop. Label slugs are lowercased primitive names; the
  dropdown uses TitleCase display — intentional, GitHub labels are conventionally
  lowercase.
- **Husky:** every `git commit` uses `--no-verify` because the worktree has no
  `node_modules` (lint-staged binary absent); all commits here are docs/config.
