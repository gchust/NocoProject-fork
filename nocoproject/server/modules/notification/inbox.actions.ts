/**
 * What a member can do straight from an inbox item (docs/phase1/iteration-3-contract.md §E): `payload.actions`,
 * computed when the item is read, so items written before iteration 3 get them too.
 *
 * | type               | actions                                                                    |
 * | ------------------ | -------------------------------------------------------------------------- |
 * | review_requested   | accept (deliveries/accept, optional comment), requestChanges (comment), open |
 * | agent_blocked      | reply (comment → body.content), reassign (opens the issue), open           |
 * | proposal_pending   | acceptAll (on the parent issue), open                                      |
 * | approval_pending   | approve, reject (comment), open                                            |
 * | batch_done         | open                                                                       |
 * | pr_review          | merge (confirm dialog; for whoever may merge, NP-85), openPr (external), open |
 * | knowledge_proposal | accept, reject (optional comment), openDoc (when the document exists), open |
 * | design_review      | approve (optional comment), requestChanges (comment), open (iteration 4)   |
 * | workflow_proposal  | accept, reject (optional comment), open (NP-77 stage 2)                    |
 * | anything else      | open (when the item names an issue)                                        |
 *
 * A resolved item keeps only its navigation actions (GET). POST paths are relative to `/api`; GET paths are in-app
 * routes, or external URLs when `external` is set.
 */
import type {
  InboxActionV4,
  InboxItemTypeV7,
  PullRequestMergeBlocker,
} from '../shared/protocol.js';

type InboxAction = InboxActionV4;

/** A `pr_review` card whose recipient may merge (`inbox.pr-merge.ts`). */
export interface MergeActionSource {
  readonly pullRequestId: string;
  /** From the stored snapshot; null = looks mergeable */
  readonly disabledReason: PullRequestMergeBlocker | null;
}

export interface ActionSource {
  readonly type: InboxItemTypeV7;
  readonly issueId: string | null;
  readonly issueIdentifier: string | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly resolvedAt: string | null;
  readonly merge?: MergeActionSource | null;
}

const label = (key: string) => `np.inboxActions.${key}`;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function post(
  key: string,
  kind: InboxAction['kind'],
  path: string,
  extra: Partial<InboxAction> = {},
): InboxAction {
  return { key, label: label(key), kind, method: 'POST', path, ...extra };
}

function typeActions(source: ActionSource, issueId: string): InboxAction[] {
  const payload = source.payload ?? {};
  const issuePath = `/np/issues/${encodeURIComponent(issueId)}`;
  switch (source.type) {
    case 'review_requested':
      return [
        post('accept', 'primary', `${issuePath}/deliveries/accept`, {
          commentField: 'comment',
        }),
        post(
          'requestChanges',
          'secondary',
          `${issuePath}/deliveries/request-changes`,
          { needsComment: true, commentField: 'comment' },
        ),
      ];
    case 'agent_blocked':
      return [
        post('reply', 'primary', `${issuePath}/comments`, {
          needsComment: true,
          commentField: 'content',
        }),
      ];
    case 'proposal_pending': {
      const parent = text(payload.parentIssueId) ?? issueId;
      return [
        post(
          'acceptAll',
          'primary',
          `/np/issues/${encodeURIComponent(parent)}/proposals/accept-all`,
        ),
      ];
    }
    case 'approval_pending': {
      const requestId = text(payload.requestId);
      if (!requestId) return [];
      const path = `/np/approvals/${encodeURIComponent(requestId)}`;
      return [
        post('approve', 'primary', `${path}/approve`),
        post('reject', 'danger', `${path}/reject`, {
          needsComment: true,
          commentField: 'comment',
        }),
      ];
    }
    case 'knowledge_proposal': {
      const proposalId = text(payload.proposalId);
      if (!proposalId) return [];
      const path = `/np/knowledge/proposals/${encodeURIComponent(proposalId)}`;
      return [
        post('accept', 'primary', `${path}/accept`, {
          commentField: 'comment',
        }),
        post('reject', 'danger', `${path}/reject`, {
          commentField: 'comment',
        }),
      ];
    }
    case 'workflow_proposal': {
      const proposalId = text(payload.proposalId);
      if (!proposalId) return [];
      const path = `/np/workflows/proposals/${encodeURIComponent(proposalId)}`;
      return [
        post('accept', 'primary', `${path}/accept`, {
          commentField: 'comment',
        }),
        post('reject', 'danger', `${path}/reject`, {
          commentField: 'comment',
        }),
      ];
    }
    case 'design_review':
      return [
        post('approve', 'primary', `${issuePath}/design/approve`, {
          commentField: 'comment',
        }),
        post(
          'requestChanges',
          'secondary',
          `${issuePath}/design/request-changes`,
          { needsComment: true, commentField: 'comment' },
        ),
      ];
    case 'pr_review': {
      const merge = source.merge;
      if (!merge) return [];
      return [
        post(
          'merge',
          'primary',
          `${issuePath}/pull-requests/${encodeURIComponent(merge.pullRequestId)}/merge`,
          {
            confirm: 'prMerge',
            pullRequestId: merge.pullRequestId,
            ...(merge.disabledReason
              ? { disabledReason: merge.disabledReason }
              : {}),
          },
        ),
      ];
    }
    default:
      return [];
  }
}

function navigationActions(source: ActionSource): InboxAction[] {
  const payload = source.payload ?? {};
  const actions: InboxAction[] = [];
  const url = text(payload.url);
  if (source.type === 'pr_review' && url)
    actions.push({
      key: 'openPr',
      label: label('openPr'),
      // The merge action, when offered, is the one primary button.
      kind: source.merge && !source.resolvedAt ? 'secondary' : 'primary',
      method: 'GET',
      path: url,
      external: true,
    });
  const docId = text(payload.docId);
  if (
    (source.type === 'knowledge_proposal' ||
      source.type === 'knowledge_decided') &&
    docId
  )
    actions.push({
      key: 'openDoc',
      label: label('openDoc'),
      kind: 'secondary',
      method: 'GET',
      path: `/knowledge/${encodeURIComponent(docId)}`,
    });
  const ref =
    source.issueIdentifier ?? text(payload.identifier) ?? source.issueId;
  if (!ref) return actions;
  const issueRoute = `/issues/${encodeURIComponent(ref)}`;
  if (source.type === 'agent_blocked')
    actions.push({
      key: 'reassign',
      label: label('reassign'),
      kind: 'secondary',
      method: 'GET',
      path: issueRoute,
      opensIssue: true,
    });
  actions.push({
    key: 'open',
    label: label('open'),
    kind: 'secondary',
    method: 'GET',
    path: issueRoute,
    opensIssue: true,
  });
  return actions;
}

export function inboxActions(source: ActionSource): InboxAction[] {
  const writes =
    source.resolvedAt || !source.issueId
      ? []
      : typeActions(source, source.issueId);
  return [...writes, ...navigationActions(source)];
}
