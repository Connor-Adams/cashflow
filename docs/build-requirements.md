# Blackbox Build Requirements

This document defines the concrete build requirements for Blackbox v0.

Blackbox is a private personal telemetry system. The first version should prove the core loop: ingest fragmented personal data, normalize it into timestamped observations and events, display it on a timeline, and generate inspectable daily summaries and insights.

## v0 goal

Build a usable local/dev-first web app that can:

1. accept manual timeline events and annotations
2. ingest Cashflow data through a read-only connector
3. ingest Dexcom glucose readings through a connector or mocked connector interface
4. normalize imported data into a shared event/observation model
5. show a day timeline with overlays
6. generate daily snapshots
7. generate deterministic, inspectable insights from source data

The v0 should be useful before Garmin, HealthKit, mobile, or LLM features are added.

## Non-negotiable product requirements

### 1. Timeline-first UX

The main interface must be a timeline.

Required timeline behavior:

- day view as the default
- ability to change selected date
- chronological events
- glucose overlay when available
- source badges on every event
- ability to inspect raw details for each event
- ability to add manual annotations to a time window

The app should not start as a generic widget dashboard.

### 2. Source attribution

Every normalized object must preserve its origin.

Required fields on normalized records:

- source key
- source record ID where available
- import batch ID where available
- observed/occurred timestamp
- raw event reference

The user should be able to answer: "Where did this value come from?"

### 3. Append-only raw imports

Imported payloads must be preserved before normalization.

Requirements:

- raw source payloads are stored unchanged
- normalization is replayable
- imported records are idempotent
- duplicate imports must not create duplicate timeline events or observations

### 4. Deterministic insights first

Do not start with LLM-generated insight logic.

v0 insights should be computed with deterministic rules so they are testable, explainable, and debuggable.

Examples:

- glucose variability above personal baseline
- missing manual context around a spike/drop
- unusually high spend day
- unusually high transaction count
- schedule-heavy day if calendar is added
- low activity day if activity source is later added

### 5. Private by default

Blackbox will handle sensitive health and finance data.

Requirements:

- no external AI calls in v0
- no telemetry/analytics services in v0 unless explicitly added later
- secrets must stay in environment variables
- local development must work without production credentials
- mocked connector data must be supported
- source data deletion should be possible by source connection

## Recommended stack

Use this unless there is a strong reason not to:

```txt
Next.js App Router
TypeScript
Postgres
Drizzle ORM
Tailwind
shadcn/ui
pnpm
Turborepo-style package layout if/when packages become useful
```

Initial repo can be simple. Do not overbuild the monorepo before the app exists.

Recommended initial structure:

```txt
blackbox/
  apps/
    web/
      app/
      components/
      lib/
      server/
  packages/
    db/
    domain/
    connectors/
  docs/
    vision.md
    build-requirements.md
```

Acceptable simpler v0 structure:

```txt
blackbox/
  app/
  components/
  lib/
    db/
    domain/
    connectors/
  docs/
```

Prefer momentum over architecture purity.

## Core domain model

### SourceConnection

Represents a configured data source.

Required fields:

- id
- userId
- sourceType
- displayName
- status
- createdAt
- updatedAt
- lastSyncAt
- metadata

Initial source types:

```ts
"manual" | "cashflow" | "dexcom" | "calendar" | "garmin" | "healthkit"
```

Only `manual`, `cashflow`, and `dexcom` are required for v0.

### ImportBatch

Represents a sync/import run.

Required fields:

- id
- sourceConnectionId
- status
- startedAt
- completedAt
- recordsFound
- recordsCreated
- recordsUpdated
- error
- metadata

### RawEvent

Stores untouched source payloads.

Required fields:

- id
- sourceConnectionId
- importBatchId
- sourceType
- sourceRecordId
- occurredAt
- receivedAt
- payload
- payloadHash

Uniqueness requirement:

```txt
sourceConnectionId + sourceRecordId
```

Fallback uniqueness when sourceRecordId is unavailable:

```txt
sourceConnectionId + payloadHash
```

### Observation

Normalized time-series metric.

Required fields:

- id
- userId
- rawEventId
- sourceType
- metric
- value
- unit
- observedAt
- metadata

Initial metrics:

```ts
"glucose" | "cash_balance" | "daily_spend" | "transaction_amount"
```

Future metrics:

```ts
"heart_rate" | "hrv" | "stress" | "steps" | "sleep_duration" | "body_battery"
```

### TimelineEvent

Meaningful event on the user timeline.

Required fields:

- id
- userId
- rawEventId nullable
- sourceType
- eventType
- title
- description nullable
- startedAt
- endedAt nullable
- metadata

Initial event types:

```ts
"manual_note" | "meal" | "insulin" | "glucose_event" | "transaction" | "cashflow_summary"
```

Future event types:

```ts
"sleep" | "workout" | "calendar_block" | "travel" | "stress_event"
```

### DailySnapshot

Computed daily rollup.

Required fields:

- id
- userId
- date
- timezone
- summaryJson
- createdAt
- updatedAt

Initial snapshot fields:

```ts
{
  glucose?: {
    readingCount: number
    average: number
    min: number
    max: number
    variability: number
    estimatedTimeInRange?: number
  }
  finance?: {
    spendTotal: number
    transactionCount: number
    largestTransaction?: number
  }
  annotations?: {
    count: number
    types: Record<string, number>
  }
}
```

### Insight

Computed finding with evidence.

Required fields:

- id
- userId
- date nullable
- timeRangeStart
- timeRangeEnd
- insightType
- severity
- title
- summary
- evidenceJson
- sourceObservationIds
- sourceTimelineEventIds
- status
- createdAt

Status values:

```ts
"active" | "dismissed" | "archived"
```

## Required screens

### `/`

Redirect to `/today`.

### `/today`

Daily state summary.

Required sections:

- selected date
- state cards for glucose, finance, annotations, and insights
- link to full timeline
- list of top insights for selected date

### `/timeline`

Main timeline UI.

Required features:

- date picker
- chronological event list
- glucose chart/strip if glucose observations exist
- manual annotation creation
- event detail drawer or modal
- source filters

### `/sources`

Source connection management.

Required features:

- list configured sources
- source status
- last sync time
- manual sync trigger for supported sources
- mocked data import actions for development

### `/insights`

Insight explorer.

Required features:

- list insights by date
- filter by type/severity/source
- inspect evidence
- dismiss insight

## Required connector behavior

### Manual connector

Manual entry must work before external integrations.

Required manual annotation types:

- note
- meal
- insulin
- exercise
- sick
- travel
- stress
- caffeine
- alcohol
- medication

Required fields:

- type
- title
- timestamp
- optional end time
- optional notes
- optional metadata

### Cashflow connector

Cashflow should be consumed read-only.

Blackbox should support a connector interface that can pull:

- account summaries
- daily/monthly cashflow summary
- recent transactions
- finance-related events

Expected endpoint shape from Cashflow:

```txt
GET /api/blackbox/summary
GET /api/blackbox/accounts
GET /api/blackbox/cashflow/monthly
GET /api/blackbox/transactions/recent
GET /api/blackbox/events
```

For v0, mocked Cashflow data is acceptable until Cashflow exposes the endpoints.

### Dexcom connector

Dexcom should normalize glucose readings into observations.

Required normalized fields:

- glucose value
- unit
- timestamp
- trend direction if available
- trend rate if available
- source reading ID if available

For v0, use a connector interface that supports both real OAuth-backed sync later and mocked local JSON now.

Do not hard-code Dexcom as a special path in the UI. Treat it as a source that emits observations.

## Jobs and sync requirements

Required jobs:

- import source data
- normalize raw events
- compute daily snapshots
- compute deterministic insights

Each job should be safe to retry.

Minimum idempotency requirements:

- repeated imports do not duplicate raw events
- repeated normalization does not duplicate observations/events
- repeated snapshot computation replaces or upserts the same daily snapshot
- repeated insight computation upserts or deduplicates equivalent insights

## API requirements

Internal app APIs should expose:

```txt
GET /api/today?date=YYYY-MM-DD
GET /api/timeline?date=YYYY-MM-DD
GET /api/observations?metric=glucose&start=...&end=...
GET /api/insights?start=...&end=...
POST /api/annotations
POST /api/sources/:id/sync
POST /api/jobs/daily-snapshot
POST /api/jobs/insights
```

Exact routes can change with framework conventions, but these capabilities must exist.

## UI requirements

Design target:

- dense
- calm
- premium
- diagnostic
- not wellness-cringe
- not gamified

Visual priorities:

- timeline clarity
- compact cards
- source badges
- evidence drilldowns
- minimal empty states
- useful mock data

Empty states should tell the user what to connect or log next.

## Testing requirements

At minimum, add tests for:

- normalization idempotency
- glucose snapshot computation
- finance snapshot computation
- deterministic insight rules
- manual annotation creation
- timeline ordering

Use lightweight tests first. Do not block v0 on perfect coverage.

## Seed/mock data requirements

The app must include mock data so the UI is useful immediately.

Required mock data:

- one normal glucose day
- one volatile glucose day
- one day with manual meal/insulin/stress notes
- one finance-normal day
- one unusual-spend day
- at least five generated insights

Mock data should exercise the timeline, today view, and insights view.

## Environment requirements

Required environment variables should be documented in `.env.example`.

Initial examples:

```txt
DATABASE_URL=
BLACKBOX_APP_URL=http://localhost:3000
CASHFLOW_API_BASE_URL=
CASHFLOW_API_TOKEN=
DEXCOM_CLIENT_ID=
DEXCOM_CLIENT_SECRET=
DEXCOM_REDIRECT_URI=
```

External credentials must be optional in local development if mock mode is enabled.

## Acceptance criteria for v0

v0 is complete when:

- the app runs locally from a fresh clone
- database migrations apply cleanly
- mock data can be seeded
- `/today` shows a useful daily summary
- `/timeline` shows manual events, transactions, and glucose readings together
- manual annotations can be created
- source records preserve raw imported payloads
- daily snapshots can be computed
- insights can be computed and inspected
- source attribution is visible
- repeated imports/snapshot/insight jobs are idempotent
- README explains setup

## Suggested implementation order

1. Scaffold app and database
2. Add core schema and migrations
3. Add mock data seed
4. Build timeline event model
5. Build `/timeline`
6. Build manual annotations
7. Build observations and glucose mock data
8. Build `/today`
9. Build daily snapshot job
10. Build deterministic insight rules
11. Build `/insights`
12. Add source management page
13. Add Cashflow connector interface
14. Add Dexcom connector interface
15. Polish README and `.env.example`

## Hard constraints

- Do not build a generic dashboard first
- Do not make Garmin a blocker
- Do not make LLMs required for v0
- Do not mix raw source payloads with normalized domain records
- Do not create duplicate records on repeated imports
- Do not hide evidence behind unexplained summaries
- Do not ship without mock data

## Future roadmap

After v0:

- real Dexcom OAuth
- Cashflow production connector
- Garmin integration
- HealthKit bridge
- calendar integration
- local-first/mobile annotation capture
- advanced correlation explorer
- LLM summaries grounded in deterministic findings
- encrypted health-data storage
- export/delete controls
