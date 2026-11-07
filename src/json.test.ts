import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlgebraicType } from 'spacetimedb';
import { reviveValue, stringifyRows } from './json.ts';

const option = (inner: AlgebraicType): AlgebraicType => ({
  tag: 'Sum',
  value: {
    variants: [
      { name: 'some', algebraicType: inner },
      { name: 'none', algebraicType: { tag: 'Product', value: { elements: [] } } },
    ],
  },
});
const product = (elements: Record<string, AlgebraicType>): AlgebraicType => ({
  tag: 'Product',
  value: { elements: Object.entries(elements).map(([name, algebraicType]) => ({ name, algebraicType })) },
});

const timestamp = product({ __timestamp_micros_since_unix_epoch__: { tag: 'I64' } });
const identity = product({ __identity__: { tag: 'U256' } });
const position = product({ x: { tag: 'I32' }, y: { tag: 'I32' } });
const shape: AlgebraicType = {
  tag: 'Sum',
  value: {
    variants: [
      { name: 'circle', algebraicType: { tag: 'F64' } },
      { name: 'point', algebraicType: { tag: 'Ref', value: 0 } },
    ],
  },
};
const typespace = { types: [position] };
const row = product({
  id: { tag: 'U64' },
  owner: identity,
  createdAt: timestamp,
  nickname: option({ tag: 'String' }),
  tags: { tag: 'Array', value: { tag: 'String' } },
  bytes: { tag: 'Array', value: { tag: 'U8' } },
  position: { tag: 'Ref', value: 0 },
  shape,
});

test('rows round-trip through JSON', () => {
  const original = {
    id: 18446744073709551615n,
    owner: { __identity__: 2n ** 255n },
    createdAt: { __timestamp_micros_since_unix_epoch__: 1730851200000001n },
    nickname: 'neo',
    tags: ['a', 'b'],
    bytes: Uint8Array.from([1, 2, 255]),
    position: { x: -1, y: 2 },
    shape: { tag: 'point', value: { x: 3, y: 4 } },
  };
  const [json] = JSON.parse(stringifyRows([original]));
  assert.deepEqual(reviveValue(json, row, typespace), original);
});

test('columns are matched by name, missing options become none, extra keys are dropped', () => {
  const revived = reviveValue({ y: 1, removed: true, x: 2 }, product({ x: { tag: 'I32' }, y: { tag: 'I32' }, label: option({ tag: 'String' }) }));
  assert.deepEqual(revived, { x: 2, y: 1, label: undefined });
});

test('a missing required column names the column', () => {
  assert.throws(() => reviveValue({ x: 1 }, position, undefined, 'fro.world[0]'), /fro\.world\[0\]\.y: missing required value/);
});
