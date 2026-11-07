import { Identity, type AlgebraicType, type ProductType } from 'spacetimedb';
import { SenderError, t, type Schema } from 'spacetimedb/server';
import { reviveValue, stringifyRow, type Typespace } from './json.ts';

/** The caller fields an authorization check may inspect. */
export type BackupCaller = {
  sender: Identity;
  env: { get(key: string): string | null };
};

export type BackupOptions = {
  /** Throw a `SenderError` to reject the caller. Called before every backup function. */
  authorize: (caller: BackupCaller) => void;
};

type TableHandle = {
  iter(): Iterable<Record<string, unknown>>;
  insert(row: Record<string, unknown>): Record<string, unknown>;
  delete(row: Record<string, unknown>): boolean;
  clear(): bigint;
};

type TableDefinition = {
  accessorName: string;
  rowType: ProductType;
  isEvent?: boolean;
  tableDef: { sequences: { column: number }[] };
};

type SubmoduleInfo = {
  namespace: string;
  schemaTables: Record<string, TableDefinition>;
  typespace: Typespace;
  subDispatches: SubmoduleInfo[];
};

type BackupTable = {
  key: string;
  path: string[];
  definition: TableDefinition;
  typespace: Typespace;
};

const BIG_INTEGER_TAGS = new Set([
  'I64',
  'U64',
  'I128',
  'U128',
  'I256',
  'U256',
]);

/**
 * Every persistent table in the schema, including tables of mounted submodules.
 * Root tables are keyed by accessor name, submodule tables by `namespace.accessor`.
 */
function collectTables(schema: Schema<any>): BackupTable[] {
  const tables: BackupTable[] = [];
  const add = (
    prefix: string[],
    definitions: Record<string, TableDefinition>,
    typespace: Typespace
  ) => {
    for (const definition of Object.values(definitions)) {
      if (definition.isEvent) {
        continue;
      }
      const path = [...prefix, definition.accessorName];
      tables.push({ key: path.join('.'), path, definition, typespace });
    }
  };
  const visit = (prefix: string[], submodules: SubmoduleInfo[]) => {
    for (const submodule of submodules) {
      const namespace = [...prefix, submodule.namespace];
      add(namespace, submodule.schemaTables, submodule.typespace);
      visit(namespace, submodule.subDispatches);
    }
  };
  add(
    [],
    schema.schemaType.tables as Record<string, TableDefinition>,
    schema.typespace as Typespace
  );
  visit([], schema.submoduleDispatchInfos as unknown as SubmoduleInfo[]);
  return tables;
}

/**
 * Create the backup procedures and restore reducer for a module. Export the
 * returned functions by name from the module entry point:
 *
 * ```ts
 * export const { backup_tables, backup_export, backup_import } =
 *   backupExports(schema, { authorize: ownerIdentityFromEnv('BACKUP_OWNER_IDENTITY') });
 * ```
 */
export function backupExports(
  schema: Schema<any>,
  { authorize }: BackupOptions
) {
  const tables = collectTables(schema);

  const find = (key: string) => {
    const table = tables.find((candidate) => candidate.key === key);
    if (!table) {
      throw new SenderError(`Unknown table "${key}"`);
    }
    return table;
  };

  const handleOf = (db: unknown, table: BackupTable) =>
    table.path.reduce((node: any, segment) => node[segment], db) as TableHandle;

  const backup_tables = schema.procedure(t.array(t.string()), (ctx) => {
    authorize(ctx);
    return tables.map((table) => table.key);
  });

  /**
   * One page of rows as a JSON array, starting at row `offset` in iteration order.
   * A page stops once its JSON passes `maxLength` characters (always at least one
   * row). An empty array means there are no more rows.
   */
  const backup_export = schema.procedure(
    { table: t.string(), offset: t.u32(), maxLength: t.u32() },
    t.string(),
    (ctx, { table, offset, maxLength }) => {
      authorize(ctx);
      const target = find(table);
      return ctx.withTx((tx) => {
        const page: string[] = [];
        let length = 0;
        let index = 0;
        for (const row of handleOf(tx.db, target).iter()) {
          if (index++ < offset) {
            continue;
          }
          const json = stringifyRow(row);
          if (page.length > 0 && length + json.length + 2 > maxLength) {
            break;
          }
          page.push(json);
          length += json.length + 1;
        }
        return `[${page.join(',')}]`;
      });
    }
  );

  /**
   * Restore one chunk of a table's rows in a single transaction. `clear` empties
   * the table first (send it with the first chunk). `validate` checks the rows
   * against the current schema and writes nothing.
   */
  const backup_import = schema.reducer(
    {
      table: t.string(),
      rows: t.string(),
      clear: t.bool(),
      validate: t.bool(),
    },
    (ctx, { table, rows, clear, validate }) => {
      authorize(ctx);
      const target = find(table);
      const rowType: AlgebraicType = {
        tag: 'Product',
        value: target.definition.rowType,
      };

      let revived: Record<string, unknown>[];
      try {
        const parsed: unknown = JSON.parse(rows);
        if (!Array.isArray(parsed)) {
          throw new Error('expected a JSON array of rows');
        }
        revived = parsed.map(
          (row, i) =>
            reviveValue(
              row,
              rowType,
              target.typespace,
              `${table}[${i}]`
            ) as Record<string, unknown>
        );
      } catch (error) {
        throw new SenderError(
          `${table}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (validate) {
        return;
      }

      const handle = handleOf(ctx.db, target);
      if (clear) {
        handle.clear();
      }

      // Explicit auto-increment values do not advance the sequence, so later inserts
      // would collide with restored keys. Draw from the sequence until it passes them.
      // Safe across chunks: the sequence only grows, so it is already past every
      // earlier chunk's keys and a throwaway row can never hit a restored key.
      // shortcut: O(maxId) throwaway inserts, upgrade if SpacetimeDB exposes a way to set a sequence.
      for (const { column } of target.definition.tableDef.sequences) {
        if (revived.length === 0) {
          break;
        }
        const element = target.definition.rowType.elements[column];
        const name = element.name!;
        const zero = BIG_INTEGER_TAGS.has(element.algebraicType.tag) ? 0n : 0;
        const max = revived.reduce<number | bigint>(
          (highest, row) =>
            (row[name] as number | bigint) > highest
              ? (row[name] as number | bigint)
              : highest,
          zero
        );
        let generated: number | bigint = zero;
        while (generated < max) {
          const inserted = handle.insert({ ...revived[0], [name]: zero });
          generated = inserted[name] as number | bigint;
          handle.delete(inserted);
        }
      }

      for (const row of revived) {
        handle.insert(row);
      }
    }
  );

  return { backup_tables, backup_export, backup_import };
}

/**
 * Allow only the identity stored in a module environment variable, such as the
 * database owner's identity from `spacetime login show`. Rejects everyone when unset.
 */
export function ownerIdentityFromEnv(key: string): BackupOptions['authorize'] {
  return (caller) => {
    const owner = caller.env.get(key);
    if (!owner || !caller.sender.isEqual(Identity.fromString(owner))) {
      throw new SenderError(
        `Unauthorized: backup functions require the identity in ${key}`
      );
    }
  };
}
