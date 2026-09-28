import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono, MiddlewareHandler } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { UpdateMemberRequest } from '../shared/protocol.js';
import type { MemberService } from './member.service.js';

/**
 * `ensureMember` (contract §B): installed after `auth.required()` on every `/np/*` browser and daemon prefix. The
 * first signed-in user becomes owner, everyone else a member on first contact.
 */
export function ensureMember(
  members: MemberService,
): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    const auth = context.get('auth');
    if (auth?.user.id) await members.ensure(auth.user.id);
    await next();
  };
}

/** `/np/members` (browser): the member picker list and role changes. */
export function createMemberRoutes(members: MemberService): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await members.list(sessionActor(context)) }),
  );
  routes.patch('/:userId', async (context) => {
    const body = await readJson<UpdateMemberRequest>(context);
    return context.json({
      data: await members.updateRole(
        sessionActor(context),
        context.req.param('userId'),
        body.role,
      ),
    });
  });
  return routes;
}
