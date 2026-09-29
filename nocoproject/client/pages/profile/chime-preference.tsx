import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

import { updateMyPreferences } from '../np/api.js';
import { npKeys } from '../np/constants.js';
import {
  playInboxChime,
  useInboxChimePreference,
} from '../np/inbox/inbox-chime.js';
import type { MemberPreferences } from '../np/types.js';

/**
 * The viewer's own reminder preferences on `/profile` (NP-108, moved here from Settings → General by NP-153: a
 * personal preference, not a workspace setting). Kept with the account (`PATCH /np/me/preferences`) and saved as soon
 * as the switch moves. Turning the chime on plays it once.
 */
export function ChimePreferenceSection(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { enabled, loaded } = useInboxChimePreference();
  const save = useMutation({
    mutationFn: (inboxChime: boolean) =>
      updateMyPreferences(api, { inboxChime }),
    onMutate: (inboxChime) => {
      const previous = queryClient.getQueryData<MemberPreferences>(
        npKeys.myPreferences,
      );
      queryClient.setQueryData<MemberPreferences>(npKeys.myPreferences, {
        ...previous,
        inboxChime,
      });
      return { previous };
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData(npKeys.myPreferences, preferences);
      toast.add({
        type: 'success',
        title: preferences.inboxChime
          ? t('np.inbox.chime.turnedOn')
          : t('np.inbox.chime.turnedOff'),
      });
    },
    onError: (_error, _inboxChime, snapshot) => {
      queryClient.setQueryData(npKeys.myPreferences, snapshot?.previous);
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
        <CardTitle>{t('profile.preferences')}</CardTitle>
        <CardDescription>
          {t('np.inbox.chime.settingsDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className='max-w-2xl'>
          <Field orientation='horizontal'>
            <FieldContent>
              <FieldLabel htmlFor='profile-chime'>
                {t('np.inbox.chime.label')}
              </FieldLabel>
              <FieldDescription>{t('np.inbox.chime.hint')}</FieldDescription>
            </FieldContent>
            <Switch
              id='profile-chime'
              checked={enabled}
              disabled={!loaded || save.isPending}
              onCheckedChange={(value) => {
                if (value) playInboxChime({ preview: true });
                save.mutate(value);
              }}
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
