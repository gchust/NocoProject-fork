import {
  AlertTriangleIcon,
  ArrowRightLeftIcon,
  AtSignIcon,
  BellIcon,
  BookCheckIcon,
  BookOpenTextIcon,
  DraftingCompassIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LayersIcon,
  type LucideIcon,
  MessageSquareIcon,
  OctagonPauseIcon,
  PackageCheckIcon,
  ShieldCheckIcon,
  UnlockIcon,
  UserCheckIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { cn } from '@/lib/utils';

import type { InboxItem } from '../types.js';

/** One icon per inbox type, so a card is recognisable before it is read. */
const TYPE_ICON: Readonly<Record<string, LucideIcon>> = {
  review_requested: PackageCheckIcon,
  agent_blocked: OctagonPauseIcon,
  proposal_pending: UsersIcon,
  approval_pending: ShieldCheckIcon,
  knowledge_proposal: BookOpenTextIcon,
  pr_review: GitPullRequestIcon,
  batch_done: LayersIcon,
  dependency_released: UnlockIcon,
  run_failed: AlertTriangleIcon,
  owner_assigned: UserCheckIcon,
  executor_assigned: UserPlusIcon,
  mentioned: AtSignIcon,
  commented: MessageSquareIcon,
  status_changed: ArrowRightLeftIcon,
  approval_decided: ShieldCheckIcon,
  pr_merged: GitMergeIcon,
  knowledge_decided: BookCheckIcon,
  design_review: DraftingCompassIcon,
};

/**
 * The type icon: amber for a decision that still waits ("needs you", §2.5), muted otherwise, red for a failure.
 */
export function InboxTypeIcon({
  item,
  className,
}: {
  readonly item: Pick<InboxItem, 'type' | 'kind' | 'resolvedAt'>;
  readonly className?: string;
}): ReactElement {
  const Icon = TYPE_ICON[item.type as string] ?? BellIcon;
  const waiting = item.kind === 'decision' && item.resolvedAt === null;
  return (
    <Icon
      aria-hidden='true'
      className={cn(
        'size-4 shrink-0',
        waiting
          ? 'text-attention'
          : item.type === 'run_failed'
            ? 'text-destructive'
            : 'text-muted-foreground',
        className,
      )}
    />
  );
}
