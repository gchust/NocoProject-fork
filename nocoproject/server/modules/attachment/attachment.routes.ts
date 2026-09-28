import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  AttachFilesRequest,
  IssueAttachment,
} from '../shared/protocol.js';
import type { AttachmentService } from './attachment.service.js';

/**
 * `/np/issues/:id/attachments` (browser, NP-78): `GET` lists, `POST { fileIds }` attaches the caller's own unattached
 * uploads and answers the list, `DELETE /:fileId` removes one (204). `contentUrl` gets the application's base path.
 */
export function createAttachmentRoutes(
  attachments: AttachmentService,
  publicBasePath: string | undefined,
): Hono<AuthEnv> {
  const base = (publicBasePath ?? '').replace(/\/+$/u, '');
  const withBase = (items: IssueAttachment[]): IssueAttachment[] =>
    items.map((item) => ({ ...item, contentUrl: `${base}${item.contentUrl}` }));
  const routes = npRouter<AuthEnv>();
  routes.get('/:id/attachments', async (context) =>
    context.json({
      data: withBase(
        await attachments.list(sessionActor(context), context.req.param('id')),
      ),
    }),
  );
  routes.post('/:id/attachments', async (context) => {
    const body = await readJson<AttachFilesRequest>(context);
    return context.json({
      data: withBase(
        await attachments.attach(
          sessionActor(context),
          context.req.param('id'),
          body.fileIds,
        ),
      ),
    });
  });
  routes.delete('/:id/attachments/:fileId', async (context) => {
    await attachments.remove(
      sessionActor(context),
      context.req.param('id'),
      context.req.param('fileId'),
    );
    return context.body(null, 204);
  });
  return routes;
}
