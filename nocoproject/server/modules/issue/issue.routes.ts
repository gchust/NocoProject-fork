import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Context, Hono } from 'hono';

import { invalid } from '../shared/errors.js';
import {
  npRouter,
  queryInt,
  queryText,
  readJson,
  sessionActor,
} from '../shared/http.js';
import type {
  AcceptDeliveryRequest,
  CreateIssueRequestV2,
  DeliveryResultV3,
  RequestChangesRequest,
  StatusChangePendingResponse,
  UpdateIssueRequestV2,
} from '../shared/protocol.js';
import type { DeliveryService } from './delivery.service.js';
import type { IssueListFilter, IssueQueries } from './issue.queries.js';
import type { IssueService } from './issue.service.js';

/** `GET /np/issues` slower than this is logged as a warning (iteration 3 §D). */
const SLOW_LIST_MS = 500;

export interface SlowLog {
  warn(message: string): void;
}

function listFilter(context: Context): IssueListFilter {
  return {
    statusKey: queryText(context, 'statusKey'),
    projectId: queryText(context, 'projectId'),
    q: queryText(context, 'q'),
    labelId: queryText(context, 'labelId'),
    ownerUserId: queryText(context, 'ownerUserId'),
    executorId: queryText(context, 'executorId'),
    parentIssueId: queryText(context, 'parentIssueId'),
  };
}

export async function optionalJson<T>(context: Context): Promise<T> {
  const text = await context.req.text();
  if (!text.trim()) return {} as T;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as T;
  } catch {
    // Falls through to the error below.
  }
  throw invalid('INVALID_JSON', 'Request body must be a JSON object.');
}

function deliveryResponse(context: Context, result: DeliveryResultV3) {
  return context.json({ data: result }, result.pendingApproval ? 202 : 200);
}

/**
 * `/np/issues` (browser). `:id` accepts an issue id or its identifier (`NP-12`); an issue the caller cannot see is
 * 404.
 *
 * - `GET /` answers `{ data, nextCursor }` (iteration 3 §D: `cursor`, `limit` ≤ 100, `sort=created`); with
 *   `view=board` it answers `{ data: { groups: [{ statusKey, issues, hasMore, nextCursor }] } }` (`columnLimit`;
 *   `statusKey` + `cursor` pages one column).
 * - `PATCH /:id` answers 202 `{ data: { issue, pendingApproval } }` when the status change waits for approval.
 * - `GET /:id/runs` answers `{ data: RunSummary[], queuedRun }`; `GET /:id/activities` and `/:id/comments` answer
 *   `{ data, nextCursor }` (older pages).
 * - `POST /:id/deliveries/accept | request-changes` (iteration 3 §E) answer `{ data: DeliveryResult }`, 202 when the
 *   status change waits for approval.
 */
export function createIssueRoutes(deps: {
  issues: IssueService;
  queries: IssueQueries;
  deliveries: DeliveryService;
  slowLog?: SlowLog;
}): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  const slowLog = deps.slowLog ?? console;
  routes.get('/', async (context) => {
    const started = Date.now();
    const actor = sessionActor(context);
    const filter = listFilter(context);
    const body =
      queryText(context, 'view') === 'board'
        ? {
            data: await deps.queries.board(actor, filter, {
              cursor: queryText(context, 'cursor'),
              columnLimit:
                queryInt(context, 'columnLimit') ?? queryInt(context, 'limit'),
            }),
          }
        : await deps.queries.page(actor, filter, {
            cursor: queryText(context, 'cursor'),
            limit: queryInt(context, 'limit'),
            sort: queryText(context, 'sort'),
          });
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_LIST_MS)
      slowLog.warn(
        `NocoProject GET /np/issues took ${elapsed} ms (${new URL(context.req.url).search}).`,
      );
    return context.json(body);
  });
  routes.post('/', async (context) => {
    const issue = await deps.issues.create(
      sessionActor(context),
      await readJson<CreateIssueRequestV2>(context),
    );
    return context.json({ data: issue }, 201);
  });
  routes.get('/:id', async (context) =>
    context.json({
      data: await deps.queries.detail(
        sessionActor(context),
        context.req.param('id'),
      ),
    }),
  );
  routes.patch('/:id', async (context) => {
    const result = await deps.issues.patch(
      sessionActor(context),
      context.req.param('id'),
      await readJson<UpdateIssueRequestV2>(context),
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
  routes.get('/:id/runs', async (context) =>
    context.json(
      await deps.queries.runs(sessionActor(context), context.req.param('id')),
    ),
  );
  for (const timeline of ['activities', 'comments'] as const) {
    routes.get(`/:id/${timeline}`, async (context) =>
      context.json(
        await deps.queries[timeline](
          sessionActor(context),
          context.req.param('id'),
          {
            cursor: queryText(context, 'cursor'),
            limit: queryInt(context, 'limit'),
          },
        ),
      ),
    );
  }
  routes.post('/:id/deliveries/accept', async (context) =>
    deliveryResponse(
      context,
      await deps.deliveries.accept(
        sessionActor(context),
        context.req.param('id'),
        await optionalJson<AcceptDeliveryRequest>(context),
      ),
    ),
  );
  routes.post('/:id/deliveries/request-changes', async (context) =>
    deliveryResponse(
      context,
      await deps.deliveries.requestChanges(
        sessionActor(context),
        context.req.param('id'),
        await readJson<RequestChangesRequest>(context),
      ),
    ),
  );
  return routes;
}
