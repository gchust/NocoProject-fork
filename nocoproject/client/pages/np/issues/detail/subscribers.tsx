import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon, BellOffIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { setSubscription } from '../../api-collab.js';
import { npKeys } from '../../constants.js';
import { initials } from '../../format.js';
import type { IssueSubscriber } from '../../types.js';

const SHOWN = 5;

/** Subscriber avatars and the subscribe / unsubscribe button (§E, §J 2). */
export function Subscribers({
  issueId,
  subscribers,
  meUserId,
}: {
  readonly issueId: string;
  readonly subscribers: readonly IssueSubscriber[];
  readonly meUserId: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const subscribed = subscribers.some(
    (subscriber) => subscriber.userId === meUserId,
  );

  const toggle = useMutation({
    mutationFn: (next: boolean) => setSubscription(api, issueId, next),
    onSuccess: (_, next) => {
      toast.add({
        type: 'success',
        title: next
          ? t('np.subscribers.subscribed')
          : t('np.subscribers.unsubscribed'),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
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

  return (
    <div className='flex items-center justify-between gap-2'>
      {subscribers.length > 0 ? (
        <AvatarGroup
          aria-label={t('np.subscribers.label', { count: subscribers.length })}
        >
          {subscribers.slice(0, SHOWN).map((subscriber) => (
            <Tooltip key={subscriber.userId}>
              <TooltipTrigger
                render={
                  <Avatar size='sm'>
                    <AvatarFallback>{initials(subscriber.name)}</AvatarFallback>
                  </Avatar>
                }
              />
              <TooltipContent>
                {subscriber.name} ·{' '}
                {t(`np.subscribers.reason.${subscriber.reason}`, {
                  defaultValue: subscriber.reason,
                })}
              </TooltipContent>
            </Tooltip>
          ))}
          {subscribers.length > SHOWN ? (
            <AvatarGroupCount>+{subscribers.length - SHOWN}</AvatarGroupCount>
          ) : null}
        </AvatarGroup>
      ) : (
        <span className='text-sm text-muted-foreground'>
          {t('np.subscribers.none')}
        </span>
      )}
      <Button
        variant='outline'
        size='sm'
        disabled={toggle.isPending || !meUserId}
        onClick={() => toggle.mutate(!subscribed)}
      >
        {toggle.isPending ? (
          <Spinner data-icon='inline-start' />
        ) : subscribed ? (
          <BellOffIcon data-icon='inline-start' />
        ) : (
          <BellIcon data-icon='inline-start' />
        )}
        {subscribed
          ? t('np.subscribers.unsubscribe')
          : t('np.subscribers.subscribe')}
      </Button>
    </div>
  );
}
