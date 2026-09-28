import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Context, Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type {
  AcceptInvitationRequest,
  CreateInvitationsRequest,
} from '../shared/protocol.js';
import type {
  InvitationContext,
  InvitationService,
} from './invitation.service.js';

export interface InvitationUrls {
  /** `app.publicOrigin`; the request origin when unset. */
  readonly publicOrigin?: string;
  readonly publicBasePath?: string;
}

/** The application's public URL, which invitation links start with. */
function contextOf(context: Context, urls: InvitationUrls): InvitationContext {
  const origin = (urls.publicOrigin || new URL(context.req.url).origin).replace(
    /\/+$/u,
    '',
  );
  const base = (urls.publicBasePath ?? '').replace(/\/+$/u, '');
  return { appUrl: `${origin}${base}` };
}

/** `/np/invitations` (browser, NP-88): list, invite several addresses, send again, revoke. */
export function createInvitationRoutes(
  invitations: InvitationService,
  urls: InvitationUrls,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await invitations.list(sessionActor(context)) }),
  );
  routes.post('/', async (context) => {
    const body = await readJson<CreateInvitationsRequest>(context);
    return context.json(
      {
        data: await invitations.create(
          sessionActor(context),
          body,
          contextOf(context, urls),
        ),
      },
      201,
    );
  });
  routes.post('/:id/resend', async (context) =>
    context.json({
      data: await invitations.resend(
        sessionActor(context),
        context.req.param('id'),
        contextOf(context, urls),
      ),
    }),
  );
  routes.delete('/:id', async (context) => {
    await invitations.revoke(sessionActor(context), context.req.param('id'));
    return context.body(null, 204);
  });
  return routes;
}

/**
 * `/np/public/invitations/{lookup,accept}` (NP-88): deliberately public — the invitee has no account yet. The token
 * (32 random bytes, stored only as a hash) is the credential; it opens exactly one pending, unexpired invitation. It
 * travels in the JSON body rather than the path so request logs never record it.
 */
export function createPublicInvitationRoutes(
  invitations: InvitationService,
): Hono {
  const routes = npRouter();
  routes.post('/lookup', async (context) => {
    const body = await readJson<{ token?: unknown }>(context);
    return context.json({
      data: await invitations.lookup(tokenOf(body.token)),
    });
  });
  routes.post('/accept', async (context) => {
    const body = await readJson<AcceptInvitationRequest>(context);
    return context.json({
      data: await invitations.accept(tokenOf(body.token), body),
    });
  });
  return routes;
}

function tokenOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
