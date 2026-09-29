import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { invalid } from '../shared/errors.js';
import { npRouter, queryText, readJson, sessionActor } from '../shared/http.js';
import type {
  ConfirmIntakeRequest,
  CreateIntakeBatchRequestV4,
  IntakeBatchAttachmentsField,
  PutIntakeDraftsRequest,
  RefineIntakeDraftsRequest,
} from '../shared/protocol.js';
import type { IntakeService } from './intake.service.js';

function optionalBody<T>(text: string): T {
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalid('INVALID_JSON', 'Request body must be JSON.');
  }
}

/**
 * `/np/intake/batches` (browser, contract §E). NP-78: the batch's `attachments[].contentUrl` gets the application's
 * base path. NP-120: `POST /batches/:id/refine` revises the drafts by one instruction.
 */
export function createIntakeRoutes(
  intake: IntakeService,
  publicBasePath?: string,
): Hono<AuthEnv> {
  const base = (publicBasePath ?? '').replace(/\/+$/u, '');
  const withBase = <T extends IntakeBatchAttachmentsField>(view: T): T => ({
    ...view,
    attachments: view.attachments.map((file) => ({
      ...file,
      contentUrl: `${base}${file.contentUrl}`,
    })),
  });
  const routes = npRouter<AuthEnv>();
  routes.post('/batches', async (context) =>
    context.json(
      {
        data: withBase(
          await intake.create(
            sessionActor(context),
            await readJson<CreateIntakeBatchRequestV4>(context),
          ),
        ),
      },
      201,
    ),
  );
  routes.get('/batches', async (context) =>
    context.json({
      data: await intake.list(
        sessionActor(context),
        ['1', 'true'].includes(queryText(context, 'mine') ?? ''),
      ),
    }),
  );
  routes.get('/batches/:id', async (context) =>
    context.json({
      data: withBase(
        await intake.get(sessionActor(context), context.req.param('id')),
      ),
    }),
  );
  routes.put('/batches/:id/drafts', async (context) => {
    const body = await readJson<PutIntakeDraftsRequest>(context);
    return context.json({
      data: {
        drafts: await intake.putDrafts(
          sessionActor(context),
          context.req.param('id'),
          body.drafts,
        ),
      },
    });
  });
  // NP-120: the model answers within 30 seconds (504 AI_TIMEOUT otherwise).
  routes.post('/batches/:id/refine', async (context) =>
    context.json({
      data: {
        drafts: await intake.refine(
          sessionActor(context),
          context.req.param('id'),
          await readJson<RefineIntakeDraftsRequest>(context),
        ),
      },
    }),
  );
  routes.post('/batches/:id/confirm', async (context) =>
    context.json({
      data: await intake.confirm(
        sessionActor(context),
        context.req.param('id'),
        optionalBody<ConfirmIntakeRequest>(await context.req.text()),
      ),
    }),
  );
  routes.post('/batches/:id/cancel', async (context) =>
    context.json({
      data: await intake.cancel(sessionActor(context), context.req.param('id')),
    }),
  );
  routes.post('/batches/:id/revert', async (context) =>
    context.json({
      data: await intake.revert(sessionActor(context), context.req.param('id')),
    }),
  );
  return routes;
}
