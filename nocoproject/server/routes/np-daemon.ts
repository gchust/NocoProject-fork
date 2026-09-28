/**
 * NocoProject daemon API (protocol.md §4): `/api/np/daemon/*`, authenticated by the runtime owner's API key through
 * `auth.required()`. `runs/:id/*` additionally requires the caller to own the run's runtime. Run tokens get 403.
 */
import { authenticationToken } from '@nocobase/app-plugin-authentication';
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono } from 'hono';

import { createDaemonRunRoutes } from '../modules/run/daemon-run.routes.js';
import { ensureMember } from '../modules/member/member.routes.js';
import { createDaemonRoutes } from '../modules/runtime/daemon.routes.js';
import { guarded, rejectRunTokens } from '../modules/shared/http.js';
import {
  npClaimServiceToken,
  npMemberServiceToken,
  npRunEventServiceToken,
  npRunRecoveryServiceToken,
  npRunServiceToken,
  npRuntimeServiceToken,
} from '../providers/np.js';

export const npDaemonRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const { container } = app;
    const auth = container.resolve(authenticationToken);
    const runtimes = container.resolve(npRuntimeServiceToken);
    const router = new Hono();
    router.route(
      '/np/daemon',
      guarded(
        [
          rejectRunTokens(),
          auth.required(),
          ensureMember(container.resolve(npMemberServiceToken)),
        ],
        createDaemonRoutes({
          runtimes,
          claims: container.resolve(npClaimServiceToken),
          publicBasePath: app.publicBasePath,
        }),
        createDaemonRunRoutes({
          runs: container.resolve(npRunServiceToken),
          events: container.resolve(npRunEventServiceToken),
          recovery: container.resolve(npRunRecoveryServiceToken),
          runtimes,
        }),
      ),
    );
    return router;
  });
