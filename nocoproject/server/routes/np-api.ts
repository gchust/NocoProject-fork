/**
 * NocoProject browser API (protocol.md §3, iteration-1 contract §B–§H, iteration-2 contract §C–§K):
 * `/api/np/{me,members,workflows,projects,labels,issues,inbox,agents,runtimes,runs}` and, from iteration 2,
 * `/api/np/{integrations,approvals,intake,comments,skills,usage,settings}` and, from iteration 3,
 * `/api/np/{knowledge,metrics}` (plus the delivery, activity and comment pages under `/api/np/issues/:id`) and, from
 * iteration 4, `/api/np/pm` (plus the design decisions under `/api/np/issues/:id/design`); Phase 2 the checklists
 * under `/api/np/issues/:id/checklists` and the workflow template proposals, revisions and admin write under
 * `/api/np/workflows`.
 *
 * Every prefix is mounted behind its own guard: a run token is refused with 403 before the session lookup,
 * `auth.required()` answers 401 for anonymous callers, and `ensureMember` bootstraps the caller's members row. The
 * application-level rules (who may see and change what) are enforced by the services through `shared/authz.ts`.
 */
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import type { Application } from '@nocobase/app-server/application';
import {
  defineApiRoutes,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono } from 'hono';

import type { AppIdentityConfig } from '@nocobase/app-server/config';
import { loggingToken } from '@nocobase/app-server/logging';

import { createAgentRoutes } from '../modules/agent/agent.routes.js';
import { createAgentEnvRoutes } from '../modules/agent/env.routes.js';
import { createApprovalRoutes } from '../modules/approval/approval.routes.js';
import { createAttachmentRoutes } from '../modules/attachment/attachment.routes.js';
import { createCommentRoutes } from '../modules/collaboration/comment.routes.js';
import { createReactionRoutes } from '../modules/collaboration/reaction.routes.js';
import {
  createIntegrationRoutes,
  createIssuePullRequestRoutes,
} from '../modules/git/git.routes.js';
import { createIntakeRoutes } from '../modules/intake/intake.routes.js';
import { createKnowledgeRoutes } from '../modules/knowledge/knowledge.routes.js';
import { createMetricsRoutes } from '../modules/metrics/metrics.routes.js';
import { createSkillRoutes } from '../modules/skill/skill.routes.js';
import { createSettingsRoutes } from '../modules/system/settings.routes.js';
import { createUsageRoutes } from '../modules/usage/usage.routes.js';
import { createDesignRoutes } from '../modules/issue/design.routes.js';
import { createChecklistRoutes } from '../modules/workflow/checklist.routes.js';
import { createIssueRoutes } from '../modules/issue/issue.routes.js';
import { createPmRoutes } from '../modules/pm/pm.routes.js';
import { createLabelRoutes } from '../modules/label/label.routes.js';
import {
  createMemberRoutes,
  ensureMember,
} from '../modules/member/member.routes.js';
import { createInvitationRoutes } from '../modules/member/invitation.routes.js';
import {
  createInboxRoutes,
  createSubscriptionRoutes,
} from '../modules/notification/inbox.routes.js';
import { createProjectRoutes } from '../modules/project/project.routes.js';
import { createRunRoutes } from '../modules/run/run.routes.js';
import { createRuntimeRoutes } from '../modules/runtime/runtime.routes.js';
import { createSubtaskRoutes } from '../modules/subtask/subtask.routes.js';
import { createWorkflowRoutes } from '../modules/workflow/workflow.routes.js';
import {
  guarded,
  npRouter,
  readJson,
  rejectRunTokens,
} from '../modules/shared/http.js';
import type { MeResponse } from '../modules/shared/protocol.js';
import {
  npAgentEnvServiceToken,
  npAttachmentServiceToken,
  npInvitationServiceToken,
  npAgentServiceToken,
  npApprovalGatewayToken,
  npGitConnectionServiceToken,
  npIntakeServiceToken,
  npPullRequestServiceToken,
  npPullRequestMergeServiceToken,
  npReactionServiceToken,
  npSkillServiceToken,
  npUsageServiceToken,
  npWorkspaceSettingsServiceToken,
  npDeliveryServiceToken,
  npChecklistServiceToken,
  npWorkflowProposalServiceToken,
  npDesignServiceToken,
  npKnowledgeServiceToken,
  npPmServiceToken,
  npMetricsServiceToken,
  npCommentServiceToken,
  npDependencyServiceToken,
  npInboxServiceToken,
  npLabelServiceToken,
  npMemberServiceToken,
  npProposalServiceToken,
  npWorkflowServiceToken,
  npIssueQueriesToken,
  npIssueServiceToken,
  npProjectServiceToken,
  npRunEventServiceToken,
  npRunQueriesToken,
  npRunRecoveryServiceToken,
  npRunServiceToken,
  npRuntimeServiceToken,
} from '../providers/np.js';

export const npApiRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const { container } = app;
    const auth = container.resolve(authenticationToken);
    const members = container.resolve(npMemberServiceToken);
    const inbox = container.resolve(npInboxServiceToken);
    const guard = [rejectRunTokens(), auth.required(), ensureMember(members)];
    const router = new Hono();

    const me = npRouter<AuthEnv>();
    me.get('/', (context) => {
      const { user } = context.get('auth')!;
      const data: MeResponse = {
        userId: user.id,
        name: user.name || user.email,
      };
      return context.json({ data });
    });
    // NP-108: the member's own preferences (the inbox chime), always about the signed-in user.
    me.get('/preferences', async (context) =>
      context.json({
        data: await members.preferences(context.get('auth')!.user.id),
      }),
    );
    me.patch('/preferences', async (context) =>
      context.json({
        data: await members.updatePreferences(
          context.get('auth')!.user.id,
          await readJson<unknown>(context),
        ),
      }),
    );

    router.route('/np/me', guarded(guard, me));
    router.route('/np/members', guarded(guard, createMemberRoutes(members)));
    router.route(
      '/np/invitations',
      guarded(
        guard,
        createInvitationRoutes(container.resolve(npInvitationServiceToken), {
          publicOrigin: app.config.get<AppIdentityConfig>('app')?.publicOrigin,
          publicBasePath: app.publicBasePath,
        }),
      ),
    );
    router.route(
      '/np/workflows',
      guarded(
        guard,
        createWorkflowRoutes(
          container.resolve(npWorkflowServiceToken),
          container.resolve(npWorkflowProposalServiceToken),
        ),
      ),
    );
    router.route(
      '/np/projects',
      guarded(
        guard,
        createProjectRoutes(
          container.resolve(npProjectServiceToken),
          container.resolve(npKnowledgeServiceToken),
        ),
      ),
    );
    router.route(
      '/np/labels',
      guarded(guard, createLabelRoutes(container.resolve(npLabelServiceToken))),
    );
    router.route(
      '/np/issues',
      guarded(
        guard,
        createIssueRoutes({
          issues: container.resolve(npIssueServiceToken),
          queries: container.resolve(npIssueQueriesToken),
          deliveries: container.resolve(npDeliveryServiceToken),
          slowLog: container.has(loggingToken)
            ? container.resolve(loggingToken).getLogger('nocoproject')
            : undefined,
        }),
        createCommentRoutes(container.resolve(npCommentServiceToken)),
        createSubtaskRoutes({
          dependencies: container.resolve(npDependencyServiceToken),
          proposals: container.resolve(npProposalServiceToken),
        }),
        createSubscriptionRoutes(inbox),
        createIssuePullRequestRoutes(
          container.resolve(npPullRequestServiceToken),
          container.resolve(npPullRequestMergeServiceToken),
        ),
        createDesignRoutes(container.resolve(npDesignServiceToken)),
        createChecklistRoutes(container.resolve(npChecklistServiceToken)),
        createAttachmentRoutes(
          container.resolve(npAttachmentServiceToken),
          app.publicBasePath,
        ),
      ),
    );
    router.route('/np/inbox', guarded(guard, createInboxRoutes(inbox)));
    router.route(
      '/np/agents',
      guarded(
        guard,
        createAgentRoutes(container.resolve(npAgentServiceToken)),
        createAgentEnvRoutes(container.resolve(npAgentEnvServiceToken)),
      ),
    );
    router.route(
      '/np/runtimes',
      guarded(
        guard,
        createRuntimeRoutes(container.resolve(npRuntimeServiceToken)),
      ),
    );
    router.route(
      '/np/runs',
      guarded(
        guard,
        createRunRoutes({
          runs: container.resolve(npRunServiceToken),
          queries: container.resolve(npRunQueriesToken),
          events: container.resolve(npRunEventServiceToken),
          recovery: container.resolve(npRunRecoveryServiceToken),
        }),
      ),
    );
    mountIteration2(router, app, guard);
    return router;
  });

/** The iteration 2 prefixes, each behind the same guard as the rest of the browser API. */
function mountIteration2(
  router: Hono,
  app: Application,
  guard: Parameters<typeof guarded>[0],
): void {
  const { container } = app;
  router.route(
    '/np/integrations',
    guarded(
      guard,
      createIntegrationRoutes({
        connections: container.resolve(npGitConnectionServiceToken),
        publicOrigin: app.config.get<AppIdentityConfig>('app')?.publicOrigin,
        publicBasePath: app.publicBasePath,
      }),
    ),
  );
  router.route(
    '/np/approvals',
    guarded(
      guard,
      createApprovalRoutes(container.resolve(npApprovalGatewayToken)),
    ),
  );
  router.route(
    '/np/intake',
    guarded(
      guard,
      createIntakeRoutes(
        container.resolve(npIntakeServiceToken),
        app.publicBasePath,
      ),
    ),
  );
  router.route(
    '/np/comments',
    guarded(
      guard,
      createReactionRoutes(container.resolve(npReactionServiceToken)),
    ),
  );
  router.route(
    '/np/skills',
    guarded(guard, createSkillRoutes(container.resolve(npSkillServiceToken))),
  );
  router.route(
    '/np/usage',
    guarded(guard, createUsageRoutes(container.resolve(npUsageServiceToken))),
  );
  router.route(
    '/np/settings',
    guarded(
      guard,
      createSettingsRoutes(container.resolve(npWorkspaceSettingsServiceToken)),
    ),
  );
  // Iteration 3.
  router.route(
    '/np/knowledge',
    guarded(
      guard,
      createKnowledgeRoutes(container.resolve(npKnowledgeServiceToken)),
    ),
  );
  router.route(
    '/np/metrics',
    guarded(
      guard,
      createMetricsRoutes(container.resolve(npMetricsServiceToken)),
    ),
  );
  // Iteration 4.
  router.route(
    '/np/pm',
    guarded(guard, createPmRoutes(container.resolve(npPmServiceToken))),
  );
}
