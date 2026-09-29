import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMergeIcon } from 'lucide-react';
import { type ReactElement } from 'react';
import { Link } from 'react-router';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import {
  fetchMergePreflight,
  mergeBlockerOfError,
  mergePullRequest,
} from '../../api-iter4.js';
import { npKeys, statusLabelKey } from '../../constants.js';
import type { MergeBlocker, MergePreflight } from '../../types-iter4.js';
import { useWorkspaceViewer } from '../../use-workspace-viewer.js';
import { githubErrorText } from './pr-model.js';

export interface MergeTarget {
  readonly issueId: string;
  readonly pullRequestId: string;
  /** `owner/repo#12` for the title; without it the title names no PR */
  readonly label?: string;
}

const preflightKey = (target: MergeTarget) =>
  [...npKeys.issue(target.issueId), 'merge', target.pullRequestId] as const;

/**
 * The merge confirmation (NP-85), shared by the PR card and the inbox's `pr_review` action. Opening it asks GitHub
 * for the PR's current state (never the stored snapshot): the dialog shows the squash into the base branch, the
 * commit title and what happens to the issue, or why it cannot be merged. Confirming posts the head it showed, so
 * new commits in between are refused (`PR_CHANGED`) and the check runs again. The issue itself moves when GitHub's
 * webhook reports the merge.
 */
export function MergePullRequestDialog({
  target,
  onClose,
}: {
  readonly target: MergeTarget | null;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        {target ? <MergeBody target={target} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MergeBody({
  target,
  onClose,
}: {
  readonly target: MergeTarget;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { isAdmin } = useWorkspaceViewer();
  const preflight = useQuery({
    queryKey: preflightKey(target),
    queryFn: () =>
      fetchMergePreflight(api, target.issueId, target.pullRequestId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const merge = useMutation({
    mutationFn: (headSha: string) =>
      mergePullRequest(api, target.issueId, target.pullRequestId, headSha),
    onSuccess: () => {
      toast.add({ type: 'success', title: t('np.prMerge.merged') });
      onClose();
    },
    onError: (error: unknown) => {
      // The preflight sits under the issue key, so `onSettled` checks GitHub again.
      if (error instanceof ApiClientError && error.code === 'PR_CHANGED') {
        toast.add({ type: 'error', title: t('np.prMerge.changed') });
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.prMerge.failed'),
        description: mergeErrorText(t, error),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: npKeys.issue(target.issueId),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
    },
  });
  const failure = merge.error ?? preflight.error;
  const tokenForbidden =
    failure instanceof ApiClientError &&
    failure.code === 'GITHUB_MERGE_FORBIDDEN';
  const data = preflight.data;
  const blocker =
    data?.blocker ??
    (merge.error instanceof ApiClientError
      ? mergeBlockerOfError(merge.error.payload)
      : null);

  return (
    <div className='space-y-4'>
      <DialogHeader>
        <DialogTitle>
          {target.label
            ? t('np.prMerge.title', { pr: target.label })
            : t('np.prMerge.titleGeneric')}
        </DialogTitle>
        <DialogDescription>
          {data
            ? t('np.prMerge.method', { base: data.baseRef || 'main' })
            : t('np.prMerge.checking')}
        </DialogDescription>
      </DialogHeader>
      {preflight.isPending ? (
        <div className='space-y-2' data-testid='np-merge-checking'>
          <Skeleton className='h-4 w-3/4' />
          <Skeleton className='h-4 w-1/2' />
        </div>
      ) : data ? (
        <MergeFacts preflight={data} />
      ) : null}
      {preflight.isError ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {mergeErrorText(t, preflight.error)}
          </AlertDescription>
        </Alert>
      ) : null}
      {blocker ? (
        <Alert data-testid='np-merge-blocker'>
          <AlertDescription>
            {t(`np.prMerge.blocker.${blocker}`)}
          </AlertDescription>
        </Alert>
      ) : null}
      {tokenForbidden ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('np.prMerge.forbiddenToken')}
            {isAdmin ? (
              <>
                {' '}
                <Link
                  to='/config/github'
                  className='underline underline-offset-4'
                >
                  {t('np.prMerge.openSettings')}
                </Link>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button
          type='button'
          variant='outline'
          disabled={merge.isPending}
          onClick={onClose}
        >
          {t('actions.cancel')}
        </Button>
        <Button
          type='button'
          disabled={!data || data.blocker !== null || merge.isPending}
          onClick={() => {
            if (data) merge.mutate(data.headSha);
          }}
        >
          {merge.isPending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <GitMergeIcon data-icon='inline-start' />
          )}
          {t('np.prMerge.confirm')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function MergeFacts({
  preflight,
}: {
  readonly preflight: MergePreflight;
}): ReactElement {
  const { t } = useTranslation();
  const after = preflight.statusAfter;
  return (
    <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm'>
      <dt className='text-muted-foreground'>{t('np.prMerge.commitTitle')}</dt>
      <dd className='min-w-0 break-words'>{preflight.commitTitle}</dd>
      <dt className='text-muted-foreground'>{t('np.prMerge.after')}</dt>
      <dd data-testid='np-merge-after'>
        {after.statusKey
          ? t('np.prMerge.statusAfter', {
              status: t(statusLabelKey(after.statusKey), {
                defaultValue: after.statusName ?? after.statusKey,
              }),
            })
          : t(`np.prMerge.keep.${after.keepReason ?? 'setting'}`)}
      </dd>
    </dl>
  );
}

/** A merge check or merge failure in words; GitHub's own text never reaches the client. */
function mergeErrorText(t: (key: string) => string, error: unknown): string {
  if (!(error instanceof ApiClientError)) return t('np.common.requestFailed');
  const github = githubErrorText(t, error);
  if (github) return github;
  switch (error.code) {
    case 'GITHUB_MERGE_FORBIDDEN':
      return t('np.prMerge.forbiddenToken');
    case 'PR_CHANGED':
      return t('np.prMerge.changed');
    case 'PR_NOT_MERGEABLE': {
      const blocker: MergeBlocker | null = mergeBlockerOfError(error.payload);
      return blocker
        ? t(`np.prMerge.blocker.${blocker}`)
        : t('np.common.requestFailed');
    }
    default:
      return error.status === 403
        ? t('np.common.forbidden')
        : t('np.common.requestFailed');
  }
}
