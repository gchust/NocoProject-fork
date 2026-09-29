import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpOnlineState } from '@/components/np-badges';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpDetailSkeleton } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { RouteChildPage } from '@/components/route-child-page';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';

import { fetchMembers } from '../../api-collab.js';
import { fetchAgents, fetchMe, fetchRuntimes } from '../../api.js';
import { isRuntimeOnline, npKeys } from '../../constants.js';
import {
  canEditAgent,
  isWorkspaceAdmin,
  viewerFrom,
} from '../../permissions.js';
import { AgentEnvSection } from './agent-env.js';
import { AgentForm } from './agent-form.js';
import { AgentDelete } from './agent-delete.js';
import { AgentSkillsSection } from './agent-skills.js';

/**
 * Route `/agents/:agentId` (§J 5): a covering child page over the agent list with the agent's editable settings,
 * its mounted skills and its environment variables (iteration 2 §G, §H).
 * The agent comes from `GET /np/agents` (the contract has no single-agent read), so an id that list does not hold is
 * reported as not found.
 */
export default function AgentDetailPage(): ReactElement {
  const { agentId = '' } = useParams();
  return (
    <RouteChildPage>
      <AgentDetailView key={agentId} agentId={agentId} />
    </RouteChildPage>
  );
}

function AgentDetailView({
  agentId,
}: {
  readonly agentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });

  const agent = agents.data?.find((candidate) => candidate.id === agentId);

  if ((agents.isError && !agents.data) || (agents.data && !agent)) {
    return (
      <PageContainer>
        <Breadcrumbs />
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertTitle>{t('np.agentDetail.loadFailed')}</AlertTitle>
          <AlertDescription>
            {agents.data
              ? t('np.agentDetail.notFound')
              : t('np.common.requestFailed')}
          </AlertDescription>
          <AlertAction>
            {agents.data ? (
              <Button
                variant='outline'
                size='sm'
                nativeButton={false}
                render={<Link to='..' relative='path' />}
              >
                {t('np.agentDetail.backToList')}
              </Button>
            ) : (
              <Button
                variant='outline'
                size='sm'
                onClick={() => void agents.refetch()}
              >
                {t('status.retry')}
              </Button>
            )}
          </AlertAction>
        </Alert>
      </PageContainer>
    );
  }

  if (!agent) {
    return <NpDetailSkeleton />;
  }

  const viewer = viewerFrom(me.data?.userId, members.data);
  const canEdit = agent.canEdit ?? canEditAgent(viewer, agent);
  return (
    <PageContainer>
      <Breadcrumbs />
      <PageHeader
        title={
          <span className='inline-flex flex-wrap items-center gap-3'>
            <NpActorAvatar type='agent' name={agent.name} size='default' />
            {agent.name}
            <NpTag tone='grey'>{agent.provider}</NpTag>
            <NpOnlineState online={isRuntimeOnline(agent)} />
          </span>
        }
        actions={
          <AgentDelete
            agent={agent}
            canDelete={Boolean(
              me.data?.userId && me.data.userId === agent.ownerUserId,
            )}
          />
        }
        description={t('np.agentDetail.owner', {
          name: agent.ownerName ?? '—',
        })}
      />
      {/* Keyed by the agent's update time so a save elsewhere reseeds the form instead of keeping a stale draft. */}
      <AgentForm
        key={agent.updatedAt ?? agent.id}
        agent={agent}
        runtimes={runtimes.data ?? []}
        agents={agents.data ?? []}
        members={members.data ?? []}
        canEdit={canEdit}
      />
      <AgentSkillsSection
        key={`skills:${agent.updatedAt ?? agent.id}`}
        agent={agent}
        canEdit={canEdit}
      />
      <AgentEnvSection
        agentId={agent.id}
        canEdit={canEdit}
        isAdmin={isWorkspaceAdmin(viewer)}
      />
    </PageContainer>
  );
}
