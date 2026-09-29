import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

import { updateMyPreferences } from '../api.js';
import { npKeys } from '../constants.js';
import {
  playInboxChime,
  useInboxChimePreference,
} from '../inbox/inbox-chime.js';
import type { MemberPreferences } from '../types.js';
import { ConfigSectionHeading } from './config-section.js';

/**
 * The viewer's own reminder preferences at the top of Settings → General (NP-108). Unlike the workspace settings below it,
 * every member may change these; they are kept with the account (`PATCH /np/me/preferences`) and saved as soon as the
 * switch moves. Turning the chime on plays it once.
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
    <section
      className='space-y-4'
      aria-labelledby='np-config-reminders-heading'
    >
      <ConfigSectionHeading
        id='np-config-reminders-heading'
        title={t('np.inbox.chime.settingsTitle')}
        description={t('np.inbox.chime.settingsDescription')}
      />
      <FieldGroup className='max-w-2xl'>
        <Field orientation='horizontal'>
          <FieldContent>
            <FieldLabel htmlFor='np-settings-inbox-chime'>
              {t('np.inbox.chime.label')}
            </FieldLabel>
            <FieldDescription>{t('np.inbox.chime.hint')}</FieldDescription>
          </FieldContent>
          <Switch
            id='np-settings-inbox-chime'
            checked={enabled}
            disabled={!loaded || save.isPending}
            onCheckedChange={(value) => {
              if (value) playInboxChime({ preview: true });
              save.mutate(value);
            }}
          />
        </Field>
      </FieldGroup>
    </section>
  );
}
