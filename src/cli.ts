#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { applyTransform, isSelected, parsePatterns, type Transforms } from './select.ts';
import { backupTable, DEFAULT_CHUNK_SIZE, restoreTable, type BackupTransport } from './transfer.ts';

const USAGE = `Usage:
  spacetimedb-backup backup  [--dir <dir>] [options]
  spacetimedb-backup restore  --dir <dir>  [--transform <file>] [--dry-run] [options]

Options:
  --server <url>        Server URL (default: "server" in spacetime.local.json / spacetime.json)
  --database <name>     Database name (default: "database" in spacetime.local.json / spacetime.json)
  --token <jwt>         Owner token (default: output of \`spacetime login show --token\`)
  --include <patterns>  Comma-separated tables or namespaces to process, e.g. fro,im.user
  --exclude <patterns>  Comma-separated tables or namespaces to skip
  --transform <file>    Module whose default export maps table keys to row rewrites
  --chunk-size <chars>  Maximum JSON characters per request (default: 1000000)
  --dry-run             Apply transforms and report what would be restored without writing`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    database: { type: 'string' },
    token: { type: 'string' },
    dir: { type: 'string' },
    include: { type: 'string' },
    exclude: { type: 'string' },
    transform: { type: 'string' },
    'chunk-size': { type: 'string', default: String(DEFAULT_CHUNK_SIZE) },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0];
if (values.help || (command !== 'backup' && command !== 'restore')) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const config = Object.assign(
  {},
  ...['spacetime.json', 'spacetime.local.json']
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as { server?: string; database?: string })
);
const server = values.server ?? config.server;
const database = values.database ?? config.database;
if (!server || !database) {
  throw new Error('Specify --server and --database, or run from a directory containing spacetime.json');
}
const baseUrl = `${server.includes('://') ? server : `http://${server}`}/v1/database/${encodeURIComponent(database)}`;
const include = parsePatterns(values.include);
const exclude = parsePatterns(values.exclude);
const chunkSize = Number(values['chunk-size']);
if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 0xffffffff) {
  throw new Error('--chunk-size must be a positive integer');
}

function ownerToken(): string {
  if (values.token) {
    return values.token;
  }
  const output = execFileSync('spacetime', ['login', 'show', '--token'], { encoding: 'utf8' });
  const match = output.match(/token.* is (\S+)\s*$/m);
  if (!match) {
    throw new Error('Could not read a token from `spacetime login show --token`; pass --token');
  }
  return match[1];
}

async function call(token: string, name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`${baseUrl}/call/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${name} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function httpTransport(token: string): BackupTransport {
  return {
    exportPage: async (table, offset, maxLength) =>
      (await call(token, 'backup_export', [table, offset, maxLength])) as string,
    importChunk: async (table, rows, clear, validate) => {
      await call(token, 'backup_import', [table, rows, clear, validate]);
    },
  };
}

async function backup(token: string) {
  const dir = resolve(values.dir ?? join('backups', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(dir, { recursive: true });
  const tables = (await call(token, 'backup_tables', [])) as string[];
  for (const table of tables.filter((key) => isSelected(key, include, exclude))) {
    const rows = await backupTable(httpTransport(token), table, chunkSize);
    writeFileSync(join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`${table}: ${rows.length} rows`);
  }
  console.log(`Backup written to ${dir}`);
}

async function restore(token: string | undefined) {
  if (!values.dir) {
    throw new Error('restore requires --dir');
  }
  const transforms: Transforms = values.transform
    ? (await import(pathToFileURL(resolve(values.transform)).href)).default
    : {};
  const known = token ? new Set((await call(token, 'backup_tables', [])) as string[]) : undefined;

  const files = readdirSync(values.dir).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const table = file.slice(0, -'.json'.length);
    if (!isSelected(table, include, exclude)) {
      continue;
    }
    if (known && !known.has(table)) {
      console.warn(`${table}: not in the current schema, skipped`);
      continue;
    }
    const rows = applyTransform(
      table,
      JSON.parse(readFileSync(join(values.dir, file), 'utf8')) as Record<string, unknown>[],
      transforms
    );
    if (!token) {
      console.log(`${table}: would restore ${rows.length} rows`);
      continue;
    }
    try {
      const requests = await restoreTable(httpTransport(token), table, rows, chunkSize);
      console.log(`${table}: restored ${rows.length} rows in ${requests} request(s)`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`${table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (command === 'backup') {
  await backup(ownerToken());
} else {
  await restore(values['dry-run'] ? undefined : ownerToken());
}
