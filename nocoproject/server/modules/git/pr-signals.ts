/**
 * The GitHub source of signals (protocol.phase2-signals.ts). The trigger module decides what a signal does; this file
 * only says what a stored pull request means for the issues linked to it.
 *
 * `reportPullRequestSignals` runs after every write of a snapshot — webhook deliveries, REST reads (link, refresh,
 * merge preflight) and the merge-check sweep — while the pull request is open:
 *
 * | stored state                         | report                                              |
 * | ------------------------------------ | --------------------------------------------------- |
 * | `ciState = failure`                  | `github.ciFailed`, key `<repo>#<number>@<headSha>`   |
 * | `ciState = success`                  | `github.ciFailed` resolved                           |
 * | `mergeableState = dirty`             | `github.conflict`, same key                          |
 * | any other known `mergeableState`     | `github.conflict` resolved                           |
 *
 * A workspace that never stored a GitHub signal rule pays one settings read here and nothing else.
 *
 * Merge checks: GitHub computes mergeability lazily and sends no webhook when a push to the base branch leaves an open
 * pull request conflicting. So while the conflict rule is on, a push to a branch, and a new head on a pull request,
 * mark the affected linked open pull requests for a REST read (`mergeCheckAfter`, run by `merge-checks.ts`).
 */
import type { Tx } from '../shared/db.js';
import { addSeconds, now } from '../shared/db.js';
import type { PullRequest, SignalKind } from '../shared/protocol.js';
import { SIGNAL_KIND_DEFAULTS } from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import { signalRuleOf } from '../system/signal-rules.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import { fillPlaceholders } from '../workflow/instruction.js';
import { linksOfPullRequest } from './git.records.js';

export const GITHUB_SIGNAL_SOURCE = 'github';
/** The first read waits a little: GitHub starts computing mergeability only after the push. */
export const MERGE_CHECK_DELAY_SECONDS = 20;

export interface PullRequestSignalDeps {
  readonly settings: SettingsService;
  readonly triggers: () => TriggerService;
}

/** Known and not a conflict: GitHub's `clean`, `unstable`, `blocked`, `behind`, `has_hooks`, `draft`. */
function mergeableKnown(state: string | null): boolean {
  return !!state && state !== 'unknown' && state !== 'dirty';
}

function variablesOf(pr: PullRequest): Record<string, string> {
  return {
    repo: pr.repo,
    number: String(pr.number),
    url: pr.url,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
  };
}

/** Reports what the stored snapshot of `pr` says to the issues linked to it (see the file comment). */
export async function reportPullRequestSignals(
  deps: PullRequestSignalDeps,
  tx: Tx,
  pr: PullRequest,
): Promise<void> {
  if (pr.state !== 'open' || !pr.headSha) return;
  const rules = (await deps.settings.read(tx.conn)).signalRules;
  const configured = (kind: SignalKind) => rules[kind] !== undefined;
  if (!configured('github.ciFailed') && !configured('github.conflict')) return;
  const links = await linksOfPullRequest(tx.conn, pr.id);
  if (links.length === 0) return;
  const key = `${pr.repo}#${pr.number}@${pr.headSha}`;
  const variables = variablesOf(pr);
  const reports: { kind: SignalKind; failing: boolean }[] = [];
  if (pr.ciState === 'failure' || pr.ciState === 'success')
    reports.push({
      kind: 'github.ciFailed',
      failing: pr.ciState === 'failure',
    });
  if (pr.mergeableState === 'dirty' || mergeableKnown(pr.mergeableState))
    reports.push({
      kind: 'github.conflict',
      failing: pr.mergeableState === 'dirty',
    });
  const triggers = deps.triggers();
  for (const { kind, failing } of reports) {
    if (!configured(kind)) continue;
    for (const link of links) {
      if (!failing) {
        await triggers.onSignalResolved(tx, {
          issueId: link.issueId,
          source: GITHUB_SIGNAL_SOURCE,
          kind,
          key,
        });
        continue;
      }
      const defaults = SIGNAL_KIND_DEFAULTS[kind];
      await triggers.onSignal(tx, {
        issueId: link.issueId,
        source: GITHUB_SIGNAL_SOURCE,
        kind,
        key,
        title: fillPlaceholders(defaults.title, variables),
        url: pr.url,
        defaultInstruction: defaults.instruction,
        variables,
      });
    }
  }
}

/**
 * Marks linked open pull requests for a merge check: those whose base is `baseRef` in `repo` (a push to that branch),
 * or the one with `pullRequestId` (a new head). Nothing while the conflict rule is off.
 */
export async function scheduleMergeChecks(
  deps: Pick<PullRequestSignalDeps, 'settings'>,
  tx: Tx,
  target:
    | { readonly repo: string; readonly baseRef: string }
    | { readonly pullRequestId: string },
): Promise<number> {
  const rules = (await deps.settings.read(tx.conn)).signalRules;
  if (!signalRuleOf(rules, 'github.conflict').enabled) return 0;
  let query = tx.conn.query
    .selectFrom('pullRequests')
    .select('id')
    .where('state', '=', 'open')
    .where('draft', '=', false);
  query =
    'pullRequestId' in target
      ? query.where('id', '=', target.pullRequestId)
      : query
          .where('repo', '=', target.repo)
          .where('baseRef', '=', target.baseRef);
  const candidates = (await query.execute()).map((row) => String(row.id));
  if (candidates.length === 0) return 0;
  const linked = await tx.conn.query
    .selectFrom('issuePullRequests')
    .select('pullRequestId')
    .where('pullRequestId', 'in', candidates)
    .execute();
  const ids = [...new Set(linked.map((row) => String(row.pullRequestId)))];
  if (ids.length === 0) return 0;
  await tx.conn.query
    .updateTable('pullRequests')
    .set({
      mergeCheckAfter: addSeconds(now(), MERGE_CHECK_DELAY_SECONDS),
      mergeCheckAttempts: 0,
    })
    .where('id', 'in', ids)
    .execute();
  return ids.length;
}
