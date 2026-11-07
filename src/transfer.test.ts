import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupTable, restoreTable, type BackupTransport } from './transfer.ts';

function fakeTransport(rows: unknown[], failOn?: (rows: unknown[], validate: boolean) => boolean) {
  const table: unknown[] = [...rows];
  const calls: string[] = [];
  const transport: BackupTransport = {
    exportPage: async (_t, offset) => JSON.stringify(table.slice(offset, offset + 2)),
    importChunk: async (_t, json, clear, validate) => {
      const chunk = JSON.parse(json) as unknown[];
      calls.push(`${validate ? 'validate' : clear ? 'clear' : 'append'}:${chunk.length}`);
      if (failOn?.(chunk, validate)) {
        throw new Error('rejected');
      }
      if (!validate) {
        if (clear) {
          table.length = 0;
        }
        table.push(...chunk);
      }
    },
  };
  return { table, calls, transport };
}

test('backup pages until empty and restore validates every chunk before writing', async () => {
  const rows = Array.from({ length: 5 }, (_, id) => ({ id }));
  const source = fakeTransport(rows);
  assert.deepEqual(await backupTable(source.transport, 't'), rows);

  const target = fakeTransport([{ id: 99 }]);
  assert.equal(await restoreTable(target.transport, 't', rows, 20), 3);
  assert.deepEqual(target.table, rows);
  assert.deepEqual(target.calls, ['validate:2', 'validate:2', 'validate:1', 'clear:2', 'append:2', 'append:1']);
});

test('a validation failure writes nothing; a write failure reports partial progress', async () => {
  const rows = Array.from({ length: 4 }, (_, id) => ({ id }));
  const invalid = fakeTransport([{ id: 99 }], (chunk, validate) => validate && JSON.stringify(chunk).includes('"id":3'));
  await assert.rejects(restoreTable(invalid.transport, 't', rows, 20), /rows 2-3: rejected/);
  assert.deepEqual(invalid.table, [{ id: 99 }]);

  const broken = fakeTransport([], (chunk, validate) => !validate && JSON.stringify(chunk).includes('"id":3'));
  await assert.rejects(restoreTable(broken.transport, 't', rows, 20), /partially restored: 2 of 4 rows/);
});
