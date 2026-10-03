import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsIcon, PlugZapIcon, ZapIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { RouteDialog } from '@/components/route-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';

import {
  BUILTIN_CANDIDATES_KEY,
  enableBuiltinRuntime,
  fetchBuiltinCandidates,
  runtimeTypeErrorOf,
} from '../api-runtime-types.js';
import { settingsCheck } from '../config/config-access.js';
import { npKeys } from '../constants.js';
import type { BuiltinCandidate } from '../types-runtime-types.js';

/** The AI plugin's model services page (`@nocobase/app-plugin-ai-employee`); services are added in `config.yml`. */
export const AI_LLM_SERVICES_PATH = '/settings/ai/llm-services';
const AI_SETTINGS_CHECK = {
  resource: { type: 'page', id: 'ai.settings' },
  action: 'access',
} as const;

/**
 * Route `/runtimes/builtin` (NP-219 §4.1): choose one of the AI plugin's model services to use as a built-in runtime.
 * Nothing about the service is edited here; its settings stay in the AI plugin, linked for those who may open them.
 */
export default function BuiltinRuntimePage(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog
      title={t('np.builtinRuntimes.pick.title')}
      description={t('np.builtinRuntimes.pick.description')}
      className='sm:max-w-2xl'
      footer={<PickFooter />}
    >
      <PickBody />
    </RouteDialog>
  );
}

function PickBody(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const access = useCan(settingsCheck('general', 'update'));
  const candidates = useQuery({
    queryKey: BUILTIN_CANDIDATES_KEY,
    queryFn: () => fetchBuiltinCandidates(api),
    enabled: access.can,
    retry: false,
  });

  if (access.isPending) return <NpListSkeleton rows={2} />;
  if (!access.can)
    return (
      <Alert>
        <AlertDescription>{t('np.common.forbidden')}</AlertDescription>
      </Alert>
    );
  if (candidates.isError && !candidates.data)
    return (
      <NpLoadError
        title={t('np.builtinRuntimes.loadFailed')}
        error={candidates.error}
        onRetry={() => void candidates.refetch()}
      />
    );
  if (!candidates.data) return <NpListSkeleton rows={3} />;
  if (candidates.data.plugin === 'missing')
    return (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <PlugZapIcon />
          </EmptyMedia>
          <EmptyTitle>{t('np.builtinRuntimes.pluginMissingTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('np.builtinRuntimes.pluginMissingDescription')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (candidates.data.services.length === 0)
    return (
      <Empty className='border'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <ZapIcon />
          </EmptyMedia>
          <EmptyTitle>
            {t('np.builtinRuntimes.pick.noServicesTitle')}
          </EmptyTitle>
          <EmptyDescription>
            {t('np.builtinRuntimes.pick.noServicesDescription')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <ul
      aria-label={t('np.builtinRuntimes.pick.listLabel')}
      className='divide-y rounded-lg border'
    >
      {candidates.data.services.map((service) => (
        <CandidateRow key={service.llmService} service={service} />
      ))}
    </ul>
  );
}

function CandidateRow({
  service,
}: {
  readonly service: BuiltinCandidate;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => enableBuiltinRuntime(api, service.llmService),
    onSuccess: (runtime) =>
      toast.add({
        type: 'success',
        title: t('np.builtinRuntimes.enabled', { name: runtime.name }),
      }),
    onError: (error: unknown) => {
      const code = runtimeTypeErrorOf(error);
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          code === 'INVALID_LLM_SERVICE' ||
          code === 'RUNTIME_EXISTS' ||
          code === 'BUILTIN_RUNTIME_UNAVAILABLE'
            ? t(`np.builtinRuntimes.errors.${code}`)
            : t('np.common.requestFailed'),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
      void queryClient.invalidateQueries({ queryKey: BUILTIN_CANDIDATES_KEY });
    },
  });
  const titleId = `np-builtin-candidate-${service.llmService}`;
  return (
    <li className='flex items-center gap-3 p-3'>
      <div className='min-w-0 flex-1 space-y-0.5'>
        <div className='flex min-w-0 items-center gap-2'>
          <span id={titleId} className='truncate font-medium'>
            {service.title}
          </span>
          <NpTag tone='grey'>{service.provider}</NpTag>
        </div>
        <p
          className='truncate text-xs text-muted-foreground'
          title={service.enabledModels.map((model) => model.label).join(', ')}
        >
          {t('np.builtinRuntimes.pick.models', {
            count: service.enabledModels.length,
            names: service.enabledModels.map((model) => model.label).join(', '),
          })}
        </p>
      </div>
      {service.runtimeId ? (
        <NpTag tone='green'>{t('np.builtinRuntimes.pick.inUse')}</NpTag>
      ) : (
        <Button
          size='sm'
          variant='outline'
          disabled={enable.isPending}
          aria-describedby={titleId}
          onClick={() => enable.mutate()}
        >
          {enable.isPending ? <Spinner data-icon='inline-start' /> : null}
          {t('np.builtinRuntimes.pick.enable')}
        </Button>
      )}
    </li>
  );
}

function PickFooter(): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  const canOpenAiSettings = useCan(AI_SETTINGS_CHECK).can;
  return (
    <>
      {canOpenAiSettings ? (
        <Button
          variant='ghost'
          className='sm:mr-auto'
          nativeButton={false}
          render={<Link to={AI_LLM_SERVICES_PATH} />}
        >
          <SettingsIcon data-icon='inline-start' />
          {t('np.builtinRuntimes.pick.manage')}
        </Button>
      ) : null}
      <Button onClick={() => void close()}>
        {t('np.builtinRuntimes.pick.done')}
      </Button>
    </>
  );
}
