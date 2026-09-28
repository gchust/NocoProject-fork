import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

import NpProvider from './np.js';

export {
  npAgentServiceToken,
  npClaimServiceToken,
  npCommentServiceToken,
  npIssueQueriesToken,
  npIssueServiceToken,
  npProjectServiceToken,
  npRunEventServiceToken,
  npRunQueriesToken,
  npRunRecoveryServiceToken,
  npRunServiceToken,
  npRunTokenServiceToken,
  npRuntimeServiceToken,
  npServicesToken,
  npSweeperServiceToken,
  npTriggerServiceToken,
  npWorkflowServiceToken,
  npMemberServiceToken,
  npLabelServiceToken,
  npDependencyServiceToken,
  npProposalServiceToken,
  npAgentIssueServiceToken,
  npInboxServiceToken,
  npApprovalGatewayToken,
  npGitConnectionServiceToken,
  npPullRequestServiceToken,
  npPullRequestMergeServiceToken,
  npWebhookServiceToken,
  npIntakeServiceToken,
  npReactionServiceToken,
  npAgentEnvServiceToken,
  npSkillServiceToken,
  npUsageServiceToken,
  npWorkspaceSettingsServiceToken,
  npKnowledgeServiceToken,
  npMetricsServiceToken,
  npDeliveryServiceToken,
} from './np.js';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  // NocoProject modules (server/modules/*): services, realtime topics, run sweeper.
  NpProvider,
];

export default serviceProviders;
