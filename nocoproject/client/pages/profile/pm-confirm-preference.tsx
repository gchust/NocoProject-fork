import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

import { fetchMyPreferences, updateMyPreferences } from '../np/api.js';
import { npKeys } from '../np/constants.js';

/**
 * "Always confirm first" (NP-183 §6.4, `pmConfirmAll`): with it on, every operation plan of the project manager waits
 * for the member's "Run", even the ones that would run at once. Saved as soon as the switch moves, with the
 * preferences' revision (`PATCH /np/me/preferences`).
 */
export function PmConfirmPreference(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: npKeys.myPreferences,
    queryFn: ({ signal }) => fetchMyPreferences(api, signal),
    retry: false,
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (pmConfirmAll: boolean) =>
      updateMyPreferences(api, {
        revision: preferences.data?.revision,
        pmConfirmAll,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(npKeys.myPreferences, updated);
      toast.add({
        type: 'success',
        title: updated.pmConfirmAll
          ? t('np.pmSetup.confirmAllOn')
          : t('np.pmSetup.confirmAllOff'),
      });
    },
    onError: () => {
      // A stale revision or a failed write: show what the server holds.
      void queryClient.invalidateQueries({ queryKey: npKeys.myPreferences });
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('np.pmSetup.confirmTitle')}</CardTitle>
        <CardDescription>{t('np.pmSetup.confirmDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className='max-w-2xl'>
          <Field orientation='horizontal'>
            <FieldContent>
              <FieldLabel htmlFor='profile-pm-confirm-all'>
                {t('np.pmSetup.confirmAll')}
              </FieldLabel>
              <FieldDescription>
                {t('np.pmSetup.confirmAllHint')}
              </FieldDescription>
            </FieldContent>
            <Switch
              id='profile-pm-confirm-all'
              checked={preferences.data?.pmConfirmAll === true}
              disabled={!preferences.isSuccess || save.isPending}
              onCheckedChange={(value) => save.mutate(value)}
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
