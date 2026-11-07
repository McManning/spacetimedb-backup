import type { AlgebraicType } from 'spacetimedb';

export type Typespace = { types: AlgebraicType[] };

const BIG_INTEGER_TAGS = new Set(['I64', 'U64', 'I128', 'U128', 'I256', 'U256']);

/**
 * Serialize rows read from a table into JSON. Special values (Identity,
 * Timestamp, ConnectionId, Uuid) are single-field products and serialize as
 * plain objects; bigints become decimal strings.
 */
export function stringifyRows(rows: unknown[]): string {
  return `[${rows.map(stringifyRow).join(',')}]`;
}

export function stringifyRow(row: unknown): string {
  return JSON.stringify(row, (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Uint8Array) {
      return Array.from(value);
    }
    return value;
  });
}

/**
 * Convert a JSON value produced by `stringifyRows` into the in-memory value the
 * SpacetimeDB serializer expects for `type`. Rows are matched by column name, so
 * columns may be reordered or removed, and new optional columns default to none.
 */
export function reviveValue(
  value: unknown,
  type: AlgebraicType,
  typespace?: Typespace,
  path = 'row'
): unknown {
  while (type.tag === 'Ref') {
    if (!typespace) {
      throw new Error(`${path}: cannot resolve type reference without a typespace`);
    }
    type = typespace.types[type.value];
  }

  if (type.tag === 'Sum') {
    const variants = type.value.variants;
    if (variants.length === 2 && variants[0].name === 'some' && variants[1].name === 'none') {
      if (value === null || value === undefined) {
        return undefined;
      }
      return reviveValue(value, variants[0].algebraicType, typespace, path);
    }
    if (variants.length === 2 && variants[0].name === 'ok' && variants[1].name === 'err') {
      const result = requireObject(value, path);
      const key = 'ok' in result ? 'ok' : 'err';
      const variant = variants[key === 'ok' ? 0 : 1];
      return { [key]: reviveValue(result[key], variant.algebraicType, typespace, `${path}.${key}`) };
    }
    const sum = requireObject(value, path);
    const variant = variants.find((v) => v.name === sum.tag);
    if (!variant) {
      throw new Error(`${path}: unknown variant ${JSON.stringify(sum.tag)}`);
    }
    return {
      tag: sum.tag,
      value: reviveValue(sum.value, variant.algebraicType, typespace, `${path}.${sum.tag}`),
    };
  }

  if (value === null || value === undefined) {
    throw new Error(`${path}: missing required value`);
  }

  if (type.tag === 'Product') {
    const product = requireObject(value, path);
    return Object.fromEntries(
      type.value.elements.map(({ name, algebraicType }) => [
        name,
        reviveValue(product[name!], algebraicType, typespace, `${path}.${name}`),
      ])
    );
  }

  if (type.tag === 'Array') {
    if (!Array.isArray(value)) {
      throw new Error(`${path}: expected an array`);
    }
    if (type.value.tag === 'U8') {
      return Uint8Array.from(value);
    }
    const element = type.value;
    return value.map((item, i) => reviveValue(item, element, typespace, `${path}[${i}]`));
  }

  if (BIG_INTEGER_TAGS.has(type.tag)) {
    return BigInt(value as string | number);
  }

  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}
