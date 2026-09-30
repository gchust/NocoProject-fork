/**
 * Test doubles and the router builder shared by `np-routes.test.ts` and `np-routes-iter2.test.ts`: the NocoProject
 * route contributions built through their real factories over a container of doubles, with a header-based fake
 * of the authentication plugin.
 */
import { vi } from 'vitest';
import { authenticationToken } from '@nocobase/app-plugin-authentication';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import type { AppApiRouteContribution } from '@nocobase/app-server/router';
import { ServiceContainer } from '@nocobase/service-provider';
import type { MiddlewareHandler } from 'hono';

import { conflict, notFound } from '../../server/modules/shared/errors.ts';
import {
  npAgentEnvServiceToken,
  npAgentIssueServiceToken,
  npAgentServiceToken,
  npAttachmentServiceToken,
  npInvitationServiceToken,
  npRoleServiceToken,
  npApprovalGatewayToken,
  npGitConnectionServiceToken,
  npIntakeServiceToken,
  npPullRequestServiceToken,
  npReactionServiceToken,
  npSkillServiceToken,
  npUsageServiceToken,
  npWorkspaceSettingsServiceToken,
  npDeliveryServiceToken,
  npChecklistServiceToken,
  npWorkflowProposalServiceToken,
  npDesignServiceToken,
  npPmActServiceToken,
  npPmAgentServiceToken,
  npPmConversationsToken,
  npPmServiceToken,
  npPullRequestMergeServiceToken,
  npKnowledgeServiceToken,
  npMetricsServiceToken,
  npClaimServiceToken,
  npCommentServiceToken,
  npDependencyServiceToken,
  npInboxServiceToken,
  npLabelServiceToken,
  npMemberServiceToken,
  npProposalServiceToken,
  npWorkflowServiceToken,
  npIssueQueriesToken,
  npIssueServiceToken,
  npProjectServiceToken,
  npRunEventServiceToken,
  npRunQueriesToken,
  npRunRecoveryServiceToken,
  npRunServiceToken,
  npRunTokenServiceToken,
  npRuntimeServiceToken,
  npComputerServiceToken,
  npDaemonWakeupsToken,
} from '../../server/providers/np.ts';

export const RUN_TOKEN = `npr_${'a'.repeat(40)}`;

/** Signed in when the request carries `x-test-user`; otherwise the plugin's 401. */
const testAuth = {
  required: (): MiddlewareHandler => async (context, next) => {
    const userId = context.req.header('x-test-user');
    if (!userId)
      return context.json(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        401,
      );
    context.set('auth', {
      user: {
        id: userId,
        name: `User ${userId}`,
        email: `${userId}@example.com`,
      },
      session: {},
    });
    await next();
  },
  optional: (): MiddlewareHandler => async (_context, next) => next(),
};

/**
 * The authorization plugin as far as the browser guard needs it (NP-117): a request context for the signed-in user
 * that permits nothing. The services here are doubles, so no check reaches it.
 */
const testAuthz = {
  middleware: (): MiddlewareHandler => async (context, next) => {
    const auth = context.get('auth') as { user: { id: string } } | undefined;
    context.set('authz', {
      identity: { principal: { type: 'user', id: auth?.user.id ?? '' } },
      can: async () => false,
      // NP-153: `npAccess` resolves the business scopes up front; every action is denied here.
      authorize: async () => ({ effect: 'deny', reasons: [] }),
    });
    await next();
  },
};

export const PENDING = { id: 'ap1', status: 'pending', toStatus: 'done' };

export function createDoubles() {
  const issues = {
    create: vi.fn(),
    patch: vi.fn(
      async (_actor: unknown, id: string, body: { statusKey?: string }) => {
        if (body.statusKey === 'done')
          return {
            issue: { id, statusKey: 'in_review' },
            pendingApproval: PENDING,
          };
        throw conflict('REVISION_CONFLICT', 'Issue is at revision 3.');
      },
    ),
    agentSetStatusGated: vi.fn(
      async (_actor: unknown, id: string, statusKey: string) =>
        statusKey === 'done'
          ? { issue: { id, statusKey: 'in_review' }, pendingApproval: PENDING }
          : { issue: { id, statusKey }, pendingApproval: null },
    ),
  };
  const issueQueries = {
    list: vi.fn(async () => [{ id: 'i1', identifier: 'NP-1' }]),
    page: vi.fn(async () => ({
      data: [{ id: 'i1', identifier: 'NP-1' }],
      nextCursor: null,
    })),
    detail: vi.fn(),
    forAgent: vi.fn(async (id: string) => ({
      id: id === 'NP-1' ? 'i1' : id,
      identifier: 'NP-1',
    })),
    forAgentScoped: vi.fn(async (_auth: unknown, id: string) => ({ id })),
    agentReadable: vi.fn(async (_auth: unknown, id: string) => ({
      id: id === 'NP-1' ? 'i1' : id,
    })),
    agentContext: vi.fn(async (auth: { runId: string }) => ({
      run: { id: auth.runId },
    })),
  };
  const comments = {
    create: vi.fn(async () => ({ comment: { id: 'c1' }, triggered: [] })),
    listForAgent: vi.fn(async () => []),
  };
  const runtimes = {
    register: vi.fn(async () => ({ runtimes: [] })),
    heartbeat: vi.fn(async () => 1),
    deregister: vi.fn(async () => 1),
    list: vi.fn(async () => []),
    runAccess: vi.fn(async (runId: string) =>
      runId === 'mine' ? 'ok' : runId === 'theirs' ? 'forbidden' : 'notFound',
    ),
  };
  const runs = {
    daemonStatus: vi.fn(async () => ({
      status: 'running',
      cancelRequested: false,
    })),
    extendLease: vi.fn(),
  };
  const runTokens = {
    authorize: vi.fn(async () => {}),
    verify: vi.fn(async (token: string) =>
      token === RUN_TOKEN
        ? { runId: 'r1', agentId: 'a1', actorUserId: 'u1', issueId: 'i1' }
        : null,
    ),
  };
  const claims = { claim: vi.fn(async () => ({ runs: [] })) };
  const members = {
    ensure: vi.fn(async () => 'member'),
    list: vi.fn(async () => []),
    preferences: vi.fn(async () => ({ inboxChime: true })),
    updatePreferences: vi.fn(async (_userId: string, input: unknown) => ({
      inboxChime: true,
      ...(input as object),
    })),
  };
  const agentIssues = {
    create: vi.fn(async () => ({ issue: { id: 'i9' }, proposal: null })),
    children: vi.fn(async () => []),
    addDependency: vi.fn(async () => ({ dependencyId: 'd1' })),
    removeDependency: vi.fn(async () => undefined),
  };
  const inbox = {
    list: vi.fn(async () => ({
      data: [],
      unread: { decision: 0, info: 0 },
      nextCursor: null,
    })),
    unreadCount: vi.fn(async () => ({ decision: 1, info: 2 })),
    pendingCount: vi.fn(async () => ({ decision: 3 })),
    mark: vi.fn(),
    readAll: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const pullRequests = {
    list: vi.fn(async () => []),
    forIssue: vi.fn(async () => []),
    agentLink: vi.fn(async (_actor: unknown, _issue: unknown, url: string) => ({
      view: { id: 'pr1', url },
      created: url.endsWith('/1'),
    })),
  };
  const runQueries = {
    assertVisible: vi.fn(async (_actor: unknown, runId: string) => {
      if (runId !== 'visible') throw notFound('Run');
    }),
    detail: vi.fn(async (runId: string) => ({ id: runId })),
  };
  const connections = {
    view: vi.fn(async (_actor: unknown, webhookUrl: string) => ({
      configured: false,
      webhookUrl,
    })),
  };
  return {
    issues,
    issueQueries,
    comments,
    runtimes,
    runs,
    runTokens,
    claims,
    members,
    agentIssues,
    inbox,
    pullRequests,
    connections,
    runQueries,
  };
}

export async function build(
  contribution: AppApiRouteContribution<Application>,
  doubles = createDoubles(),
) {
  const container = new ServiceContainer();
  container.instance(authenticationToken, testAuth as never);
  container.instance(authorizationToken, testAuthz as never);
  container.instance(npProjectServiceToken, {
    list: async () => [],
    create: vi.fn(),
  } as never);
  container.instance(npIssueServiceToken, doubles.issues as never);
  container.instance(npIssueQueriesToken, doubles.issueQueries as never);
  container.instance(npCommentServiceToken, doubles.comments as never);
  container.instance(npAgentServiceToken, { list: async () => [] } as never);
  container.instance(npRuntimeServiceToken, doubles.runtimes as never);
  // NP-150: no computer credential in these tests (the personal-key path); an idle wakeup long poll.
  container.instance(npComputerServiceToken, {} as never);
  container.instance(npDaemonWakeupsToken, {
    wait: async () => ({ cursor: 0, events: [] }),
    close: () => undefined,
  } as never);
  container.instance(npRunServiceToken, doubles.runs as never);
  container.instance(npRunQueriesToken, doubles.runQueries as never);
  container.instance(npRunEventServiceToken, {
    list: async () => ({ data: [], last: -1 }),
  } as never);
  container.instance(npRunRecoveryServiceToken, {} as never);
  container.instance(npClaimServiceToken, doubles.claims as never);
  container.instance(npRunTokenServiceToken, doubles.runTokens as never);
  container.instance(npMemberServiceToken, doubles.members as never);
  container.instance(npAgentIssueServiceToken, doubles.agentIssues as never);
  container.instance(npInboxServiceToken, doubles.inbox as never);
  container.instance(npWorkflowServiceToken, { list: async () => [] } as never);
  container.instance(npLabelServiceToken, { list: async () => [] } as never);
  container.instance(npDependencyServiceToken, {} as never);
  container.instance(npProposalServiceToken, {} as never);
  container.instance(npPullRequestServiceToken, doubles.pullRequests as never);
  container.instance(npGitConnectionServiceToken, doubles.connections as never);
  container.instance(npAgentEnvServiceToken, {} as never);
  container.instance(npApprovalGatewayToken, {
    listPending: async () => [],
  } as never);
  container.instance(npIntakeServiceToken, {} as never);
  container.instance(npReactionServiceToken, {} as never);
  container.instance(npSkillServiceToken, { list: async () => [] } as never);
  container.instance(npUsageServiceToken, {} as never);
  container.instance(npWorkspaceSettingsServiceToken, {} as never);
  container.instance(npKnowledgeServiceToken, {
    list: async () => [],
    projectDocs: async () => [],
  } as never);
  container.instance(npMetricsServiceToken, {} as never);
  container.instance(npDeliveryServiceToken, {} as never);
  container.instance(npDesignServiceToken, {} as never);
  container.instance(npPmServiceToken, {} as never);
  container.instance(npPmConversationsToken, {
    detailOf: async () => null,
  } as never);
  container.instance(npPmAgentServiceToken, {} as never);
  container.instance(npPmActServiceToken, {} as never);
  container.instance(npPullRequestMergeServiceToken, {} as never);
  container.instance(npChecklistServiceToken, {} as never);
  container.instance(npWorkflowProposalServiceToken, {} as never);
  container.instance(npAttachmentServiceToken, {} as never);
  container.instance(npInvitationServiceToken, {} as never);
  container.instance(npRoleServiceToken, {} as never);
  const router = await contribution.createRouter({
    container,
    publicBasePath: '/main',
    config: { get: () => undefined },
  } as unknown as Application);
  return { router, doubles };
}

export const signedIn = { 'x-test-user': 'u1' };
export const withRunToken = { authorization: `Bearer ${RUN_TOKEN}` };
export const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
