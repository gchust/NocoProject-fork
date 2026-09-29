/**
 * GitHub webhook deliveries (docs/phase1/iteration-2-contract.md §C).
 *
 * Verification: `X-Hub-Signature-256` is an HMAC-SHA256 of the raw body with the stored webhook secret, compared in
 * constant time; no secret configured, a missing or a wrong signature → `invalidSignature`. Replay: every
 * `X-GitHub-Delivery` id is recorded in `webhookDeliveries` in the same transaction as its effects, so a duplicate is
 * answered without doing anything twice and a failed delivery can be redelivered. Rows older than 7 days are purged
 * by the provider's sweep.
 *
 * Events: `pull_request` (upsert, link rules, merge / close / ready flows), `check_suite` completed and `status`
 * (CI state by head SHA), `push` (merge checks of the open pull requests based on the pushed branch, only while the
 * conflict signal rule is on), `ping`; anything else is acknowledged and ignored. Every stored change reports its
 * signals to the linked issues (`pr-signals.ts`); `checkMerges` runs the due merge checks from the sweeper. After a completed check suite the head's
 * Actions run and `screenshots` artifact links are fetched with the stored token, outside the transaction (NP-85);
 * failures there are ignored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ActivityRecorder } from '../shared/activity.js';
import { SYSTEM_ACTOR } from '../shared/activity.js';
import type { SecretBox } from '../shared/crypto.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, unique } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type { PullRequestCiState } from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import { findIssue } from '../issue/issue.records.js';
import { credentialsOf, loadConnection } from './connection.service.js';
import {
  ciStateOfCheckSuite,
  ciStateOfStatus,
  snapshotFromPayload,
  type GitHubClient,
  type GitHubPullRequestPayload,
} from './github-client.js';
import {
  findPullRequestById,
  linkPullRequest,
  linksOfPullRequest,
  upsertPullRequest,
} from './git.records.js';
import { matchIssueIdentifiers } from './link-rules.js';
import { reportPullRequestSignals, scheduleMergeChecks } from './pr-signals.js';
import { runMergeChecks } from './merge-checks.js';
import {
  onPullRequestStateChanged,
  requestReviews,
  type GitFlowDeps,
} from './merge-flow.js';

export const WEBHOOK_RETENTION_DAYS = 7;

const PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'edited',
  'synchronize',
  'reopened',
  'ready_for_review',
  'converted_to_draft',
  'closed',
]);
const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);
/** A new head or base: GitHub recomputes mergeability, so read it again later. */
const MERGE_CHECK_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'edited',
]);

export interface WebhookDelivery {
  readonly deliveryId: string | null;
  readonly event: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
}

export type WebhookResult =
  | { readonly status: 'invalidSignature' }
  | { readonly status: 'missingDelivery' }
  | { readonly status: 'duplicate' }
  | {
      readonly status: 'processed';
      readonly event: string;
      readonly ignored: boolean;
    };

export interface WebhookService {
  receive(delivery: WebhookDelivery): Promise<WebhookResult>;
  /** Deletes delivery records older than the retention window; returns how many. */
  purge(at?: Date): Promise<number>;
  /** Runs the due merge checks (`merge-checks.ts`); returns how many pull requests were read. */
  checkMerges(at?: Date): Promise<number>;
}

export interface WebhookDeps extends GitFlowDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly secrets: SecretBox;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  /** For the CI run links after a completed check suite; absent = skipped. */
  readonly github?: GitHubClient;
}

/** `sha256=<hex>` of the raw body, compared in constant time. */
export function verifySignature(
  secret: string,
  body: Uint8Array,
  signature: string | null,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface PullRequestEvent {
  readonly action?: string;
  readonly pull_request?: GitHubPullRequestPayload;
  readonly repository?: { readonly full_name?: string };
}

async function linkByRules(
  deps: WebhookDeps,
  tx: Tx,
  pr: Awaited<ReturnType<typeof upsertPullRequest>>['pr'],
  body: string | null,
): Promise<string[]> {
  const prefix = await deps.settings.issuePrefix(tx.conn);
  const match = matchIssueIdentifiers({
    headRef: pr.headRef,
    title: pr.title,
    body,
    prefix,
  });
  const linked: string[] = [];
  for (const identifier of match.identifiers) {
    const issue = await findIssue(tx.conn, identifier);
    if (!issue) continue;
    if (
      await linkPullRequest(tx, deps, {
        issue,
        pr,
        linkedByType: 'system',
        actor: SYSTEM_ACTOR,
      })
    )
      linked.push(issue.id);
  }
  return linked;
}

async function handlePullRequest(
  deps: WebhookDeps,
  tx: Tx,
  payload: PullRequestEvent,
  connectionId: string,
): Promise<boolean> {
  const repo = payload.repository?.full_name;
  const raw = payload.pull_request;
  if (!PULL_REQUEST_ACTIONS.has(payload.action ?? '') || !repo || !raw?.number)
    return false;
  const snapshot = snapshotFromPayload(raw, repo, raw.number);
  const { pr, previous } = await upsertPullRequest(
    tx,
    deps.ids,
    snapshot,
    connectionId,
  );
  const newlyLinked = await linkByRules(deps, tx, pr, snapshot.body);
  const links = await linksOfPullRequest(tx.conn, pr.id);
  for (const link of links)
    tx.emit({ type: 'issue.changed', issueId: link.issueId });
  await onPullRequestStateChanged(deps, tx, pr, previous);
  if (pr.state === 'open' && !pr.draft) {
    const reviewIssueIds = REVIEW_ACTIONS.has(payload.action ?? '')
      ? links.map((link) => link.issueId)
      : newlyLinked;
    await requestReviews(tx, pr, unique(reviewIssueIds));
  }
  await reportPullRequestSignals(deps, tx, pr);
  if (MERGE_CHECK_ACTIONS.has(payload.action ?? ''))
    await scheduleMergeChecks(deps, tx, { pullRequestId: pr.id });
  return true;
}

async function updateCi(
  deps: WebhookDeps,
  tx: Tx,
  repo: string | undefined,
  sha: string | undefined,
  state: PullRequestCiState | null,
): Promise<boolean> {
  if (!repo || !sha || !state) return false;
  const prs = await tx.conn.query
    .selectFrom('pullRequests')
    .select('id')
    .where('repo', '=', repo)
    .where('headSha', '=', sha)
    .execute();
  if (prs.length === 0) return true;
  const ids = prs.map((row) => String(row.id));
  await tx.conn.query
    .updateTable('pullRequests')
    .set({ ciState: state, updatedAt: now() })
    .where('id', 'in', ids)
    .execute();
  for (const id of ids) {
    for (const link of await linksOfPullRequest(tx.conn, id))
      tx.emit({ type: 'issue.changed', issueId: link.issueId });
    const pr = await findPullRequestById(tx.conn, id);
    if (pr) await reportPullRequestSignals(deps, tx, pr);
  }
  return true;
}

/** A push to `refs/heads/<branch>`: merge checks for the open pull requests based on it. */
async function handlePush(
  deps: WebhookDeps,
  tx: Tx,
  repo: string | undefined,
  ref: unknown,
): Promise<boolean> {
  if (!repo || typeof ref !== 'string' || !ref.startsWith('refs/heads/'))
    return false;
  await scheduleMergeChecks(deps, tx, {
    repo,
    baseRef: ref.slice('refs/heads/'.length),
  });
  return true;
}

async function dispatch(
  deps: WebhookDeps,
  tx: Tx,
  event: string,
  payload: Record<string, unknown>,
  connectionId: string,
): Promise<boolean> {
  const repo = (payload.repository as { full_name?: string } | undefined)
    ?.full_name;
  switch (event) {
    case 'ping':
      return true;
    case 'pull_request':
      return handlePullRequest(deps, tx, payload, connectionId);
    case 'check_suite': {
      const suite = payload.check_suite as
        | { head_sha?: string; status?: unknown; conclusion?: unknown }
        | undefined;
      if (payload.action !== 'completed') return false;
      return updateCi(
        deps,
        tx,
        repo,
        suite?.head_sha,
        ciStateOfCheckSuite(suite?.status, suite?.conclusion),
      );
    }
    case 'status':
      return updateCi(
        deps,
        tx,
        repo,
        typeof payload.sha === 'string' ? payload.sha : undefined,
        ciStateOfStatus(payload.state),
      );
    case 'push':
      return handlePush(deps, tx, repo, payload.ref);
    default:
      return false;
  }
}

/** The head commit's Actions run and screenshots links, for every stored PR at that head. Never throws. */
async function backfillCiLinks(
  deps: WebhookDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const repo = (payload.repository as { full_name?: string } | undefined)
    ?.full_name;
  const sha = (payload.check_suite as { head_sha?: string } | undefined)
    ?.head_sha;
  if (!deps.github || !repo || !sha) return;
  try {
    const credentials = credentialsOf(
      await loadConnection(deps.tx.read(), deps.secrets),
    );
    if (!credentials) return;
    const links = await deps.github.getLatestCiRun(credentials, repo, sha);
    if (!links) return;
    await deps.tx.run(async (tx) => {
      const rows = await tx.conn.query
        .selectFrom('pullRequests')
        .select('id')
        .where('repo', '=', repo)
        .where('headSha', '=', sha)
        .execute();
      if (rows.length === 0) return;
      const ids = rows.map((row) => String(row.id));
      await tx.conn.query
        .updateTable('pullRequests')
        .set({
          ciRunUrl: links.runUrl,
          screenshotsUrl: links.screenshotsUrl,
          updatedAt: now(),
        })
        .where('id', 'in', ids)
        .execute();
      for (const id of ids)
        for (const link of await linksOfPullRequest(tx.conn, id))
          tx.emit({ type: 'issue.changed', issueId: link.issueId });
    });
  } catch {
    // Links are a convenience; the CI state itself came with the delivery.
  }
}

async function recordDelivery(
  tx: Tx,
  ids: IdSource,
  deliveryId: string,
): Promise<boolean> {
  const timestamp = now();
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('webhookDeliveries')
        .values({
          id: ids.next(),
          provider: 'github',
          deliveryId: deliveryId.slice(0, 128),
          receivedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

async function receive(
  deps: WebhookDeps,
  delivery: WebhookDelivery,
): Promise<WebhookResult> {
  const connection = await loadConnection(deps.tx.read(), deps.secrets);
  if (
    !connection?.webhookSecret ||
    !verifySignature(
      connection.webhookSecret,
      delivery.body,
      delivery.signature,
    )
  )
    return { status: 'invalidSignature' };
  if (!delivery.deliveryId) return { status: 'missingDelivery' };
  const deliveryId = delivery.deliveryId;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(
      Buffer.from(delivery.body).toString('utf8'),
    ) as unknown;
    if (parsed && typeof parsed === 'object')
      payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const event = delivery.event ?? '';
  const result = await deps.tx.run(async (tx): Promise<WebhookResult> => {
    if (!(await recordDelivery(tx, deps.ids, deliveryId)))
      return { status: 'duplicate' };
    const handled = await dispatch(deps, tx, event, payload, connection.id);
    await tx.conn.query
      .updateTable('gitConnections')
      .set({ lastEventAt: now() })
      .where('id', '=', connection.id)
      .execute();
    return { status: 'processed', event, ignored: !handled };
  });
  if (
    result.status === 'processed' &&
    !result.ignored &&
    event === 'check_suite'
  )
    await backfillCiLinks(deps, payload);
  return result;
}

export function createWebhookService(deps: WebhookDeps): WebhookService {
  return {
    receive: (delivery) => receive(deps, delivery),
    async purge(at = new Date()) {
      const before = new Date(
        at.getTime() - WEBHOOK_RETENTION_DAYS * 24 * 3600 * 1000,
      );
      const result = await deps.tx
        .read()
        .query.deleteFrom('webhookDeliveries')
        .where('receivedAt', '<', before)
        .execute();
      return result.deletedCount ?? 0;
    },
    checkMerges: (at) => runMergeChecks(deps, at),
  };
}
