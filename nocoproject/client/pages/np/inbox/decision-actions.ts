import type { InboxItem } from '../types.js';
import type { InboxDecisionAction, InboxDecisionKind } from '../types-iter3.js';

/**
 * The inline actions of a decision card (iteration 3 §E). The server sends them in `payload.actions`; an item from an
 * older server (no `actions`) gets the same defaults the contract lists per type, built here from its payload.
 */

const KINDS: ReadonlySet<string> = new Set(['primary', 'secondary', 'danger']);
const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
]);

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** One action from the payload, or null when it is not usable (no key, or nothing to do). */
function readAction(value: unknown): InboxDecisionAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const key = text(raw.key);
  if (!key) return null;
  const kind = text(raw.kind);
  const method = text(raw.method)?.toUpperCase();
  const action: InboxDecisionAction = {
    key,
    label: text(raw.label) ?? `np.inboxActions.${key}`,
    kind: kind && KINDS.has(kind) ? (kind as InboxDecisionKind) : 'secondary',
    method:
      method && METHODS.has(method)
        ? (method as InboxDecisionAction['method'])
        : undefined,
    path: text(raw.path) ?? undefined,
    url: text(raw.url) ?? undefined,
    body:
      raw.body && typeof raw.body === 'object'
        ? (raw.body as Record<string, unknown>)
        : undefined,
    needsComment: raw.needsComment === true,
    commentField: text(raw.commentField) ?? undefined,
    opensIssue: raw.opensIssue === true,
    external: raw.external === true,
    ...(raw.confirm === 'prMerge' ? { confirm: 'prMerge' as const } : {}),
    ...(text(raw.pullRequestId)
      ? { pullRequestId: text(raw.pullRequestId) ?? undefined }
      : {}),
    ...(text(raw.disabledReason)
      ? { disabledReason: text(raw.disabledReason) ?? undefined }
      : {}),
  };
  const actionable =
    action.opensIssue || !!action.path || !!externalUrl(action);
  // A GET action is navigation, never a request (server protocol §5).
  if (action.method === 'GET' && !action.path && !action.url) return null;
  return actionable ? action : null;
}

const open = (): InboxDecisionAction => ({
  key: 'open',
  label: 'np.inboxActions.open',
  kind: 'secondary',
  opensIssue: true,
});

const post = (
  key: string,
  path: string,
  kind: InboxDecisionKind,
  extra: Partial<InboxDecisionAction> = {},
): InboxDecisionAction => ({
  key,
  label: `np.inboxActions.${key}`,
  kind,
  method: 'POST',
  path,
  ...extra,
});

/** The contract's per-type actions (§E table), for an item whose payload carries none. */
export function defaultInboxActions(
  item: Pick<InboxItem, 'type' | 'issueId' | 'payload'>,
): InboxDecisionAction[] {
  const payload = item.payload ?? {};
  const issue = item.issueId ? encodeURIComponent(item.issueId) : null;
  const type = item.type as string;
  switch (type) {
    case 'review_requested':
      return issue
        ? [
            post('accept', `/np/issues/${issue}/deliveries/accept`, 'primary'),
            post(
              'requestChanges',
              `/np/issues/${issue}/deliveries/request-changes`,
              'secondary',
              { needsComment: true },
            ),
            open(),
          ]
        : [];
    case 'agent_blocked':
      return issue
        ? [
            post('reply', `/np/issues/${issue}/comments`, 'primary', {
              needsComment: true,
              commentField: 'content',
            }),
            {
              key: 'reassign',
              label: 'np.inboxActions.reassign',
              kind: 'secondary',
              opensIssue: true,
            },
            open(),
          ]
        : [];
    case 'proposal_pending':
      return issue
        ? [
            post(
              'acceptAll',
              `/np/issues/${issue}/proposals/accept-all`,
              'primary',
            ),
            open(),
          ]
        : [];
    case 'approval_pending': {
      const approvalId =
        text(payload.approvalId) ??
        text(payload.approvalRequestId) ??
        text(payload.requestId);
      if (!approvalId) return issue ? [open()] : [];
      const id = encodeURIComponent(approvalId);
      return [
        post('approve', `/np/approvals/${id}/approve`, 'primary'),
        post('reject', `/np/approvals/${id}/reject`, 'danger', {
          needsComment: true,
        }),
        ...(issue ? [open()] : []),
      ];
    }
    case 'pr_review': {
      const url = text(payload.url) ?? text(payload.prUrl);
      return [
        ...(url
          ? [
              {
                key: 'openPr',
                label: 'np.inboxActions.openPr',
                kind: 'primary' as const,
                url,
              },
            ]
          : []),
        ...(issue ? [open()] : []),
      ];
    }
    // Iteration 4 §B: the owner approves the design (development starts) or sends it back with a comment.
    case 'design_review':
      return issue
        ? [
            post('approve', `/np/issues/${issue}/design/approve`, 'primary'),
            post(
              'requestChanges',
              `/np/issues/${issue}/design/request-changes`,
              'secondary',
              { needsComment: true },
            ),
            open(),
          ]
        : [];
    case 'knowledge_proposal': {
      const proposalId = text(payload.proposalId);
      if (!proposalId) return issue ? [open()] : [];
      const id = encodeURIComponent(proposalId);
      return [
        post('accept', `/np/knowledge/proposals/${id}/accept`, 'primary'),
        post('reject', `/np/knowledge/proposals/${id}/reject`, 'danger'),
        ...(issue ? [open()] : []),
      ];
    }
    default:
      return issue ? [open()] : [];
  }
}

/** The actions a decision card offers: the server's when present and usable, else the type defaults. */
export function readInboxActions(
  item: Pick<InboxItem, 'kind' | 'type' | 'issueId' | 'payload'>,
): InboxDecisionAction[] {
  if (item.kind !== 'decision') return [];
  const raw = item.payload?.actions;
  if (Array.isArray(raw)) {
    const actions = raw
      .map(readAction)
      .filter((action): action is InboxDecisionAction => action !== null);
    if (actions.length > 0) return actions;
  }
  return defaultInboxActions(item);
}

/** An `openPr`-style action: a link to another site, opened in a new tab. */
export function externalUrl(action: InboxDecisionAction): string | null {
  const candidate =
    action.url ??
    (action.path && (action.external || /^https?:\/\//u.test(action.path))
      ? action.path
      : null);
  return candidate && /^https?:\/\//u.test(candidate) ? candidate : null;
}

/**
 * The in-app page a navigation action opens (a GET with an application path such as `/issues/12` or
 * `/knowledge/k1`), or null when the action is a request or leaves the application.
 */
export function inAppPath(action: InboxDecisionAction): string | null {
  if (externalUrl(action)) return null;
  if (action.method === 'GET' && action.path?.startsWith('/')) {
    return action.path;
  }
  return null;
}

/** The API path for the request: `/np/…`, `np/…` or `/api/np/…` all become `np/…`. */
export function apiPath(path: string): string {
  return path.replace(/^\/+/u, '').replace(/^api\//u, '');
}

/**
 * The JSON body: the action's `body` with the comment merged in — as `content` when the body names it (a reply is
 * a comment), otherwise as `comment`. An empty comment is left out.
 */
export function actionBody(
  action: InboxDecisionAction,
  comment: string,
): Record<string, unknown> {
  const base = { ...(action.body ?? {}) };
  const trimmed = comment.trim();
  if (!trimmed) return base;
  if (action.commentField) return { ...base, [action.commentField]: trimmed };
  if ('content' in base || action.key === 'reply') {
    return { ...base, content: trimmed };
  }
  return { ...base, comment: trimmed };
}

/** Button variant per action kind. */
export function actionVariant(
  kind: InboxDecisionKind,
): 'default' | 'outline' | 'destructive' {
  return kind === 'primary'
    ? 'default'
    : kind === 'danger'
      ? 'destructive'
      : 'outline';
}

/** The item as it looks right after an action resolved it, for the optimistic list update. */
export function resolveLocally(item: InboxItem, now: string): InboxItem {
  return {
    ...item,
    resolvedAt: item.resolvedAt ?? now,
    readAt: item.readAt ?? now,
  };
}

/** NP-85: the issue and PR a `confirm: 'prMerge'` action merges (`/np/issues/<id>/pull-requests/<prId>/merge`). */
export function mergeTargetOf(
  action: InboxDecisionAction,
): { issueId: string; pullRequestId: string } | null {
  if (action.confirm !== 'prMerge' || !action.path) return null;
  const match = /^\/?np\/issues\/([^/]+)\/pull-requests\/([^/]+)\/merge$/u.exec(
    action.path,
  );
  if (!match?.[1] || !match[2]) return null;
  return {
    issueId: decodeURIComponent(match[1]),
    pullRequestId: action.pullRequestId ?? decodeURIComponent(match[2]),
  };
}
