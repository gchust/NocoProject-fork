import { useCan } from '@nocobase/app-plugin-authorization/client';
import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

import { setRuntimePmAllowed } from '../api-pm.js';
import { settingsCheck } from '../config/config-access.js';
import { npKeys } from '../constants.js';
import type { Runtime } from '../types.js';

/**
 * Whether a public runtime may run members' personal project managers (NP-183 §6.3, `pmAllowed`). Only public
 * runtimes offer it; owner / admin (the general settings' `update`) get the switch, everyone else reads the state.
 */
export function PmAllowedCell({
  runtime,
}: {
  readonly runtime: Runtime;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const canEdit = useCan(settingsCheck('general', 'update')).can;
  const save = useMutation({
    mutationFn: (value: boolean) => setRuntimePmAllowed(api, runtime.id, value),
    onSuccess: (updated) => {
      toast.add({
        type: 'success',
        title: updated.pmAllowed
          ? t('np.pmSetup.pmAllowedOn', { name: runtime.name })
          : t('np.pmSetup.pmAllowedOff', { name: runtime.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      }),
  });
  if (runtime.visibility !== 'public')
    return (
      <span
        className='text-muted-foreground'
        title={t('np.pmSetup.pmAllowedPrivate')}
      >
        —
      </span>
    );
  const checked = runtime.pmAllowed === true;
  if (!canEdit)
    return <span>{checked ? t('np.pmSetup.yes') : t('np.pmSetup.no')}</span>;
  return (
    <Switch
      aria-label={t('np.pmSetup.pmAllowed', { name: runtime.name })}
      checked={checked}
      disabled={save.isPending}
      onCheckedChange={(value) => save.mutate(value)}
    />
  );
}
