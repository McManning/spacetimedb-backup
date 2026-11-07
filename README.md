# spacetimedb-backup

Back up and selectively restore every table in a SpacetimeDB TypeScript module, without writing an import reducer per table.

SpacetimeDB can only apply a breaking schema change by deleting the database's data. This package lets you save every table to JSON first, publish the breaking change with `--delete-data`, then restore the tables. Tables you didn't change restore as they are, and you can rewrite rows for the table you did change.

## How it works

- `backupExports()` adds three functions to your module. It finds every table, including tables in mounted submodules, from the schema's own type metadata.
  - `backup_tables`: a procedure that lists table keys (`accessor`, or `namespace.accessor` for submodule tables). Event tables are skipped.
  - `backup_export`: a procedure that returns one page of a table's rows as JSON, limited by size.
  - `backup_import`: a reducer that loads one chunk of rows in a single transaction. It can clear the table first, or only validate the rows without writing.
- The `spacetimedb-backup` CLI calls those functions over HTTP and writes one JSON file per table. Large tables are split into requests of at most `--chunk-size` JSON characters (default 1,000,000) in both directions.
- Restore first validates every chunk of a table against the current schema, then writes. A schema mismatch therefore leaves the table untouched.

Rows are stored as objects keyed by column name. The importer converts them against the **current** schema:

| Schema change | Result |
| --- | --- |
| Column reordered | Nothing to do |
| Column removed | The extra key is ignored |
| Optional column added | Filled with `none` |
| Required column added, column renamed, type changed | The restore fails and names the column (`fro.world[0].layer: missing required value`). Edit the JSON file or use `--transform`. |
| Table removed | The CLI warns and skips the file |

## Install

```sh
npm install spacetimedb-backup
```

`spacetimedb` (>= 2.13) is a peer dependency. The CLI requires Node 22.18 or later.

## Module setup

Export the functions by name from your module entry point:

```ts
import { schema, t } from 'spacetimedb/server';
import { backupExports, ownerIdentityFromEnv } from 'spacetimedb-backup';

const spacetimedb = schema(
  { /* tables and submodules */ },
  { env: { BACKUP_OWNER_IDENTITY: t.string().optional() } }
);

export const { backup_tables, backup_export, backup_import } = backupExports(spacetimedb, {
  authorize: ownerIdentityFromEnv('BACKUP_OWNER_IDENTITY'),
});

export default spacetimedb;
```

These functions can read and overwrite every table, including private ones, so `authorize` is required. `ownerIdentityFromEnv` only allows the identity stored in that environment variable, and rejects every caller when the variable is unset. Set it to the identity printed by `spacetime login show`, for example in `spacetime.json`:

```json
{ "env": { "BACKUP_OWNER_IDENTITY": "c200…1ca8" } }
```

To push the value without republishing, run `spacetime publish --env-only`. You can also pass your own `authorize(caller)` that throws a `SenderError`.

## CLI

Run it from the directory that holds `spacetime.json`. The server and database are read from `spacetime.local.json` / `spacetime.json`, and the token from `spacetime login show --token`. You can override them with `--server`, `--database` and `--token`.

```sh
# Every table into backups/<timestamp>/<table>.json
npx spacetimedb-backup backup

# Only some tables: a namespace or an exact table key, comma separated
npx spacetimedb-backup backup --include fro,im.user --exclude fro.session

# Restore everything in a backup
npx spacetimedb-backup restore --dir backups/2026-11-06T12-00-00-000Z

# Restore only the fro namespace, rewriting rows first
npx spacetimedb-backup restore --dir backups/… --include fro --transform ./migrate.mjs

# Show what would be restored, after transforms, without writing
npx spacetimedb-backup restore --dir backups/… --dry-run
```

Only the tables you select are cleared and reloaded. If one table fails, the CLI still restores the others and exits with status 1.

Lower `--chunk-size` if the server rejects large requests. A row bigger than the chunk size is sent on its own.

### Transforms

A transform file's default export maps table keys to row rewrites. Rows are the backup JSON objects, so 64-bit and larger integers are decimal strings.

```js
// migrate.mjs
export default {
  'fro.world': (row) => ({ ...row, layer: 0 }),                         // new required column
  'watchlist.movie': ({ name, ...row }) => ({ ...row, title: name }),   // renamed column
};
```

Under Node's type stripping (22.18 or later), the transform file can be TypeScript.

## Using it from your own UI

`spacetimedb-backup/transfer` is browser-safe (no `spacetimedb/server` import). It holds the paging, chunking and validate-then-write logic that the CLI uses. Give it a transport built on your SDK connection:

```ts
import { backupTable, restoreTable, type BackupTransport } from 'spacetimedb-backup/transfer';

const transport: BackupTransport = {
  exportPage: (table, offset, maxLength) => conn.procedures.backupExport({ table, offset, maxLength }),
  importChunk: (table, rows, clear, validate) => conn.reducers.backupImport({ table, rows, clear, validate }),
};

const rows = await backupTable(transport, 'fro.world');  // same JSON as the CLI writes
await restoreTable(transport, 'fro.world', rows);
```

The connection's identity must pass your `authorize` check.

## Breaking-change workflow

1. `spacetimedb-backup backup`
2. Change the schema and run `spacetime publish --delete-data`.
3. Edit the JSON for the changed table, or write a transform.
4. `spacetimedb-backup restore --dir backups/<timestamp>`, adding `--include` to restore only part of it.

## Limits

- **Auto-increment.** Inserting explicit values doesn't advance a SpacetimeDB sequence, so `backup_import` draws and discards values from the sequence until it passes the highest restored value. That costs one insert and one delete per unused value. It's cheap for typical IDs, but slow if a table's highest ID is in the millions.
- **Chunked restores are not atomic per table.** Validation catches schema mismatches before anything is written. But if a write fails after the first chunk, for example on a unique-constraint violation, the table is left partly restored. The CLI reports how many rows were written; rerunning the restore clears the table and starts over.
- **Paged backups are not a snapshot.** Each page is read in its own transaction, so back up while nothing is writing to the tables. Otherwise rows could be skipped or duplicated between pages.
- **Row order isn't preserved.** A restored table holds the same rows, but SpacetimeDB may iterate them in a different order.
- **Procedure errors.** An `authorize` rejection inside a procedure is reported as an HTTP 500 "fatal error", not as a clean sender error.

## License

MIT
