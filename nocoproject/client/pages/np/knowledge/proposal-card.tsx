import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpMarkdown } from '@/components/np-markdown';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  decideKnowledgeProposal,
  type KnowledgeProposalDecision,
} from '../api-knowledge.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { KnowledgeProposal } from '../types-iter3.js';

/**
 * One pending agent proposal (§B): who proposed it and why, the source issue, the proposed text behind a disclosure,
 * and accept / reject. Rejecting opens a note field (optional); accepting applies the text as a new version or a new
 * document. The card is shown only to people who may decide (the list endpoint already filters).
 */
export function KnowledgeProposalCard({
  proposal,
}: {
  readonly proposal: KnowledgeProposal;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const [rejecting, setRejecting] = useState(false);
  // An update proposal has an empty `title` (= keep the title); the document's title names it.
  const name = proposal.docTitle || proposal.title;
  const [comment, setComment] = useState('');

  const decide = useMutation({
    mutationFn: (decision: KnowledgeProposalDecision) =>
      decideKnowledgeProposal(
        api,
        proposal.id,
        decision,
        comment.trim() || undefined,
      ),
    onSuccess: (_, decision) => {
      toast.add({
        type: 'success',
        title:
          decision === 'accept'
            ? t('np.knowledge.proposals.accepted', { title: name })
            : t('np.knowledge.proposals.rejected', { title: name }),
      });
      setRejecting(false);
      setComment('');
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 409
              ? t('np.knowledge.proposals.alreadyDecided')
              : t('np.common.requestFailed'),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge });
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
    },
  });

  return (
    <article
      className='space-y-3 rounded-lg border bg-card p-3 text-card-foreground'
      aria-label={t('np.knowledge.proposals.cardLabel', { title: name })}
    >
      <header className='flex flex-wrap items-center gap-2 text-sm'>
        <NpActorAvatar
          type='agent'
          name={proposal.proposedByAgentName ?? proposal.proposedByAgentId}
          showName
          className='font-medium'
        />
        <span className='text-muted-foreground'>
          {proposal.docId
            ? t('np.knowledge.proposals.proposesChange')
            : t('np.knowledge.proposals.proposesNew')}
        </span>
        <span className='font-medium'>{name}</span>
        {proposal.docId ? null : (
          <NpTag tone='blue'>{t('np.knowledge.proposals.new')}</NpTag>
        )}
        <time
          className='ml-auto text-xs text-muted-foreground'
          dateTime={proposal.createdAt}
          title={format.dateTime(proposal.createdAt)}
        >
          {format.relative(proposal.createdAt)}
        </time>
      </header>
      {proposal.reason ? (
        <p className='text-sm wrap-anywhere'>{proposal.reason}</p>
      ) : null}
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
        {proposal.sourceIssueId ? (
          <Link
            to={`/issues/${encodeURIComponent(proposal.sourceIssueId)}`}
            className='font-mono hover:text-foreground hover:underline'
          >
            {proposal.sourceIssueIdentifier ?? proposal.sourceIssueId}
          </Link>
        ) : null}
        {proposal.summary ? <span>{proposal.summary}</span> : null}
      </div>
      <Collapsible>
        <CollapsibleTrigger
          render={<Button variant='ghost' size='sm' className='group/button' />}
        >
          <ChevronDownIcon
            data-icon='inline-start'
            className='transition-transform group-data-panel-open/button:rotate-180'
          />
          {t('np.knowledge.proposals.showContent')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className='mt-2 max-h-80 overflow-y-auto rounded-md border bg-muted/30 p-3'>
            <NpMarkdown content={proposal.content} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {rejecting ? (
        <div className='space-y-2'>
          <Textarea
            value={comment}
            rows={2}
            autoFocus
            placeholder={t('np.knowledge.proposals.commentPlaceholder')}
            aria-label={t('np.knowledge.proposals.comment')}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className='flex justify-end gap-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setRejecting(false);
                setComment('');
              }}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant='destructive'
              size='sm'
              disabled={decide.isPending}
              onClick={() => decide.mutate('reject')}
            >
              {decide.isPending ? <Spinner data-icon='inline-start' /> : null}
              {t('np.knowledge.proposals.confirmReject')}
            </Button>
          </div>
        </div>
      ) : (
        <div className='flex justify-end gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={decide.isPending}
            onClick={() => setRejecting(true)}
          >
            <XIcon data-icon='inline-start' />
            {t('np.knowledge.proposals.reject')}
          </Button>
          <Button
            size='sm'
            disabled={decide.isPending}
            onClick={() => decide.mutate('accept')}
          >
            {decide.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <CheckIcon data-icon='inline-start' />
            )}
            {t('np.knowledge.proposals.accept')}
          </Button>
        </div>
      )}
    </article>
  );
}
