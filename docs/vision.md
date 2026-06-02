# Blackbox Vision

Blackbox is a private personal telemetry system.

It ingests health, activity, finance, calendar, and manual event data, then turns fragmented signals into timelines, correlations, and daily state summaries.

The goal is not another dashboard. The goal is to understand what changed, when, and why.

## Product thesis

Modern life creates useful data everywhere, but the data lives in isolated silos:

- glucose in Dexcom
- recovery, sleep, activity, HRV, stress, and training data in Garmin / HealthKit
- cash position and spending patterns in Cashflow
- context in calendars, notes, and manual logs

Blackbox should be the private flight recorder across those systems.

It should answer questions like:

- What was happening around my worst glucose volatility days?
- What patterns show up before I feel cooked?
- How do sleep, activity, stress, calendar load, and food timing affect glucose?
- When do spending spikes line up with low recovery, high stress, or schedule chaos?
- What changed this week compared with my normal baseline?

## North star

Blackbox is the private flight recorder for your life, optimized for finding patterns you would otherwise miss.

## Product principles

### 1. Timeline first

The primitive is not a chart. The primitive is a timestamped life event.

Every observation, event, and insight should be mappable onto a timeline.

Examples:

- glucose reading
- sleep window
- workout
- walk
- calendar block
- transaction
- meal
- insulin/manual health note
- stress spike
- travel day
- unusual cash movement

### 2. Context beats raw metrics

A metric by itself is rarely useful.

Bad:

> Your average glucose was 7.1 mmol/L.

Better:

> Your highest glucose variability this week happened after short sleep, no morning walk, and a late meal.

Bad:

> You spent $430 on restaurants.

Better:

> Dining spend spiked on high-calendar-load days and low-recovery days.

### 3. Private by default

This is a personal system of record.

Blackbox should assume sensitive data and treat privacy, local control, auditability, and exportability as first-class product requirements.

Default posture:

- read-only integrations where possible
- append-only raw imports
- clear source attribution
- no silent mutation of source systems
- easy data deletion
- easy raw export
- no external AI calls without explicit configuration

### 4. Explain deltas, not just states

The product should focus on changes:

- What is different today?
- What changed this week?
- What broke my baseline?
- What preceded the anomaly?
- What should I look at first?

### 5. Computed insight must be inspectable

Every insight should link back to the underlying observations and events.

If Blackbox says a glucose spike followed poor sleep and a late meal, the user should be able to click into the relevant readings, sleep window, timeline events, and assumptions.

## MVP

The first useful version should be small and sharp.

### MVP sources

1. Manual logs
2. Cashflow read-only connector
3. Dexcom connector
4. Calendar connector if low-friction
5. Garmin / HealthKit later, not as a blocker

Garmin is valuable, but it should not block the product. Dexcom plus manual events plus Cashflow is enough to prove the core timeline and insight model.

### MVP screens

#### 1. Today

A compact state summary for the current day.

Possible state vector:

```txt
Glucose: stable / volatile / risky / unknown
Recovery: rested / cooked / unknown
Activity: inactive / active / overreached / unknown
Money: normal / watch / unusual / unknown
Schedule: calm / loaded / chaos / unknown
```

This should not become a wall of widgets. It should feel like an executive summary.

#### 2. Timeline

The main product surface.

A single chronological view with overlays:

- glucose
- meals/manual notes
- activity
- sleep/recovery
- calendar blocks
- transactions
- anomalies
- generated insights

Example timeline:

```txt
00:00 - sleep
07:30 - wake
08:15 - glucose rise
09:00 - coffee / breakfast
11:30 - work block
13:00 - walk
15:40 - glucose drop
18:00 - workout
22:30 - late spike
```

#### 3. Insights

Plain-English findings grounded in the user's own data.

Examples:

```txt
Your biggest glucose volatility this week happened after:
- sleep under 6h
- no morning walk
- high calendar load
- late meal
```

```txt
Your best recovery days had:
- 7.5h+ sleep
- activity before 3pm
- fewer late-night glucose swings
```

The tone should be diagnostic, not motivational. Blackbox is a debugging tool, not a coach.

## Data model

The system should preserve raw source data and derive normalized observations from it.

### Core concepts

```txt
SourceConnection
RawEvent
Observation
TimelineEvent
DailySnapshot
Insight
Annotation
```

### SourceConnection

Represents an authenticated or configured data source.

Examples:

- Dexcom
- Cashflow
- Garmin
- Apple HealthKit
- Google Calendar
- Manual

### RawEvent

Append-only imported payload from a source.

Purpose:

- preserve source truth
- make imports replayable
- make normalization debuggable
- allow future reprocessing when schemas improve

### Observation

A normalized time-series measurement.

Example:

```ts
{
  id: string
  source: "dexcom"
  metric: "glucose"
  value: 6.4
  unit: "mmol/L"
  observedAt: Date
  metadata: {
    trend: "flat",
    trendRate: 0.1
  }
}
```

Possible metrics:

- glucose
- heart_rate
- hrv
- stress
- steps
- sleep_score
- body_battery
- cash_balance
- daily_spend

### TimelineEvent

A meaningful event with a start and optional end time.

Example:

```ts
{
  id: string
  type: "workout" | "meal" | "sleep" | "calendar" | "transaction" | "manual"
  title: string
  startedAt: Date
  endedAt?: Date
  source: "garmin" | "cashflow" | "manual" | "calendar"
  metadata: Record<string, unknown>
}
```

### DailySnapshot

A rollup of the user's day.

Example fields:

- glucose average
- glucose variability
- time in range
- sleep duration
- resting heart rate
- HRV
- stress average
- steps
- workout load
- spend total
- transaction count
- calendar load
- number of anomalies

### Insight

A generated or computed finding.

Insights should include:

- title
- summary
- confidence
- time range
- source event IDs
- source observation IDs
- explanation
- createdAt
- dismissedAt

### Annotation

Manual user-provided context.

Examples:

- meal
- insulin
- sick
- travel
- bad sleep
- stressful event
- alcohol
- caffeine
- medication
- note

Annotations are critical because integrations will never capture everything.

## Architecture direction

Recommended initial stack:

```txt
Next.js
TypeScript
Postgres
Drizzle
Tailwind
shadcn/ui
Recharts or ECharts
Inngest or Trigger.dev
```

Recommended repo structure:

```txt
blackbox/
  apps/
    web/
  packages/
    db/
    connectors/
      cashflow/
      dexcom/
      garmin/
      healthkit/
    domain/
    ui/
  scripts/
  docs/
    vision.md
    data-model.md
    integrations.md
```

## Integration strategy

### Cashflow

Cashflow should expose read-only endpoints for Blackbox.

Potential endpoints:

```txt
GET /api/blackbox/summary
GET /api/blackbox/accounts
GET /api/blackbox/cashflow/monthly
GET /api/blackbox/transactions/recent
GET /api/blackbox/events
```

Blackbox should not own finance logic. It should consume Cashflow as a source.

### Dexcom

Dexcom should be the first external health source.

Initial data needed:

- estimated glucose values
- trend direction
- trend rate if available
- timestamp
- unit conversion support

Use Dexcom to prove:

- time-series ingestion
- timeline overlay
- anomaly detection
- manual context around glucose events

### Garmin / HealthKit

Garmin and/or HealthKit should eventually provide:

- sleep
- HRV
- resting heart rate
- stress
- steps
- workouts
- body battery / recovery signals

Do not make this the first blocker. The product can be useful before Garmin is complete.

### Calendar

Calendar data is valuable because it explains context.

Useful derived metrics:

- meeting load
- focus time
- late events
- travel days
- schedule fragmentation
- high-context-switch days

## Insight engine

Start deterministic before adding LLMs.

### Phase 1: Rules and thresholds

Examples:

- glucose volatility above personal baseline
- unusually high restaurant spend
- sleep below personal baseline
- inactive day after poor sleep
- high calendar load correlated with glucose instability

### Phase 2: Correlation explorer

Look for repeated patterns across days.

Examples:

- low sleep + late meal -> higher glucose variability
- morning walk -> improved glucose stability
- high calendar load -> higher spend
- poor recovery -> lower activity

### Phase 3: LLM summaries

Use an LLM to summarize already-computed findings, not to invent them.

LLM output should be grounded in:

- source observations
- source events
- computed metrics
- clear time windows

## Non-goals for v0

- social features
- coaching persona
- habit gamification
- complicated wearable integrations before the timeline works
- replacing Cashflow
- replacing Dexcom, Garmin, or HealthKit
- production healthcare claims
- medical advice

## Open questions

- Should Blackbox be local-first?
- Should health data live in a separate encrypted schema?
- Should manual annotations be ultra-fast via command palette?
- Should the timeline be day-first, week-first, or infinite-scroll?
- Should insights be stored forever or regenerated from source data?
- Should Cashflow push events to Blackbox or should Blackbox pull from Cashflow?
- Should mobile be required early for manual logging?

## Success criteria

Blackbox is working when it can reliably answer:

- What happened today?
- What changed this week?
- What events surrounded this anomaly?
- What pattern keeps repeating?
- What should I inspect first?

The product is great when it feels less like a dashboard and more like a debugger for your life.
