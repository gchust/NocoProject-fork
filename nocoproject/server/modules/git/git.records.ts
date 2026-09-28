/**
 * Row mapping and writes for `pullRequests` and `issuePullRequests` (docs/phase1/iteration-2-contract.md §C).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import {
  bool,
  iso,
  isoOrNull,
  isUniqueViolation,
  now,
  num,
  str,
  toDate,
  unique,
} from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type {
  ClaimedPullRequest,
  IssuePullRequestViewV4,
  IssueV1,
  PullRequest,
  PullRequestCiState,
  PullRequestLinkedByType,
  PullRequestState,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';
import type { PullRequestSnapshot } from './github-client.js';
import type { PullRequestRef } from './link-rules.js';

function stateOf(value: unknown): PullRequestState {
  return value === 'closed' || value === 'merged' ? value : 'open';
}

function ciOf(value: unknown): PullRequestCiState | null {
  return value === 'pending' || value === 'success' || value === 'failure'
    ? value
    : null;
}

export function mapPullRequest(row: Record<string, unknown>): PullRequest {
  return {
    id: str(row.id) ?? '',
    connectionId: str(row.connectionId),
    repo: str(row.repo) ?? '',
    number: num(row.number),
    url: str(row.url) ?? '',
    title: str(row.title) ?? '',
    state: stateOf(row.state),
    draft: bool(row.draft),
    headRef: str(row.headRef) ?? '',
    baseRef: str(row.baseRef) ?? '',
    headSha: str(row.headSha) ?? '',
    authorLogin: str(row.authorLogin) ?? '',
    additions: num(row.additions),
    deletions: num(row.deletions),
    changedFiles: num(row.changedFiles),
    mergeableState: str(row.mergeableState),
    ciState: ciOf(row.ciState),
    mergedAt: isoOrNull(row.mergedAt),
    closedAt: isoOrNull(row.closedAt),
    snapshotAt: isoOrNull(row.snapshotAt),
  };
}

export async function findPullRequest(
  conn: Conn,
  repo: string,
  number: number,
): Promise<PullRequest | null> {
  const row = await conn.query
    .selectFrom('pullRequests')
    .selectAll()
    .where('repo', '=', repo)
    .where('number', '=', number)
    .executeTakeFirst();
  return row ? mapPullRequest(row) : null;
}

export async function findPullRequestById(
  conn: Conn,
  id: string,
): Promise<PullRequest | null> {
  const row = await conn.query
    .selectFrom('pullRequests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? mapPullRequest(row) : null;
}

function snapshotValues(
  snapshot: PullRequestSnapshot,
  connectionId: string | null,
) {
  return {
    connectionId,
    url: snapshot.url,
    title: snapshot.title,
    state: snapshot.state,
    draft: snapshot.draft,
    headRef: snapshot.headRef,
    baseRef: snapshot.baseRef,
    headSha: snapshot.headSha,
    authorLogin: snapshot.authorLogin,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    changedFiles: snapshot.changedFiles,
    mergeableState: snapshot.mergeableState,
    mergedAt: toDate(snapshot.mergedAt),
    closedAt: toDate(snapshot.closedAt),
    ...(snapshot.ciState !== undefined ? { ciState: snapshot.ciState } : {}),
    ...(snapshot.ciRunUrl !== undefined ? { ciRunUrl: snapshot.ciRunUrl } : {}),
    ...(snapshot.screenshotsUrl !== undefined
      ? { screenshotsUrl: snapshot.screenshotsUrl }
      : {}),
    snapshotAt: now(),
  };
}

/**
 * Inserts or refreshes a pull request from a full snapshot; returns it with the state it had before. The webhook and
 * REST reads (refresh, merge check) both write here, and the caller runs the flow of a state change
 * (`onPullRequestStateChanged`). A state change is written only over the state it was read with, so when two writers
 * race the second one retries, sees the new state as `previous` and runs no flow twice.
 */
export async function upsertPullRequest(
  tx: Tx,
  ids: IdSource,
  snapshot: PullRequestSnapshot,
  connectionId: string | null,
): Promise<{ pr: PullRequest; previous: PullRequest | null }> {
  const previous = await findPullRequest(
    tx.conn,
    snapshot.repo,
    snapshot.number,
  );
  const headMoved =
    !!previous && !!snapshot.headSha && previous.headSha !== snapshot.headSha;
  const values = {
    // The stored run links belong to the old head.
    ...(headMoved ? { ciRunUrl: null, screenshotsUrl: null } : {}),
    ...snapshotValues(snapshot, connectionId),
  };
  if (previous) {
    let update = tx.conn.query
      .updateTable('pullRequests')
      .set({ ...values, updatedAt: now() })
      .where('id', '=', previous.id);
    if (previous.state !== snapshot.state)
      update = update.where('state', '=', previous.state);
    const { updatedCount } = await update.execute();
    // Another writer changed the state first (PostgreSQL re-checks the condition once its commit releases the row).
    if (updatedCount === 0)
      return upsertPullRequest(tx, ids, snapshot, connectionId);
  } else {
    const timestamp = now();
    try {
      await tx.conn.transaction(async (inner) => {
        await inner.query
          .insertInto('pullRequests')
          .values({
            id: ids.next(),
            repo: snapshot.repo,
            number: snapshot.number,
            ciState: null,
            ...values,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .execute();
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent delivery inserted it first: refresh that row instead.
      return upsertPullRequest(tx, ids, snapshot, connectionId);
    }
  }
  return {
    pr: (await findPullRequest(
      tx.conn,
      snapshot.repo,
      snapshot.number,
    )) as PullRequest,
    previous,
  };
}

/** The stored pull request for a URL, or a minimal open row the webhook fills in later. */
export async function ensurePullRequest(
  tx: Tx,
  ids: IdSource,
  ref: PullRequestRef,
): Promise<PullRequest> {
  const existing = await findPullRequest(tx.conn, ref.repo, ref.number);
  if (existing) return existing;
  const timestamp = now();
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('pullRequests')
        .values({
          id: ids.next(),
          connectionId: null,
          repo: ref.repo,
          number: ref.number,
          url: ref.url,
          title: '',
          state: 'open',
          draft: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return (await findPullRequest(tx.conn, ref.repo, ref.number)) as PullRequest;
}

/**
 * Links a pull request to an issue (idempotent). A new link records `pr_linked` and invalidates the issue; returns
 * whether the link is new.
 */
export async function linkPullRequest(
  tx: Tx,
  deps: { ids: IdSource; activity: ActivityRecorder },
  input: {
    issue: IssueV1;
    pr: PullRequest;
    linkedByType: PullRequestLinkedByType;
    actor: Actor;
  },
): Promise<boolean> {
  const { issue, pr, linkedByType, actor } = input;
  const exists = await tx.conn.query
    .selectFrom('issuePullRequests')
    .select('id')
    .where('issueId', '=', issue.id)
    .where('pullRequestId', '=', pr.id)
    .exists();
  if (exists) return false;
  const timestamp = now();
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('issuePullRequests')
        .values({
          id: deps.ids.next(),
          issueId: issue.id,
          pullRequestId: pr.id,
          linkedByType,
          linkedById: actor.id,
          autoCompleteDisabled: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor,
    action: 'pr_linked',
    details: {
      pullRequestId: pr.id,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      linkedByType,
    },
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  return true;
}

export interface PullRequestLinkRow {
  readonly issueId: string;
  readonly pullRequestId: string;
  readonly autoCompleteDisabled: boolean;
}

export async function linksOfPullRequest(
  conn: Conn,
  pullRequestId: string,
): Promise<PullRequestLinkRow[]> {
  const rows = await conn.query
    .selectFrom('issuePullRequests')
    .select(['issueId', 'pullRequestId', 'autoCompleteDisabled'])
    .where('pullRequestId', '=', pullRequestId)
    .execute();
  return rows.map((row) => ({
    issueId: str(row.issueId) ?? '',
    pullRequestId: str(row.pullRequestId) ?? '',
    autoCompleteDisabled: bool(row.autoCompleteDisabled),
  }));
}

/**
 * Pull requests linked to an issue with who linked them, oldest link first. `viewerCanMerge` is the caller's merge
 * permission on the issue (`canMergePullRequest`); false for agent and system reads.
 */
export async function pullRequestsForIssue(
  conn: Conn,
  users: UserDirectory,
  issueId: string,
  viewerCanMerge = false,
): Promise<IssuePullRequestViewV4[]> {
  const links = await conn.query
    .selectFrom('issuePullRequests')
    .selectAll()
    .where('issueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const prIds = unique(links.map((row) => str(row.pullRequestId)));
  if (prIds.length === 0) return [];
  const prs = await conn.query
    .selectFrom('pullRequests')
    .selectAll()
    .where('id', 'in', prIds)
    .execute();
  const byId = new Map(
    prs.map((row) => [
      str(row.id) ?? '',
      {
        ...mapPullRequest(row),
        ciRunUrl: str(row.ciRunUrl),
        screenshotsUrl: str(row.screenshotsUrl),
      },
    ]),
  );
  const userNames = await users.names(
    conn,
    links
      .filter((row) => row.linkedByType === 'user')
      .map((row) => str(row.linkedById)),
  );
  const agents = await agentNames(
    conn,
    links
      .filter((row) => row.linkedByType === 'agent')
      .map((row) => str(row.linkedById)),
  );
  const result: IssuePullRequestViewV4[] = [];
  for (const link of links) {
    const pr = byId.get(str(link.pullRequestId) ?? '');
    if (!pr) continue;
    const type = (str(link.linkedByType) ??
      'system') as PullRequestLinkedByType;
    const id = str(link.linkedById);
    result.push({
      ...pr,
      linkedBy: {
        type,
        id,
        name:
          type === 'system' || !id
            ? null
            : ((type === 'agent' ? agents : userNames).get(id) ?? null),
      },
      autoCompleteDisabled: bool(link.autoCompleteDisabled),
      linkedAt: iso(link.createdAt),
      viewerCanMerge,
    });
  }
  return result;
}

/** The claim payload's `issue.pullRequests`. */
export async function claimedPullRequests(
  conn: Conn,
  issueId: string,
): Promise<ClaimedPullRequest[]> {
  const links = await conn.query
    .selectFrom('issuePullRequests')
    .select('pullRequestId')
    .where('issueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .execute();
  const ids = unique(links.map((row) => str(row.pullRequestId)));
  if (ids.length === 0) return [];
  const rows = await conn.query
    .selectFrom('pullRequests')
    .select(['id', 'number', 'url', 'state'])
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((row) => [str(row.id) ?? '', row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is Record<string, unknown> => !!row)
    .map((row) => ({
      number: num(row.number),
      url: str(row.url) ?? '',
      state: stateOf(row.state),
    }));
}
