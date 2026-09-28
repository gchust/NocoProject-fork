/**
 * NocoProject agent write-back API (protocol.md §5): `/api/np/agent/*`, authenticated only by a run token
 * (`Authorization: Bearer npr_…`). Sessions and API keys are not accepted here: the caller is the agent of one run.
 * Iteration 3 adds `/api/np/agent/knowledge*` (the run's project and system-level documents); iteration 4
 * `/api/np/agent/issues/:id/design-proposal` and the project manager's reads `/api/np/agent/pm/*`; Phase 2 the
 * checklists `/api/np/agent/issues/:id/checklists*` and the workflow templates `/api/np/agent/workflows*` (read,
 * propose).
 */
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono } from 'hono';

import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../modules/run/agent-api.routes.js';
import { createAgentDesignRoutes } from '../modules/issue/design.routes.js';
import { createAgentKnowledgeRoutes } from '../modules/knowledge/knowledge.routes.js';
import { createAgentPmRoutes } from '../modules/pm/pm.routes.js';
import { createAgentChecklistRoutes } from '../modules/workflow/checklist.routes.js';
import { createAgentWorkflowRoutes } from '../modules/workflow/workflow.routes.js';
import { guarded } from '../modules/shared/http.js';
import {
  npAgentIssueServiceToken,
  npChecklistServiceToken,
  npWorkflowProposalServiceToken,
  npCommentServiceToken,
  npDesignServiceToken,
  npPmServiceToken,
  npIssueQueriesToken,
  npIssueServiceToken,
  npKnowledgeServiceToken,
  npPullRequestServiceToken,
  npRunTokenServiceToken,
} from '../providers/np.js';

export const npAgentRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const { container } = app;
    const router = new Hono();
    router.route(
      '/np/agent',
      guarded(
        [runTokenAuth(container.resolve(npRunTokenServiceToken))],
        createAgentApiRoutes({
          issues: container.resolve(npIssueServiceToken),
          queries: container.resolve(npIssueQueriesToken),
          comments: container.resolve(npCommentServiceToken),
          agentIssues: container.resolve(npAgentIssueServiceToken),
          pullRequests: container.resolve(npPullRequestServiceToken),
        }),
        createAgentDesignRoutes(container.resolve(npDesignServiceToken)),
        createAgentKnowledgeRoutes(container.resolve(npKnowledgeServiceToken)),
        createAgentPmRoutes(container.resolve(npPmServiceToken)),
        createAgentChecklistRoutes(container.resolve(npChecklistServiceToken)),
        createAgentWorkflowRoutes(
          container.resolve(npWorkflowProposalServiceToken),
        ),
      ),
    );
    return router;
  });
