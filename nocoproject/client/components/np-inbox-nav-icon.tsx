import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { fetchInboxPending } from '@/pages/np/api-inbox';
import {
  armInboxChime,
  playInboxChime,
  useInboxChimePreference,
} from '@/pages/np/inbox/inbox-chime';
import { inboxBadgeText, inboxTitle } from '@/pages/np/inbox/inbox-model';
import { npKeys } from '@/pages/np/constants';
import type { InboxTopicPayload } from '@/pages/np/types';
import { useRealtimeTopic } from '@/pages/np/use-realtime';

/**
 * The inbox navigation icon with the number of decisions waiting on the viewer (NP-107).
 *
 * The badge counts what still needs the viewer's action, not what is unread (nocosolution/guidelines/frontend-standard.md
 * §2.2): a decision that was opened but not settled keeps counting until it is resolved or archived. The navigation
 * contract only takes an icon component, so the badge rides on the icon rather than on a change to the shared
 * navigation tree. It reads `GET /np/inbox/pending-count` and refreshes on the `np:inbox` user topic, the same signal
 * the inbox page listens to; the key sits under `npKeys.inbox`, so either refresh updates both.
 *
 * The same count prefixes the browser tab title (`(3) NocoProject`) so it shows while the tab is in the background.
 * The title is static (set once by `service-provider.ts`), and this icon is mounted once for the whole app layout, so
 * it owns the prefix: it adds it while the count is above zero and removes it on unmount (sign-out, Settings layout).
 *
 * For the same reason it also rings the chime (NP-108) when the count goes up after the first load, unless the viewer
 * turned it off on `/profile` (NP-153).
 */
export function NpInboxNavIcon({
  className,
}: {
  readonly className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: npKeys.inboxPending,
    queryFn: ({ signal }) => fetchInboxPending(api, signal),
    retry: false,
    staleTime: 30_000,
  });
  useRealtimeTopic<InboxTopicPayload>('np:inbox', () => {
    void queryClient.invalidateQueries({ queryKey: npKeys.inbox });
  });
  const count = pending.data?.decision ?? 0;
  const text = inboxBadgeText(count);
  useEffect(() => {
    document.title = inboxTitle(document.title, text);
    return () => {
      document.title = inboxTitle(document.title, null);
    };
  }, [text]);

  const { enabled: chime } = useInboxChimePreference();
  const previousRef = useRef<number | null>(null);
  useEffect(() => {
    armInboxChime();
  }, []);
  useEffect(() => {
    const next = pending.data?.decision;
    if (next === undefined) return;
    if (chime && previousRef.current !== null && next > previousRef.current) {
      playInboxChime();
    }
    previousRef.current = next;
  }, [pending.data, chime]);

  // The count is a pill at the right end of the navigation row (the row is `relative`), amber because it means
  // "needs you" (nocosolution/guidelines/frontend-standard.md §2.1); in the desktop icon mode (the shadcn sidebar's
  // `data-collapsible=icon`) it moves to the icon's corner.
  // A hover/focus tooltip states the pending-vs-unread definition, since a bare number badge otherwise reads as an
  // unread count by the common mailbox mental model.
  const badge = text ? (
    <span
      className={cn(
        'absolute top-1/2 right-2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-attention px-1 text-xs leading-none font-semibold text-attention-foreground tabular-nums',
        'group-data-[collapsible=icon]:top-0.5 group-data-[collapsible=icon]:right-0.5 group-data-[collapsible=icon]:h-3.5 group-data-[collapsible=icon]:min-w-3.5 group-data-[collapsible=icon]:translate-y-0 group-data-[collapsible=icon]:px-0.5',
      )}
      data-testid='np-inbox-badge'
    >
      {text}
      <span className='sr-only'>
        {t('np.inbox.pendingDecisions', { count })}
      </span>
    </span>
  ) : null;

  return (
    <span className='inline-flex'>
      <InboxIcon className={className} aria-hidden='true' />
      {badge ? (
        <Tooltip>
          <TooltipTrigger render={badge} />
          <TooltipContent side='bottom'>
            {t('np.inbox.pendingBadgeHint', { count })}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
