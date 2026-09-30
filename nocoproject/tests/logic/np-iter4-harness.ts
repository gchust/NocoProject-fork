import { AGENT_CAPABILITIES } from '../../server/modules/shared/protocol.capabilities.js';
/**
 * Helpers shared by the iteration 4 integration tests (`np-process`, `np-pm`): the real browser route factories
 * (issues with the design decisions, project manager conversation, settings, agents, intake, inbox) behind a
 * stand-in for `auth.required()`, the agent API (including the design proposal and the project manager's reads)
 * behind the real run-token guard, and agent fixtures.
 */
import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { createAgentRoutes } from '../../server/modules/agent/agent.routes.ts';
import {
  createAgentDesignRoutes,
  createDesignRoutes,
} from '../../server/modules/issue/design.routes.ts';
import { createIntakeRoutes } from '../../server/modules/intake/intake.routes.ts';
import { createIssueRoutes } from '../../server/modules/issue/issue.routes.ts';
import { createCommentRoutes } from '../../server/modules/collaboration/comment.routes.ts';
import { createInboxRoutes } from '../../server/modules/notification/inbox.routes.ts';
import {
  createAgentPmRoutes,
  createPmAgentRoutes,
  createPmRoutes,
} from '../../server/modules/pm/pm.routes.ts';
import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../../server/modules/run/agent-api.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import { guarded, npRouter } from '../../server/modules/shared/http.ts';
import type { InboxItemV4 } from '../../server/modules/shared/protocol.ts';
import { createSettingsRoutes } from '../../server/modules/system/settings.routes.ts';
import type { ApiCall, ApiResponse } from './np-iter3-harness.ts';

export type { ApiCall } from './np-iter3-harness.ts';

function browserRouter(services: NpServices, as: Actor): Hono<AuthEnv> {
  const root = npRouter<AuthEnv>();
  root.use('*', async (context, next) => {
    context.set('auth', {
      user: { id: as.id ?? '', name: as.id ?? '', email: `${as.id}@x` },
      session: {},
    } as never);
    await next();
  });
  root.route(
    '/np/issues',
    createIssueRoutes({
      issues: services.issues,
      queries: services.issueQueries,
      deliveries: services.deliveries,
      slowLog: { warn: () => undefined },
    }),
  );
  root.route(
    '/np/issues',
    createCommentRoutes(services.comments, services.pmConversations),
  );
  root.route('/np/issues', createDesignRoutes(services.design));
  root.route('/np/pm', createPmRoutes(services.pmConversations));
  root.route('/np/me/pm-agent', createPmAgentRoutes(services.pmAgents));
  root.route('/np/settings', createSettingsRoutes(services.workspaceSettings));
  root.route('/np/agents', createAgentRoutes(services.agents));
  root.route('/np/intake', createIntakeRoutes(services.intake));
  root.route('/np/inbox', createInboxRoutes(services.inbox));
  return root;
}

async function call<T>(
  router: { request: Hono['request'] },
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await router.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ApiResponse<T>['body'],
  };
}

/** Calls the browser API as `as`. */
export function browserApi4(services: NpServices, as: Actor): ApiCall {
  const router = browserRouter(services, as);
  return (method, path, body) => call(router, {}, method, path, body);
}

/** Calls `/np/agent/*` (paths relative to it) with a run token, including `design-proposal` and `pm/*`. */
export function agentApi4(services: NpServices, token: string): ApiCall {
  const router = guarded(
    [runTokenAuth(services.runTokens)],
    createAgentApiRoutes({
      issues: services.issues,
      queries: services.issueQueries,
      comments: services.comments,
      agentIssues: services.agentIssues,
      pullRequests: services.pullRequests,
    }),
    createAgentDesignRoutes(services.design),
    createAgentPmRoutes(services.pm, {
      act: services.pmAct,
      conversations: services.pmConversations,
    }),
  );
  return (method, path, body) =>
    call(router, { authorization: `Bearer ${token}` }, method, path, body);
}

/** An echo agent on `runtimeId` with the given kind (and reasoning effort). */
export async function createKindAgent(
  services: NpServices,
  owner: Actor,
  runtimeId: string,
  name: string,
  kind: 'coder' | 'manager',
  reasoningEffort: string | null = null,
): Promise<string> {
  const agent = await services.agents.create(owner, {
    name,
    capabilities:
      kind === 'manager'
        ? [
            'context.read',
            'workspace.read',
            'comment.create',
            'knowledge.propose',
          ]
        : AGENT_CAPABILITIES.filter((c) => c !== 'workspace.read'),
    instructions: `You are ${name}.`,
    runtimeId,
    provider: 'echo',
    access: 'everyone',
    kind,
    reasoningEffort: reasoningEffort as never,
  });
  return agent.id;
}

/** The unresolved inbox items of `user` of one type. */
export async function openItems(
  services: NpServices,
  user: Actor,
  type: string,
): Promise<InboxItemV4[]> {
  const page = await services.inbox.list(user, { resolved: 'false' });
  return page.data.filter((item) => item.type === type) as InboxItemV4[];
}
