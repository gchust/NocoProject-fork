import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, queryText, sessionActor } from '../shared/http.js';
import type { InboxAction, InboxService } from './inbox.service.js';

const ACTIONS: readonly InboxAction[] = [
  'read',
  'unread',
  'archive',
  'unarchive',
];

/**
 * `/np/inbox` (browser, contract §E). `GET /` answers `{ data, unread, nextCursor }` (the extra keys sit beside
 * `data`, like `GET /np/runs/:id/events`); `kind`, `archived`, `resolved` and `issueId` narrow the list.
 */
export function createInboxRoutes(inbox: InboxService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json(
      await inbox.list(sessionActor(context), {
        kind: queryText(context, 'kind'),
        archived: queryText(context, 'archived'),
        resolved: queryText(context, 'resolved'),
        issueId: queryText(context, 'issueId'),
        cursor: queryText(context, 'cursor'),
      }),
    ),
  );
  routes.get('/unread-count', async (context) =>
    context.json({ data: await inbox.unreadCount(sessionActor(context)) }),
  );
  routes.get('/pending-count', async (context) =>
    context.json({ data: await inbox.pendingCount(sessionActor(context)) }),
  );
  routes.post('/read-all', async (context) => {
    let kind: unknown = null;
    const text = await context.req.text();
    if (text.trim()) {
      try {
        kind = (JSON.parse(text) as { kind?: unknown }).kind ?? null;
      } catch {
        kind = null;
      }
    }
    return context.json({
      data: { unread: await inbox.readAll(sessionActor(context), kind) },
    });
  });
  for (const action of ACTIONS) {
    routes.post(`/:id/${action}`, async (context) =>
      context.json({
        data: await inbox.mark(
          sessionActor(context),
          context.req.param('id'),
          action,
        ),
      }),
    );
  }
  return routes;
}

/** `POST /np/issues/:id/subscribe|unsubscribe` (browser). */
export function createSubscriptionRoutes(inbox: InboxService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.post('/:id/subscribe', async (context) => {
    await inbox.subscribe(sessionActor(context), context.req.param('id'));
    return context.json({ data: { subscribed: true } });
  });
  routes.post('/:id/unsubscribe', async (context) => {
    await inbox.unsubscribe(sessionActor(context), context.req.param('id'));
    return context.json({ data: { subscribed: false } });
  });
  return routes;
}
