import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { CreateCommentRequest } from '../shared/protocol.js';
import type { ConversationService } from '../pm/pm.conversations.js';
import type { CommentService } from './comment.service.js';

/**
 * `POST /np/issues/:id/comments` (browser): a human comment, which may trigger agents. NP-183: on a project manager
 * conversation the body may carry `context` (the page context) and the answer adds `conversation.agent`.
 */
export function createCommentRoutes(
  comments: CommentService,
  conversations?: Pick<ConversationService, 'detailOf'>,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/comments', async (context) => {
    const result = await comments.create(
      sessionActor(context),
      context.req.param('id'),
      await readJson<CreateCommentRequest>(context),
    );
    const conversation = await conversations?.detailOf(result.comment.issueId);
    return context.json(
      {
        data: conversation
          ? { ...result, conversation: { agent: conversation.agent } }
          : result,
      },
      201,
    );
  });
  return routes;
}
