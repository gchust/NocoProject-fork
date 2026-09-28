import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SmilePlusIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { addReaction, removeReaction } from '../../api-iter2.js';
import { npKeys } from '../../constants.js';
import type { IssueComment, IssueDetail } from '../../types.js';
import { REACTION_EMOJIS } from '../../types-iter2.js';
import {
  hasReacted,
  toggleReaction,
  updateDetailComment,
  visibleReactions,
} from './reaction-model.js';

/**
 * Reactions under a comment (iteration 2 §F): each used emoji as a toggle with its count, the names in a tooltip, and
 * a picker with the fixed set. Toggling updates the cached detail at once and reloads it afterwards.
 */
export function CommentReactions({
  issueId,
  comment,
  meUserId,
  userName,
}: {
  readonly issueId: string;
  readonly comment: IssueComment;
  readonly meUserId: string | undefined;
  readonly userName: (userId: string) => string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const detailKey = npKeys.issue(issueId);

  const toggle = useMutation({
    mutationFn: (emoji: string) =>
      hasReacted(comment.reactions, emoji, meUserId)
        ? removeReaction(api, comment.id, emoji)
        : addReaction(api, comment.id, emoji),
    onMutate: (emoji) => {
      if (!meUserId) return;
      queryClient.setQueryData<IssueDetail>(detailKey, (previous) =>
        previous
          ? updateDetailComment(previous, comment.id, (current) => ({
              ...current,
              reactions: toggleReaction(current.reactions, emoji, meUserId),
            }))
          : previous,
      );
    },
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: detailKey }),
  });

  const shown = visibleReactions(comment.reactions, REACTION_EMOJIS);

  return (
    <div
      className='flex flex-wrap items-center gap-1'
      aria-label={t('np.reactions.label')}
      role='group'
    >
      {shown.map((reaction) => {
        const mine = hasReacted(comment.reactions, reaction.emoji, meUserId);
        const names = reaction.userIds
          .map(userName)
          .join(t('np.comment.nameSeparator'));
        return (
          <Tooltip key={reaction.emoji}>
            <TooltipTrigger
              render={
                <button
                  type='button'
                  aria-pressed={mine}
                  aria-label={t('np.reactions.toggle', {
                    emoji: reaction.emoji,
                    count: reaction.count,
                    names,
                  })}
                  onClick={() => toggle.mutate(reaction.emoji)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors hover:bg-muted',
                    mine && 'border-primary bg-primary/10 text-foreground',
                  )}
                />
              }
            >
              <span aria-hidden='true'>{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </TooltipTrigger>
            <TooltipContent>{names}</TooltipContent>
          </Tooltip>
        );
      })}
      <Popover open={picking} onOpenChange={setPicking}>
        <PopoverTrigger
          render={
            <button
              type='button'
              aria-label={t('np.reactions.add')}
              className='inline-flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100'
            />
          }
        >
          <SmilePlusIcon className='size-3.5' aria-hidden='true' />
        </PopoverTrigger>
        <PopoverContent className='w-auto p-1' align='start'>
          <div
            className='flex gap-0.5'
            role='group'
            aria-label={t('np.reactions.picker')}
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type='button'
                aria-pressed={hasReacted(comment.reactions, emoji, meUserId)}
                aria-label={emoji}
                className='inline-flex size-8 items-center justify-center rounded-md text-base hover:bg-muted aria-pressed:bg-muted'
                onClick={() => {
                  setPicking(false);
                  toggle.mutate(emoji);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
