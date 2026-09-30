import type { Hono } from 'hono';

import type { IssueQueries } from '../issue/issue.queries.js';
import { npRouter } from '../shared/http.js';
import type { AttachmentTextResponse } from '../shared/protocol.js';
import type { RunTokenEnv } from '../run/agent-api.routes.js';
import type { AttachmentService } from './attachment.service.js';

/** RFC 5987 `filename*` value, as the file plugin writes it for its own content route. */
function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * `GET /np/agent/issues/:id/attachments/:fileId/content` (NP-111), behind the run-token guard: streams the bytes of
 * one file attached to an issue the run may read (the agent API's read scope, `agentReadable`). The ids come from
 * the issue view's `attachments`; a file of another issue, an unknown id or an unreadable issue is 404.
 */
export function createAgentAttachmentRoutes(deps: {
  queries: IssueQueries;
  attachments: AttachmentService;
}): Hono<RunTokenEnv> {
  const routes = npRouter<RunTokenEnv>();
  routes.get('/issues/:id/attachments/:fileId/content', async (context) => {
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      context.req.param('id'),
    );
    const { file, body } = await deps.attachments.agentContent(
      issue.id,
      context.req.param('fileId'),
    );
    return context.body(body, 200, {
      'content-type': file.mimeType,
      'content-disposition': contentDisposition(file.filename),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
  });
  /** NP-183: `GET …/:fileId/text` → `{ data: { text: string | null } }` (`AttachmentTextResponse`). */
  routes.get('/issues/:id/attachments/:fileId/text', async (context) => {
    const issue = await deps.queries.agentReadable(
      context.get('runAuth'),
      context.req.param('id'),
    );
    const data: AttachmentTextResponse = {
      text: await deps.attachments.agentText(
        issue.id,
        context.req.param('fileId'),
      ),
    };
    return context.json({ data });
  });
  return routes;
}
