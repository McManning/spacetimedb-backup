import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTransform, chunkRows, isSelected, parsePatterns } from './select.ts';

test('patterns select tables by exact key or namespace prefix', () => {
  assert.deepEqual(parsePatterns(' fro, im.user ,'), ['fro', 'im.user']);
  assert.equal(isSelected('fro.world', [], []), true);
  assert.equal(isSelected('fro.world', ['fro'], []), true);
  assert.equal(isSelected('im.user', ['im.user'], []), true);
  assert.equal(isSelected('im.mail', ['im.user'], []), false);
  assert.equal(isSelected('froz.world', ['fro'], []), false);
  assert.equal(isSelected('fro.session', ['fro'], ['fro.session']), false);
});

test('transforms rewrite rows only for their table', () => {
  const transforms = { 'fro.world': (row: Record<string, unknown>) => ({ ...row, layer: 0 }) };
  assert.deepEqual(applyTransform('fro.world', [{ id: 1 }], transforms), [{ id: 1, layer: 0 }]);
  assert.deepEqual(applyTransform('im.user', [{ id: 1 }], transforms), [{ id: 1 }]);
});

test('rows are chunked under the length limit and never lost', () => {
  const rows = Array.from({ length: 10 }, (_, id) => ({ id, name: 'x'.repeat(20) }));
  const chunks = chunkRows(rows, 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.json.length <= 100));
  assert.deepEqual(chunks.flatMap((chunk) => JSON.parse(chunk.json)), rows);
  assert.deepEqual(chunks.map((chunk) => chunk.start), chunks.map((_, i) => chunks.slice(0, i).reduce((n, c) => n + c.count, 0)));
  assert.deepEqual(chunkRows([], 100), [{ json: '[]', start: 0, count: 0 }]);
  assert.equal(chunkRows([{ big: 'y'.repeat(500) }], 100).length, 1);
});
