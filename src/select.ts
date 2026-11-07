/** Row rewrites keyed by table, applied to backup JSON before restore. */
export type Transforms = Record<string, (row: Record<string, unknown>) => Record<string, unknown>>;

/** Split a comma-separated pattern list such as `fro,im.user`. */
export function parsePatterns(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

/**
 * A pattern matches a table key exactly (`im.user`) or as a namespace prefix
 * (`fro` matches `fro.world`). Exclusion wins over inclusion; an empty include
 * list selects every table.
 */
export function isSelected(table: string, include: string[], exclude: string[]): boolean {
  const matches = (pattern: string) => table === pattern || table.startsWith(`${pattern}.`);
  if (exclude.some(matches)) {
    return false;
  }
  return include.length === 0 || include.some(matches);
}

export function applyTransform(
  table: string,
  rows: Record<string, unknown>[],
  transforms: Transforms
): Record<string, unknown>[] {
  const transform = transforms[table];
  return transform ? rows.map(transform) : rows;
}

/**
 * Split rows into JSON array strings of at most `maxLength` characters each. A
 * row longer than the limit gets its own chunk. Always returns at least one
 * chunk, so an empty table still clears its target.
 */
export function chunkRows(rows: unknown[], maxLength: number): { json: string; start: number; count: number }[] {
  const chunks: { json: string; start: number; count: number }[] = [];
  let parts: string[] = [];
  let length = 0;
  let start = 0;
  rows.forEach((row, index) => {
    const json = JSON.stringify(row);
    // length counts each row plus its comma; +2 for the array brackets
    if (parts.length > 0 && length + json.length + 2 > maxLength) {
      chunks.push({ json: `[${parts.join(',')}]`, start, count: parts.length });
      parts = [];
      length = 0;
      start = index;
    }
    parts.push(json);
    length += json.length + 1;
  });
  chunks.push({ json: `[${parts.join(',')}]`, start, count: parts.length });
  return chunks;
}
