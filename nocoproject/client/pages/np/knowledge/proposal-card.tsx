import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpTag } from '@/components/np-tag';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  decideKnowledgeProposal,
  fetchKnowledgeDetail,
  staleVersionOfError,
  type KnowledgeProposalDecision,
} from '../api-knowledge.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { KnowledgeProposal } from '../types-iter3.js';
import { KnowledgeContentBlock, KnowledgeDiff } from './knowledge-diff.js';

interface DecideVariables {
  readonly decision: KnowledgeProposalDecision;
  readonly confirmStale?: boolean;
}

/**
 * One pending agent proposal (§B, NP-139): who proposed it and why, the source issue, the version it is based on
 * against the document's current version (flagged stale once the document moved on), the proposed text behind a
 * disclosure — a line diff against the current version by default, the full text on demand — and accept / reject.
 * Accepting a stale proposal asks for confirmation first; the card is shown only to people who may decide (the list
 * endpoint already filters).
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
  const [contentOpen, setContentOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [staleVersion, setStaleVersion] = useState<number | null>(null);
  // An update proposal has an empty `title` (= keep the title); the document's title names it.
  const name = proposal.docTitle || proposal.title;
  const [comment, setComment] = useState('');

  const isStale =
    proposal.docId !== null &&
    typeof proposal.baseVersion === 'number' &&
    typeof proposal.currentVersion === 'number' &&
    proposal.currentVersion > proposal.baseVersion;

  const doc = useQuery({
    queryKey: npKeys.knowledgeDoc(proposal.docId ?? ''),
    queryFn: ({ signal }) =>
      fetchKnowledgeDetail(api, proposal.docId ?? '', signal),
    enabled: contentOpen && proposal.docId !== null,
  });

  const decide = useMutation({
    mutationFn: ({ decision, confirmStale }: DecideVariables) =>
      decideKnowledgeProposal(
        api,
        proposal.id,
        decision,
        comment.trim() || undefined,
        confirmStale,
      ),
    onSuccess: (_, variables) => {
      toast.add({
        type: 'success',
        title:
          variables.decision === 'accept'
            ? t('np.knowledge.proposals.accepted', { title: name })
            : t('np.knowledge.proposals.rejected', { title: name }),
      });
      setRejecting(false);
      setComment('');
      setStaleVersion(null);
    },
    onError: (error: unknown, variables) => {
      const stale =
        variables.decision === 'accept' &&
        !variables.confirmStale &&
        error instanceof ApiClientError &&
        error.status === 409 &&
        error.code === 'KNOWLEDGE_PROPOSAL_STALE'
          ? staleVersionOfError(error.payload)
          : null;
      if (stale !== null) {
        setStaleVersion(stale);
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 409
              ? t('np.knowledge.proposals.alreadyDecided')
              : t('np.common.requestFailed'),
      });
    },
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
        {proposal.docId ? (
          typeof proposal.baseVersion === 'number' ? (
            <span className='font-mono text-xs text-muted-foreground'>
              {t('np.knowledge.proposals.versionRange', {
                base: proposal.baseVersion,
                current: proposal.currentVersion ?? proposal.baseVersion,
              })}
            </span>
          ) : null
        ) : (
          <NpTag tone='blue'>{t('np.knowledge.proposals.new')}</NpTag>
        )}
        {isStale ? (
          <NpTag tone='amber'>{t('np.knowledge.proposals.stale')}</NpTag>
        ) : null}
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
      <Collapsible open={contentOpen} onOpenChange={setContentOpen}>
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
          <div className='mt-2 space-y-2'>
            {proposal.docId ? (
              doc.data ? (
                <>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='text-xs text-muted-foreground'>
                      {t('np.decision.knowledge.against', {
                        version: doc.data.doc.version,
                      })}
                    </p>
                    <Button
                      variant='ghost'
                      size='xs'
                      onClick={() => setFull((value) => !value)}
                    >
                      {full
                        ? t('np.decision.knowledge.showDiff')
                        : t('np.decision.knowledge.showFull')}
                    </Button>
                  </div>
                  {full ? (
                    <KnowledgeContentBlock content={proposal.content} />
                  ) : (
                    <KnowledgeDiff
                      before={doc.data.doc.content}
                      after={proposal.content}
                    />
                  )}
                </>
              ) : (
                <Skeleton className='h-32 w-full' />
              )
            ) : (
              <KnowledgeContentBlock content={proposal.content} />
            )}
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
              onClick={() => decide.mutate({ decision: 'reject' })}
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
            onClick={() => decide.mutate({ decision: 'accept' })}
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
      <AlertDialog
        open={staleVersion !== null}
        onOpenChange={(open) => {
          if (!open) setStaleVersion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.knowledge.proposals.staleTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.knowledge.proposals.staleDescription', {
                base: proposal.baseVersion,
                current: staleVersion,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ decision: 'accept', confirmStale: true })
              }
            >
              {decide.isPending ? <Spinner data-icon='inline-start' /> : null}
              {t('np.knowledge.proposals.acceptAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
