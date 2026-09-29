import type { Context, Hono, MiddlewareHandler } from 'hono';

import type { CommentService } from '../collaboration/comment.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IssueQueries } from '../issue/issue.queries.js';
import type { IssueService } from '../issue/issue.service.js';
import type { Actor } from '../shared/activity.js';
import { NpError } from '../shared/errors.js';
import {
  bearerRunToken,
  errorBody,
  npRouter,
  queryInt,
  queryText,
  readJson,
} from '../shared/http.js';
import type {
  AgentCreateIssueRequest,
  AgentDependencyRequest,
  AgentPullRequestLinkRequest,
  CreateCommentRequest,
  StatusChangePendingResponse,
} from '../shared/protocol.js';
import type { AgentIssueService } from '../subtask/agent-issue.service.js';
import type { RunAuth, RunTokenService } from './token.js';

export interface RunTokenEnv {
  Variables: { runAuth: RunAuth };
}

/**
 * Run-token authentication for the agent API: `Authorization: Bearer npr_…`, not revoked, not expired, run not
 * terminal. Anything else is 401.
 */
export function runTokenAuth(
  tokens: RunTokenService,
): MiddlewareHandler<RunTokenEnv> {
  return async (context, next) => {
    const token = bearerRunToken(context);
    const auth = token ? await tokens.verify(token) : null;
    if (!auth) {
      return context.json(
        errorBody('INVALID_RUN_TOKEN', 'A valid run token is required.'),
        401,
      );
    }
    await tokens.authorize(auth, context.req.method, context.req.path);
    context.set('runAuth', auth);
    await next();
  };
}

function agentActor(context: Context<RunTokenEnv>): Actor {
  const auth = context.get('runAuth');
  return { type: 'agent', id: auth.agentId, runId: auth.runId };
}

function flag(context: Context, name: string): boolean {
  return ['1', 'true'].includes(queryText(context, name) ?? '');
}

/**
 * `/np/agent/*` (protocol.md §5, iteration-1 contract §D/§I, iteration-2 contract §C/§D/§K). Reads may address issues
 * in the run issue's project and issues without a project — anything else is 404;
 * comments, status writes and pull request links are limited to the issue of the token's run; sub-issues and
 * dependencies to that issue and its descendants. A status write held for approval answers 202. The iteration 4
 * design proposal is `createAgentDesignRoutes` (`issue/design.routes.ts`).
 */
export function createAgentApiRoutes(deps: {
  issues: IssueService;
  queries: IssueQueries;
  comments: CommentService;
  agentIssues: AgentIssueService;
  pullRequests: PullRequestService;
}): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();

  async function requireRunIssue(
    context: Context<RunTokenEnv>,
  ): Promise<string> {
    const issue = await deps.queries.forAgent(context.req.param('id') ?? '');
    if (issue.id !== context.get('runAuth').issueId) {
      throw new NpError(
        'forbidden',
        'ISSUE_NOT_IN_RUN',
        'A run token may only write to its own issue.',
      );
    }
    return issue.id;
  }

  routes.get('/context', async (context) =>
    context.json({
      data: await deps.queries.agentContext(context.get('runAuth')),
    }),
  );
  routes.get('/issues/:id', async (context) =>
    context.json({
      data: await deps.queries.forAgentScoped(
        context.get('runAuth'),
        context.req.param('id'),
      ),
    }),
  );
  routes.get('/issues/:id/comments', async (context) => {
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      context.req.param('id'),
    );
    return context.json({
      data: await deps.comments.listForAgent(issue.id, {
        since: queryText(context, 'since'),
        rootsOnly: flag(context, 'rootsOnly'),
        thread: queryText(context, 'thread'),
        tail: queryInt(context, 'tail'),
        excludeResolved: flag(context, 'excludeResolved'),
      }),
    });
  });
  routes.post('/issues/:id/comments', async (context) => {
    const issueId = await requireRunIssue(context);
    const result = await deps.comments.create(
      agentActor(context),
      issueId,
      await readJson<CreateCommentRequest>(context),
    );
    return context.json({ data: result.comment }, 201);
  });
  routes.post('/issues', async (context) =>
    context.json(
      {
        data: await deps.agentIssues.create(
          context.get('runAuth'),
          await readJson<AgentCreateIssueRequest>(context),
        ),
      },
      201,
    ),
  );
  routes.get('/issues/:id/children', async (context) => {
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      context.req.param('id'),
    );
    return context.json({ data: await deps.agentIssues.children(issue.id) });
  });
  routes.post('/issues/:id/dependencies', async (context) =>
    context.json(
      {
        data: await deps.agentIssues.addDependency(
          context.get('runAuth'),
          context.req.param('id'),
          await readJson<AgentDependencyRequest>(context),
        ),
      },
      201,
    ),
  );
  // The CLI form: `?dependsOnIssueId=<id or identifier>&type=blockedBy`.
  routes.delete('/issues/:id/dependencies', async (context) => {
    await deps.agentIssues.removeDependency(
      context.get('runAuth'),
      context.req.param('id'),
      queryText(context, 'dependsOnIssueId') ?? '',
      queryText(context, 'type'),
    );
    return context.json({ data: { ok: true } });
  });
  routes.delete('/issues/:id/dependencies/:target', async (context) => {
    await deps.agentIssues.removeDependency(
      context.get('runAuth'),
      context.req.param('id'),
      context.req.param('target'),
      queryText(context, 'type'),
    );
    return context.json({ data: { ok: true } });
  });
  routes.post('/issues/:id/status', async (context) => {
    const issueId = await requireRunIssue(context);
    const body = await readJson<{ statusKey: string }>(context);
    const result = await deps.issues.agentSetStatusGated(
      agentActor(context),
      issueId,
      body.statusKey,
    );
    if (result.pendingApproval) {
      const data: StatusChangePendingResponse = {
        issue: result.issue,
        pendingApproval: result.pendingApproval,
      };
      return context.json({ data }, 202);
    }
    return context.json({ data: result.issue });
  });
  routes.get('/issues/:id/pull-requests', async (context) => {
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      context.req.param('id'),
    );
    return context.json({ data: await deps.pullRequests.forIssue(issue.id) });
  });
  routes.post('/issues/:id/pull-requests', async (context) => {
    const issueId = await requireRunIssue(context);
    const body = await readJson<AgentPullRequestLinkRequest>(context);
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      issueId,
    );
    const { view, created } = await deps.pullRequests.agentLink(
      agentActor(context),
      issue,
      body.url,
    );
    return context.json({ data: view }, created ? 201 : 200);
  });
  return routes;
}
