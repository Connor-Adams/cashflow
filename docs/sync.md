# Self-hosted encrypted sync foundation

> Cashflow #239 — V1 backup/restore. Future cloud-sync work plugs into the
> extension points described below.

## Product model

Cashflow is self-hosted: the database lives on a single server you control
(Dokploy-hosted Postgres in the reference deploy), and the user trusts that
one server. The "sync" surface lets a
user (1) take an encrypted snapshot of their finance data and (2) restore
it on a fresh install or a different household. Encryption happens
server-side using a passphrase the user supplies on each request — the
passphrase never sits on the server between requests, and the bundle
bytes never reach a disk on the server.

V1 is a foundation. It deliberately stops short of multi-device
continuous sync. Everything below sketches how that future work slots
into the V1 module layout.

## On-the-wire format

A bundle is a base64-encoded binary envelope:

```
| 1 byte   | 16 bytes | 12 bytes | 16 bytes | variable        |
| version  | salt     | iv       | gcm tag  | gzip(JSON body) |
```

- **version** — 0x01. Bumps when the *binary envelope* changes (e.g.
  KDF swap, salt size, algorithm change). Servers refuse unknown
  versions.
- **salt** — random per bundle. Stretched with PBKDF2-SHA256 (200k
  iterations) into a 32-byte AES-256-GCM key.
- **iv** — random per bundle.
- **tag** — AES-GCM authentication tag. Wrong passphrase, tampered
  bundle, or wrong envelope version all surface as a tag-verification
  failure on decrypt.
- **body** — gzip-compressed JSON. The JSON top-level shape is

```jsonc
{
  "schemaVersion": 1,              // bumps when the table set or row shape changes
  "createdAt": "2026-05-26T...",   // ISO timestamp
  "origin": "cashflow/0.0.0",      // package version that wrote it
  "sourceHouseholdId": 42,         // source household, for forensics
  "tables": {
    "contacts":   [ /* rows */ ],
    "categories": [ /* rows */ ],
    "accounts":   [ /* rows */ ],
    "rules":      [ /* rows */ ],
    "transactions": [ /* rows */ ]
  }
}
```

Two version axes exist on purpose:
- `version` (envelope) → rotate for crypto/format changes.
- `schemaVersion` (payload) → rotate for table-set / column changes.

Restore refuses a `schemaVersion` higher than the running code.

## API surface

All endpoints require auth and are rate-limited with `aiSuggestLimiter`.
The active household is taken from the session — there's no
household-id parameter.

| Method | Path                       | Purpose                                       |
|--------|----------------------------|-----------------------------------------------|
| POST   | `/api/sync/backup`         | Encrypt the active household's rows.          |
| POST   | `/api/sync/restore/preview`| Decrypt and report counts without writing.    |
| POST   | `/api/sync/restore`        | Apply bundle to the active household.         |
| GET    | `/api/sync/history`        | List past backup + restore events.            |

Restore is **merge-only**: it refuses if the target household already
has rows in any V1 table, so a bundle can only be restored into an empty
household (e.g. a fresh install). `mode` is optional; the only accepted
value is `'merge'`. Any other value is rejected with `400`.

There used to be a **Replace** mode that wiped the V1 tables for the
household before inserting. It was removed, and `mode: 'replace'` now
returns `400` so an old client cannot trigger it. Deleting `transactions`
(and `accounts`, `categories`, ...) `ON DELETE CASCADE`s into receipts,
`transaction_order_links`, `transaction_labels`, purchases,
reimbursements, tax/return metadata, budget exclusions, signals, AI
suggestions, large-purchase reviews and revisions, and wiping accounts
cascades into investment activity and holdings snapshots. None of those
are in the bundle, so a replace destroyed data it could never restore.

## V1 table set

Defined in `backend/src/sync/tables.ts`. Order matters for restore —
parents come before children so foreign-key references can be remapped
on the fly during a single pass.

```
contacts → categories → accounts → rules → transactions
```

Tables explicitly **out of scope** for V1:
- receipts (blobs and metadata — restore would require object storage)
- AI suggestions / chat / inboxes (ephemeral)
- portfolio snapshots / forecasts (derivable)
- audit log (intentionally not portable)
- jobs / job_runs / notifications / sessions

Add new tables by appending to `TABLES` and bumping `BUNDLE_SCHEMA_VERSION`.

## Foreign-key remapping

Primary keys are remapped on restore — the bundle's `id` collides with
target-DB autoincrement values, so the target DB picks fresh ids and the
restore code rewrites references column-by-column. The remap is driven
by `FK_REMAP` in `restoreBundle.ts`. A reference whose target was not in
the bundle is NULLed rather than left dangling.

Self-referencing FK columns (`transactions.linked_transaction_id`, which
pairs transfer legs and charge/refund) are listed in `SELF_REF_REMAP` and
restored in two passes: each row is inserted with the column NULL, then,
once the whole table is written, the column is UPDATEd to the target's
new id from the id-remap — inside the same restore transaction. A link
whose target was not in the bundle stays NULL.

## Extension points for cloud sync

The V1 codec is the same primitive a continuous cloud-sync flow would
use:

1. **Delta-only bundles** — `BundlePayload.tables` already keys by table
   name. A future sync engine can ship a per-row HMAC alongside each
   row and let the receiver merge by row id instead of refusing. This is
   where the next `schemaVersion` rotation lands.
2. **Server-side blob store** — once `receipts` enter the bundle, the
   row metadata + the binary itself can live in S3-compatible storage
   addressed by the row's `stored_filename`. The bundle codec doesn't
   need to change; only `tables.ts` grows.
3. **Multi-device identity** — `sync_backups` already records bundle
   metadata per (household, user, kind, created_at). A future cloud
   agent records a `kind: 'cloud_sync_push'` row with `user_id = NULL`
   to flag automated work.
4. **Conflict resolution** — V1 takes a hard line: restore refuses any
   non-empty household and never deletes. The cloud-sync follow-up will
   need a per-row conflict policy (last-write-wins keyed by `updated_at`, or
   user-supplied "keep mine / take theirs"). Where this lands: a new
   `applyMerge()` function alongside `restoreBundle()` in
   `backend/src/sync/`.

## Test plan

- `backend/src/sync/syncBundleFormat.test.ts` — codec round-trip, tamper,
  wrong-passphrase, version, schemaVersion checks.
- `backend/src/migrations/__tests__/syncBackupsMigration.test.ts` — schema +
  index + down-migration.
- `backend/src/routes/sync.restoreMode.test.ts` — restore is merge-only:
  `mode=replace` and unknown modes are 400 and write nothing; merge into
  an empty household succeeds.
- `backend/src/sync/restoreBundleTransactionLinks.test.ts` — transfer /
  refund links are remapped to the restored rows' new ids.
- `backend/test/integration/sync.test.ts` — end-to-end via the API:
  encrypt → preview → restore, merge-refuses, replace-rejected,
  cross-household isolation, history listing, 401 on unauthenticated.

## Security caveats

- The bundle leaves the server unencrypted-at-rest *only* in the user's
  download. We do not persist bundle bytes server-side.
- PBKDF2-SHA256 at 200k iterations is the OWASP-2023 baseline. A future
  rotation to Argon2id would bump the envelope `version` byte.
- The user is also the threat model on a self-hosted product. We refuse
  passphrases shorter than 8 chars to catch UI bugs, but we do not
  enforce stronger requirements — a determined user choosing
  "password1234" is their own problem.
- Restore happens inside a single Sequelize transaction. A failed
  restore rolls back cleanly with no partial state.
