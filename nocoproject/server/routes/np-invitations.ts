/**
 * NP-88 email invitations: the public acceptance endpoints `/api/np/public/invitations/{lookup,accept}`.
 *
 * Deliberately public — the invitee has no account and no session yet. The one-time token in the body is the
 * credential (see `modules/member/invitation.routes.ts`); run tokens are still refused. The invitation management
 * endpoints (`/api/np/invitations`) are browser API routes behind the session guard in `np-api.ts`.
 */
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono } from 'hono';

import { createPublicInvitationRoutes } from '../modules/member/invitation.routes.js';
import { guarded, rejectRunTokens } from '../modules/shared/http.js';
import { npInvitationServiceToken } from '../providers/np.js';

export const npInvitationRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    router.route(
      '/np/public/invitations',
      guarded(
        [rejectRunTokens()],
        createPublicInvitationRoutes(
          app.container.resolve(npInvitationServiceToken),
        ),
      ),
    );
    return router;
  });
