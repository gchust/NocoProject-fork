import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import type { Hono } from 'hono';

import { npRouter, readJson, sessionActor } from '../shared/http.js';
import type { UpdateWorkspaceSettingsRequestV3 } from '../shared/protocol.js';
import type { WorkspaceSettingsService } from './settings.admin.js';

/** `/np/settings` (browser, contract §I): read for every member, PATCH for owner/admin. */
export function createSettingsRoutes(
  settings: WorkspaceSettingsService,
): Hono<AuthEnv> {
  const routes = npRouter<AuthEnv>();
  routes.get('/', async (context) =>
    context.json({ data: await settings.view(sessionActor(context)) }),
  );
  routes.patch('/', async (context) =>
    context.json({
      data: await settings.update(
        sessionActor(context),
        await readJson<UpdateWorkspaceSettingsRequestV3>(context),
      ),
    }),
  );
  return routes;
}
