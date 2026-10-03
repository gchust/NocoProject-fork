import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { type ReactElement } from 'react';

import { NpTag, type NpTone } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { testGitConnection } from '../../api-iter2.js';
import type { GitRepoAccess } from '../../types-iter2.js';

const ACCESS: Record<
  GitRepoAccess['access'],
  { readonly tone: NpTone; readonly key: string }
> = {
  write: { tone: 'green', key: 'np.repoWebhook.accessWrite' },
  read: { tone: 'amber', key: 'np.repoWebhook.accessRead' },
  none: { tone: 'red', key: 'np.repoWebhook.accessNone' },
};

const NO_PULL_REQUESTS = {
  tone: 'red',
  key: 'np.repoWebhook.accessNoPullRequests',
} as const;

/** A refused CI read (NP-229): a refresh still works, it only learns less about CI. */
const READ_GAPS = [
  { read: 'statuses', tone: 'amber', key: 'np.repoWebhook.accessNoStatuses' },
  { read: 'checks', tone: 'grey', key: 'np.repoWebhook.accessNoChecks' },
] as const;

/** The tags for one result: seeing a repository is not reading its pull requests (NP-229). */
function accessTags(
  repo: GitRepoAccess,
): readonly { readonly tone: NpTone; readonly key: string }[] {
  const { reads } = repo;
  if (repo.access === 'none' || !reads) return [ACCESS[repo.access]];
  return [
    reads.pullRequests ? ACCESS[repo.access] : NO_PULL_REQUESTS,
    ...READ_GAPS.filter((gap) => reads[gap.read] === false),
  ];
}

/**
 * NP-228: a new repository needs NocoProject's token to reach it as well as its webhook, or linking, refreshing and
 * merging its pull requests fails. Runs "Test connection" for this repository (`POST …/github/test` with `repo`, the
 * settings item `nocoproject.github` `update`) and shows what the token may do there; since NP-229 that includes
 * reading its pull requests, commit statuses and check suites.
 */
export function RepoAccessCheck({
  repo,
}: {
  readonly repo: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const check = useMutation({
    mutationFn: () => testGitConnection(api, repo),
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError &&
          error.code === 'GITHUB_NOT_CONFIGURED'
            ? t('np.github.notConfigured')
            : t('np.github.testFailed'),
      }),
  });
  const tags = check.data?.repo ? accessTags(check.data.repo) : [];

  return (
    <span className='flex flex-wrap items-center gap-2'>
      <Button
        type='button'
        variant='outline'
        size='sm'
        disabled={check.isPending}
        onClick={() => check.mutate()}
      >
        {check.isPending ? (
          <Spinner data-icon='inline-start' />
        ) : (
          <ShieldCheckIcon data-icon='inline-start' />
        )}
        {t('np.repoWebhook.checkAccess')}
      </Button>
      {check.isPending
        ? null
        : tags.map((tag) => (
            <NpTag key={tag.key} tone={tag.tone} dot>
              {t(tag.key)}
            </NpTag>
          ))}
    </span>
  );
}
