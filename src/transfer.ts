import { chunkRows } from './select.ts';

/** Maximum JSON characters per request. */
export const DEFAULT_CHUNK_SIZE = 1_000_000;

/**
 * How a client reaches the module's backup functions: HTTP for the CLI, or an
 * SDK connection's `backup_export` procedure and `backup_import` reducer.
 */
export type BackupTransport = {
  exportPage(table: string, offset: number, maxLength: number): Promise<string>;
  importChunk(table: string, rows: string, clear: boolean, validate: boolean): Promise<void>;
};

/** Read every row of a table, one size-limited page at a time. */
export async function backupTable(
  transport: BackupTransport,
  table: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (;;) {
    const page = JSON.parse(await transport.exportPage(table, rows.length, chunkSize)) as unknown[];
    if (page.length === 0) {
      return rows;
    }
    rows.push(...page);
  }
}

/**
 * Replace a table's rows. Every chunk is validated against the current schema
 * before anything is written, so schema mismatches leave the table untouched.
 * Returns the number of requests used to write.
 */
export async function restoreTable(
  transport: BackupTransport,
  table: string,
  rows: unknown[],
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<number> {
  const chunks = chunkRows(rows, chunkSize);
  for (const { json, start, count } of chunks) {
    await transport.importChunk(table, json, false, true).catch((error: unknown) => {
      throw new Error(`rows ${start}-${start + count - 1}: ${messageOf(error)}`);
    });
  }
  let written = 0;
  for (const [index, { json, count }] of chunks.entries()) {
    await transport.importChunk(table, json, index === 0, false).catch((error: unknown) => {
      const partial = written > 0 ? ` (partially restored: ${written} of ${rows.length} rows; rerun to retry)` : '';
      throw new Error(`${messageOf(error)}${partial}`);
    });
    written += count;
  }
  return chunks.length;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { applyTransform, isSelected, parsePatterns, type Transforms } from './select.ts';
