import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { CreateCommentRequest } from '../shared/protocol.js';
import type { CommentService } from './comment.service.js';

/** `POST /np/issues/:id/comments` (browser): a human comment, which may trigger agents. */
export function createCommentRoutes(comments: CommentService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/comments', async (context) => {
    const result = await comments.create(
      sessionActor(context),
      context.req.param('id'),
      await readJson<CreateCommentRequest>(context),
    );
    return context.json({ data: result }, 201);
  });
  return routes;
}
