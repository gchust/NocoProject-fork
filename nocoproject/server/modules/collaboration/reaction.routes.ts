import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { AddReactionRequest } from '../shared/protocol.js';
import type { ReactionService } from './reaction.service.js';

/** The emoji path segment, decoded once more if it still carries percent escapes; malformed input stays as is. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `/np/comments/:id/{reactions,resolve,unresolve}` (browser, contract §F). Reactions answer the comment's reactions
 * `[{ emoji, count, userIds }]`; resolve / unresolve answer `{ commentId, resolvedAt, resolvedById }`.
 */
export function createReactionRoutes(
  reactions: ReactionService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/reactions', async (context) => {
    const body = await readJson<AddReactionRequest>(context);
    return context.json({
      data: await reactions.add(
        sessionActor(context),
        context.req.param('id'),
        body.emoji,
      ),
    });
  });
  routes.delete('/:id/reactions/:emoji', async (context) =>
    context.json({
      data: await reactions.remove(
        sessionActor(context),
        context.req.param('id'),
        safeDecode(context.req.param('emoji')),
      ),
    }),
  );
  routes.post('/:id/resolve', async (context) =>
    context.json({
      data: await reactions.resolve(
        sessionActor(context),
        context.req.param('id'),
        true,
      ),
    }),
  );
  routes.post('/:id/unresolve', async (context) =>
    context.json({
      data: await reactions.resolve(
        sessionActor(context),
        context.req.param('id'),
        false,
      ),
    }),
  );
  return routes;
}
