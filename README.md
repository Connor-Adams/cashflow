# Blackbox

Private telemetry for your life.

Blackbox is a personal dashboard and event recorder that ingests health, activity, finance, calendar, and manual event data, then turns fragmented signals into timelines, daily state summaries, and inspectable insights.

The goal is not another generic dashboard. The goal is to understand what changed, when, and why.

## Core idea

Blackbox acts like a private flight recorder across personal systems:

- Dexcom for glucose
- Cashflow for money state and transactions
- Garmin / HealthKit for activity, sleep, recovery, HRV, and stress
- Calendar for context
- Manual logs for meals, insulin, travel, stress, illness, notes, and anything integrations miss

The main primitive is a timeline, not a widget grid.

## Docs

Start here:

- [Vision](docs/vision.md) — product thesis, principles, MVP scope, data model, and roadmap direction
- [Build Requirements](docs/build-requirements.md) — concrete v0 requirements, screens, domain model, connector behavior, jobs, APIs, test expectations, acceptance criteria, and implementation order

## v0 target

The first useful version should prove the core loop:

1. accept manual timeline events and annotations
2. ingest Cashflow data through a read-only connector
3. ingest Dexcom glucose readings through a connector or mocked connector interface
4. normalize imported data into shared observations and timeline events
5. show a day timeline with overlays
6. generate daily snapshots
7. generate deterministic, inspectable insights from source data

Garmin, HealthKit, mobile, and LLM-generated summaries are future layers, not blockers for v0.

## Recommended stack

```txt
Next.js App Router
TypeScript
Postgres
Drizzle ORM
Tailwind
shadcn/ui
pnpm
```

## Product principles

- Timeline first
- Context beats raw metrics
- Private by default
- Explain deltas, not just states
- Computed insights must be inspectable
- Deterministic insight logic before LLM summaries
- Mock data must make the app useful immediately

## Initial screens

- `/today` — daily state summary
- `/timeline` — main chronological view with overlays
- `/sources` — source connection and sync management
- `/insights` — inspectable insight explorer

## Status

Early planning / scaffold stage.

Implementation should follow [docs/build-requirements.md](docs/build-requirements.md).
