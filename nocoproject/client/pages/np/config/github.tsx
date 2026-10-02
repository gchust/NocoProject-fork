import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  LockIcon,
  CopyIcon,
  PlugZapIcon,
  RefreshCwIcon,
  SaveIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpDetailSkeleton, NpEmpty, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import {
  fetchGitConnection,
  saveGitConnection,
  testGitConnection,
} from '../api-iter2.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { GitConnectionView } from '../types.js';
import { ConfigSectionHeading } from './config-section.js';
import { generateSecret, gitConnectionChanges } from './github-model.js';
import { SecretInput } from './secret-input.js';
import { settingsCheck } from './config-access.js';
import { SignalRulesSection } from './signal-rules.js';
import { WebhookSecretReveal } from './webhook-secret-reveal.js';

/**
 * Tab `/config/github` (iteration 2 §C, moved from the system settings shell in iteration 3 §G; the settings item
 * `nocoproject.github`, owner/admin by default, NP-117): the API
 * base URL, the token used to read pull requests, and the webhook secret GitHub signs deliveries with. Secrets are
 * write-only — the tab only shows whether each is set — except that whoever may change the GitHub item can show the
 * saved webhook secret to add it to another repository (NP-227). The webhook URL is what to paste into the repository's webhook
 * settings; "Test connection" signs in with the token. Below the connection, the GitHub signal rules
 * (`signal-rules.tsx`): whether failed checks or merge conflicts on a linked pull request wake the executor agent.
 * Members see why the tab is empty instead of a 403.
 */
export default function GithubConfigTab(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const access = useCan(settingsCheck('github', 'read'));
  const connection = useQuery({
    queryKey: npKeys.gitConnection,
    queryFn: () => fetchGitConnection(api),
    enabled: access.can,
    retry: (count, error) =>
      !(error instanceof ApiClientError && error.status === 403) && count < 2,
  });

  if (access.isPending) return <NpDetailSkeleton />;
  if (!access.can) {
    return (
      <NpEmpty
        icon={<LockIcon />}
        title={t('np.config.adminOnlyTitle')}
        description={t('np.github.adminOnly')}
      />
    );
  }
  if (connection.isError && !connection.data) {
    return (
      <NpLoadError
        title={t('np.github.loadFailed')}
        error={connection.error}
        onRetry={() => void connection.refetch()}
      />
    );
  }
  if (!connection.data) return <NpDetailSkeleton />;
  return (
    <section className='space-y-4' aria-labelledby='np-config-github-heading'>
      <ConfigSectionHeading
        id='np-config-github-heading'
        title={t('np.github.title')}
        description={t('np.github.description')}
      />
      <GithubForm
        key={`${connection.data.apiBaseUrl}:${connection.data.tokenSet}:${connection.data.webhookSecretSet}`}
        connection={connection.data}
      />
      <SignalRulesSection source='github' />
    </section>
  );
}

function SecretState({ set }: { readonly set: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <NpTag tone={set ? 'green' : 'grey'} dot>
      {set ? t('np.github.set') : t('np.github.notSet')}
    </NpTag>
  );
}

function GithubForm({
  connection,
}: {
  readonly connection: GitConnectionView;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const canUpdate = useCan(settingsCheck('github', 'update')).can;
  // Bumped on save, so a secret shown before a replacement is not left on screen.
  const [revision, setRevision] = useState(0);
  const [apiBaseUrl, setApiBaseUrl] = useState(connection.apiBaseUrl);
  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [clearSecret, setClearSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [generated, setGenerated] = useState(false);
  const changes = gitConnectionChanges(connection, {
    apiBaseUrl,
    token,
    webhookSecret,
    clearToken,
    clearSecret,
  });

  const save = useMutation({
    mutationFn: () => saveGitConnection(api, changes),
    onSuccess: (next) => {
      toast.add({ type: 'success', title: t('np.github.saved') });
      // Saved secrets are write-only: the typed or generated values leave the form once stored.
      setToken('');
      setWebhookSecret('');
      setShowToken(false);
      setShowSecret(false);
      setGenerated(false);
      setRevision((value) => value + 1);
      queryClient.setQueryData(npKeys.gitConnection, next);
      void queryClient.invalidateQueries({ queryKey: npKeys.gitConnection });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.github.adminOnly')
            : t('np.common.requestFailed'),
      }),
  });
  const test = useMutation({
    mutationFn: () => testGitConnection(api),
    onSuccess: (result) =>
      toast.add(
        result.ok
          ? {
              type: 'success',
              title: t('np.github.testOk', { login: result.login ?? '—' }),
            }
          : {
              type: 'error',
              priority: 'high',
              title: t('np.github.testFailed'),
            },
      ),
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

  async function copyWebhook(): Promise<void> {
    try {
      await navigator.clipboard.writeText(connection.webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.connect.copyFailed'),
      });
    }
  }

  return (
    <FieldGroup className='max-w-2xl'>
      <Field>
        <FieldLabel htmlFor='np-github-base'>
          {t('np.github.apiBaseUrl')}
        </FieldLabel>
        <Input
          id='np-github-base'
          value={apiBaseUrl}
          placeholder='https://api.github.com'
          onChange={(event) => setApiBaseUrl(event.target.value)}
        />
        <FieldDescription>{t('np.github.apiBaseUrlHint')}</FieldDescription>
      </Field>
      <Field>
        <div className='flex items-center gap-2'>
          <FieldLabel htmlFor='np-github-token'>
            {t('np.github.token')}
          </FieldLabel>
          <SecretState set={connection.tokenSet && !clearToken} />
        </div>
        <div className='flex gap-2'>
          <SecretInput
            id='np-github-token'
            value={token}
            visible={showToken}
            onVisibleChange={setShowToken}
            placeholder={
              connection.tokenSet ? t('np.github.keepValue') : 'ghp_…'
            }
            onChange={(value) => {
              setToken(value);
              setClearToken(false);
            }}
          />
          {connection.tokenSet ? (
            <Button
              type='button'
              variant='outline'
              aria-pressed={clearToken}
              onClick={() => {
                setClearToken((value) => !value);
                setToken('');
              }}
            >
              {t('np.github.clear')}
            </Button>
          ) : null}
        </div>
        <FieldDescription>{t('np.github.tokenHint')}</FieldDescription>
      </Field>
      <Field>
        <div className='flex items-center gap-2'>
          <FieldLabel htmlFor='np-github-secret'>
            {t('np.github.webhookSecret')}
          </FieldLabel>
          <SecretState set={connection.webhookSecretSet && !clearSecret} />
        </div>
        <div className='flex gap-2'>
          <SecretInput
            id='np-github-secret'
            value={webhookSecret}
            visible={showSecret}
            onVisibleChange={setShowSecret}
            placeholder={
              connection.webhookSecretSet ? t('np.github.keepValue') : ''
            }
            onChange={(value) => {
              setWebhookSecret(value);
              setClearSecret(false);
              setGenerated(false);
            }}
          />
          <Button
            type='button'
            variant='outline'
            onClick={() => {
              // Shown in plain text until saved, so it can be copied into `gh webhook forward --secret`.
              setWebhookSecret(generateSecret());
              setShowSecret(true);
              setGenerated(true);
              setClearSecret(false);
            }}
          >
            <RefreshCwIcon data-icon='inline-start' />
            {t('np.github.generate')}
          </Button>
          {connection.webhookSecretSet ? (
            <Button
              type='button'
              variant='outline'
              aria-pressed={clearSecret}
              onClick={() => {
                setClearSecret((value) => !value);
                setWebhookSecret('');
              }}
            >
              {t('np.github.clear')}
            </Button>
          ) : null}
        </div>
        <FieldDescription>
          {generated
            ? t('np.githubSecrets.generatedHint')
            : t('np.github.webhookSecretHint')}
        </FieldDescription>
        {connection.webhookSecretSet && !clearSecret && canUpdate ? (
          <WebhookSecretReveal key={revision} />
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor='np-github-webhook'>
          {t('np.github.webhookUrl')}
        </FieldLabel>
        <div className='flex gap-2'>
          <Input
            id='np-github-webhook'
            value={connection.webhookUrl}
            readOnly
            className='font-mono text-xs'
          />
          <Button
            type='button'
            variant='outline'
            size='icon'
            aria-label={copied ? t('np.connect.copied') : t('np.connect.copy')}
            onClick={() => void copyWebhook()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <FieldDescription>
          {t('np.github.webhookUrlHint')}{' '}
          {connection.lastEventAt
            ? t('np.github.lastEvent', {
                time: format.dateTime(connection.lastEventAt),
              })
            : t('np.github.noEvents')}
        </FieldDescription>
      </Field>
      <div className='flex flex-wrap justify-end gap-2'>
        <Button
          variant='outline'
          disabled={test.isPending || !connection.tokenSet}
          onClick={() => test.mutate()}
        >
          {test.isPending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <PlugZapIcon data-icon='inline-start' />
          )}
          {t('np.github.test')}
        </Button>
        <Button
          disabled={save.isPending || Object.keys(changes).length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <SaveIcon data-icon='inline-start' />
          )}
          {t('actions.save')}
        </Button>
      </div>
    </FieldGroup>
  );
}
