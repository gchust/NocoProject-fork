/**
 * The merge-check sweep (queue filled by `pr-signals.ts`): each due pull request is read from GitHub with the stored
 * token, outside any transaction, and stored like any REST read (`storeSnapshot`), which reports its signals. While
 * GitHub is still computing (`mergeable === null`), or the read fails, it is read again after
 * MERGE_CHECK_RETRY_SECONDS, at most MAX_MERGE_CHECK_ATTEMPTS reads in all; then the mark is cleared. A pull request
 * that left `open` meanwhile is cleared without a read. Never throws.
 */
import type { SecretBox } from '../shared/crypto.js';
import type { TxRunner } from '../shared/db.js';
import { addSeconds, num, str } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type { GitHubClient } from './github-client.js';
import { storeSnapshot, type GitFlowDeps } from './merge-flow.js';
import { fetchSnapshot } from './pull-request.service.js';

export const MAX_MERGE_CHECK_ATTEMPTS = 5;
export const MERGE_CHECK_RETRY_SECONDS = 30;
/** Per sweep, oldest first; the rest wait for the next pass. */
export const MERGE_CHECK_BATCH = 20;

export interface MergeCheckDeps extends GitFlowDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly secrets: SecretBox;
  readonly github?: GitHubClient;
}

/** Runs the due merge checks; returns how many pull requests were read. */
export async function runMergeChecks(
  deps: MergeCheckDeps,
  at: Date = new Date(),
): Promise<number> {
  const github = deps.github;
  if (!github) return 0;
  const due = await deps.tx
    .read()
    .query.selectFrom('pullRequests')
    .select(['id', 'repo', 'number', 'state', 'mergeCheckAttempts'])
    .where('mergeCheckAfter', 'is not', null)
    .where('mergeCheckAfter', '<=', at)
    .orderBy('mergeCheckAfter', 'asc')
    .limit(MERGE_CHECK_BATCH)
    .execute();
  let read = 0;
  for (const row of due) {
    const id = str(row.id) ?? '';
    const attempts = num(row.mergeCheckAttempts) + 1;
    const again = (retry: boolean) =>
      retry && attempts < MAX_MERGE_CHECK_ATTEMPTS
        ? {
            mergeCheckAfter: addSeconds(at, MERGE_CHECK_RETRY_SECONDS),
            mergeCheckAttempts: attempts,
          }
        : { mergeCheckAfter: null, mergeCheckAttempts: 0 };
    try {
      if (row.state !== 'open') {
        await deps.tx.run((tx) =>
          tx.conn.query
            .updateTable('pullRequests')
            .set(again(false))
            .where('id', '=', id)
            .execute(),
        );
        continue;
      }
      const fetched = await fetchSnapshot(
        { tx: deps.tx, secrets: deps.secrets, github },
        { repo: str(row.repo) ?? '', number: num(row.number) },
      );
      read += 1;
      await deps.tx.run(async (tx) => {
        await storeSnapshot(deps, tx, fetched.snapshot, fetched.connectionId);
        await tx.conn.query
          .updateTable('pullRequests')
          .set(again(fetched.payload.mergeable === null))
          .where('id', '=', id)
          .execute();
      });
    } catch {
      // No token, GitHub unreachable or the row changed under us: try again later, then give up quietly.
      await deps.tx
        .run((tx) =>
          tx.conn.query
            .updateTable('pullRequests')
            .set(again(true))
            .where('id', '=', id)
            .execute(),
        )
        .catch(() => undefined);
    }
  }
  return read;
}
