import { createHash, randomBytes } from 'node:crypto';

import type { IdGeneratorService } from '@nocobase/snowflake';

import { RUN_TOKEN_PREFIX } from './protocol.js';

/** String snowflake ids for every NocoProject table. */
export interface IdSource {
  next(): string;
}

export function createIdSource(generator: IdGeneratorService): IdSource {
  return { next: () => generator.generateString() };
}

/** A new run token: `npr_` + 40 hex characters. Only its hash is ever stored. */
export function mintRunToken(): {
  readonly token: string;
  readonly hash: string;
} {
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(20).toString('hex')}`;
  return { token, hash: hashRunToken(token) };
}

export function hashRunToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
