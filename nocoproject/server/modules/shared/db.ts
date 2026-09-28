/**
 * Small database helpers shared by the NocoProject services.
 *
 * Services read and write through the QueryAdapter of the connection they are handed (camelCase logical names).
 * Raw Knex is used only where the adapter cannot express the statement (`FOR UPDATE SKIP LOCKED`, `RETURNING`,
 * advisory locks); those statements name physical snake_case tables and columns.
 */
import type { DatabaseConnection, DatabaseManager } from '@nocobase/db';
import type { Knex } from 'knex';

import type { DomainEvent, DomainEventBus } from './events.js';

export type Conn = DatabaseConnection;

/**
 * One unit of work: the transaction connection plus a queue of domain events that are emitted only after the
 * transaction commits.
 */
export interface Tx {
  readonly conn: DatabaseConnection;
  emit(event: DomainEvent): void;
}

export interface TxRunner {
  /**
   * Runs `fn` in a transaction. Passing `outer` joins that unit of work instead, so a service can be composed into a
   * caller's transaction and its events are emitted when the outermost transaction commits.
   */
  run<T>(fn: (tx: Tx) => Promise<T>, outer?: Tx): Promise<T>;
  /** Connection for reads outside a transaction. */
  read(): DatabaseConnection;
}

/**
 * Called once `fn` of the outermost transaction has finished and before it commits, with the domain events emitted
 * so far. It runs in the same transaction, so what it writes commits or rolls back with the change that caused it
 * (the notification module turns events into inbox items this way). Events it emits are handed to it again in a
 * further round, up to a fixed bound.
 */
export type BeforeCommitHook = (
  tx: Tx,
  events: readonly DomainEvent[],
) => Promise<void>;

const MAX_BEFORE_COMMIT_ROUNDS = 5;

export function createTxRunner(
  database: DatabaseManager,
  bus: DomainEventBus,
  beforeCommit?: BeforeCommitHook,
): TxRunner {
  return {
    async run(fn, outer) {
      if (outer) return fn(outer);
      const pending: DomainEvent[] = [];
      const result = await database.transaction(async (conn) => {
        const tx: Tx = { conn, emit: (event) => pending.push(event) };
        const value = await fn(tx);
        let processed = 0;
        for (
          let round = 0;
          beforeCommit &&
          processed < pending.length &&
          round < MAX_BEFORE_COMMIT_ROUNDS;
          round += 1
        ) {
          const batch = pending.slice(processed);
          processed = pending.length;
          await beforeCommit(tx, batch);
        }
        return value;
      });
      for (const event of pending) bus.emit(event);
      return result;
    },
    read: () => database.connection(),
  };
}

/** The Knex client bound to this connection; inside a transaction it is the transaction itself. */
export function knexOf(conn: DatabaseConnection): Promise<Knex> {
  return conn.client<Knex>();
}

/** Rows of a `knex.raw()` result on PostgreSQL (`{ rows }`) or SQLite (an array). */
export function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function isPostgres(conn: DatabaseConnection): boolean {
  return conn.dialect === 'postgres';
}

/** Unique-constraint violation on PostgreSQL (23505) or SQLite. */
export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (!candidate) return false;
  if (candidate.code === '23505') return true;
  if (candidate.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  return (
    typeof candidate.message === 'string' &&
    /unique constraint|UNIQUE constraint failed/i.test(candidate.message)
  );
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return '';
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  )
    return String(value);
  return null;
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * JSON column encoding. The QueryAdapter passes values to the driver unchanged, and node-postgres would turn a
 * JavaScript array into a PostgreSQL array literal, so every JSON value is serialized explicitly.
 */
export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function fromJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

export function now(): Date {
  return new Date();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/**
 * Runtime shape check for request bodies. Deliberately not a type guard: `Array.isArray` on a declared readonly array
 * narrows its elements to `any`, which is what a type guard here would do too.
 */
export function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

/** Removes duplicates while preserving order and dropping empty values. */
export function unique(
  values: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  for (const value of values) if (value) seen.add(value);
  return Array.from(seen);
}
