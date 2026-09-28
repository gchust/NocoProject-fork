/**
 * NocoProject webhooks (iteration-2 contract §C): `POST /np/webhooks/github`, a root route (no `/api`).
 *
 * Deliberately public — GitHub cannot present a session or an API key. The route verifies the HMAC signature over
 * the raw body and deduplicates by delivery id (`modules/git/webhook.routes.ts`); run tokens and sessions play no
 * part here.
 */
import type { Application } from '@nocobase/app-server/application';
import {
  defineRootRoutes,
  type AppRootRouteContribution,
} from '@nocobase/app-server/router';

import { createWebhookRoutes } from '../modules/git/webhook.routes.js';
import { npWebhookServiceToken } from '../providers/np.js';

export const npWebhookRoutes: AppRootRouteContribution<Application> =
  defineRootRoutes((app) =>
    createWebhookRoutes(app.container.resolve(npWebhookServiceToken)),
  );
