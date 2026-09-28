import type { Application } from '@nocobase/app-server/application';
import type { AppRouteContribution } from '@nocobase/app-server/router';

import { npAgentRoutes } from './np-agent.js';
import { npApiRoutes } from './np-api.js';
import { npDaemonRoutes } from './np-daemon.js';
import { npFileRoutes } from './np-files.js';
import { npInvitationRoutes } from './np-invitations.js';
import { npWebhookRoutes } from './np-webhooks.js';

const routes: readonly AppRouteContribution<Application>[] = [
  // NocoProject (docs/phase0/protocol.md, docs/phase1/protocol-iteration-{1,2}.md): browser, daemon, agent
  // write-back, and the public GitHub webhook (a root route, signature-verified).
  npApiRoutes,
  npDaemonRoutes,
  npAgentRoutes,
  npWebhookRoutes,
  // NP-88: the public invitation acceptance endpoints (token-verified).
  npInvitationRoutes,
  // NP-78: attachment upload and content routes (the file plugin's, behind NocoProject guards).
  ...npFileRoutes,
];

export default routes;
