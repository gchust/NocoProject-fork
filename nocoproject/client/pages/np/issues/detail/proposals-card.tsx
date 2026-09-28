import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BotIcon, CheckIcon, XIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

import {
  type ProposalDecision,
  acceptAllProposals,
  decideProposal,
} from '../../api-collab.js';
import { npKeys } from '../../constants.js';
import type { AgentListItem, ExecutorProposal } from '../../types.js';
import { pendingProposals } from './subtask-model.js';

type Action =
  | {
      readonly kind: ProposalDecision;
      readonly proposal: ExecutorProposal;
    }
  | { readonly kind: 'acceptAll' };

/**
 * Executor proposals waiting for the owner (§D): an agent that created sub-issues suggested who should execute them.
 * Each can be accepted (the agent becomes the executor and may start at once) or rejected; "Accept all" decides every
 * pending proposal under this issue. Accepting needs access to the proposed agent, so an agent the viewer cannot
 * invoke disables its accept button.
 */
export function ProposalsCard({
  issueId,
  proposals,
  agents,
  embedded = false,
}: {
  readonly issueId: string;
  readonly proposals: readonly ExecutorProposal[];
  readonly agents: readonly AgentListItem[];
  /**
   * Inside a decision card (nocosolution/frontend/nocosolution-frontend-standard.md §3): only the list, with per-proposal buttons; the card's own
   * action row carries "accept all".
   */
  readonly embedded?: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const pending = pendingProposals(proposals);

  const decide = useMutation({
    mutationFn: async (action: Action): Promise<number> => {
      if (action.kind === 'acceptAll') {
        return (await acceptAllProposals(api, issueId)).skipped;
      }
      await decideProposal(
        api,
        action.proposal.issueId,
        action.proposal.id,
        action.kind,
      );
      return 0;
    },
    onSuccess: (skipped, action) => {
      toast.add({
        type: 'success',
        title:
          action.kind === 'reject'
            ? t('np.proposals.rejected')
            : action.kind === 'acceptAll'
              ? skipped > 0
                ? t('np.proposals.acceptedSome', { count: skipped })
                : t('np.proposals.acceptedAll')
              : t('np.proposals.accepted', {
                  name: action.proposal.proposedAgentName,
                }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.proposals.forbidden')
            : t('np.common.requestFailed'),
      }),
  });

  if (pending.length === 0) return null;
  const canInvoke = (agentId: string): boolean =>
    agents.find((agent) => agent.id === agentId)?.canInvoke !== false;

  const list = (
    <ul className='divide-y'>
      {pending.map((proposal) => (
        <li
          key={proposal.id}
          className='flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm first:pt-0 last:pb-0'
        >
          <div className='min-w-0 flex-1 space-y-0.5'>
            <p className='truncate'>
              <span className='font-mono text-xs text-muted-foreground'>
                {proposal.issueIdentifier}
              </span>{' '}
              {proposal.issueTitle}
            </p>
            <p className='flex items-center gap-1.5 text-xs text-muted-foreground'>
              <BotIcon className='size-3.5' aria-hidden='true' />
              {t('np.proposals.line', {
                agent: proposal.proposedAgentName,
                by: proposal.proposedByAgentName,
              })}
            </p>
          </div>
          <div className='flex shrink-0 gap-1.5'>
            <Button
              variant='outline'
              size='sm'
              disabled={decide.isPending}
              aria-label={t('np.proposals.rejectOne', {
                identifier: proposal.issueIdentifier,
              })}
              onClick={() => decide.mutate({ kind: 'reject', proposal })}
            >
              <XIcon data-icon='inline-start' />
              {t('np.proposals.reject')}
            </Button>
            <Button
              size='sm'
              disabled={
                decide.isPending || !canInvoke(proposal.proposedAgentId)
              }
              aria-label={t('np.proposals.acceptOne', {
                identifier: proposal.issueIdentifier,
              })}
              onClick={() => decide.mutate({ kind: 'accept', proposal })}
            >
              <CheckIcon data-icon='inline-start' />
              {t('np.proposals.accept')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
  if (embedded) return list;

  return (
    <Card size='sm' role='region' aria-labelledby='np-proposals-title'>
      <CardHeader>
        <CardTitle id='np-proposals-title'>
          {t('np.proposals.title', { count: pending.length })}
        </CardTitle>
        <CardDescription>{t('np.proposals.description')}</CardDescription>
        {pending.length > 1 ? (
          <CardAction>
            <Button
              size='sm'
              disabled={decide.isPending}
              onClick={() => decide.mutate({ kind: 'acceptAll' })}
            >
              <CheckIcon data-icon='inline-start' />
              {t('np.proposals.acceptAll')}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>{list}</CardContent>
    </Card>
  );
}
