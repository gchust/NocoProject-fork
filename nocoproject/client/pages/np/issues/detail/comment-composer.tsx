import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BotIcon, SendIcon, XIcon, ZapIcon } from 'lucide-react';
import { type ReactElement, type RefObject, useState } from 'react';

import { modifierKeyLabel } from '@/components/np-shortcut-keys';
import {
  NpRichTextEditor,
  type NpRichTextHandle,
} from '@/components/np-rich-text-editor';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { fetchMembers } from '../../api-collab.js';
import { createComment } from '../../api.js';
import { npKeys } from '../../constants.js';
import { withComment } from '../../detail-normalize.js';
import type {
  AgentListItem,
  ExecutorRef,
  IssueComment,
  IssueDetail,
} from '../../types.js';
import { computeTriggerPreview } from '../trigger-preview.js';
import { useMentionCandidates } from './mention-candidates.js';

export interface CommentComposerProps {
  readonly issueId: string;
  readonly executor: ExecutorRef;
  readonly agents: readonly AgentListItem[];
  readonly agentName: (agentId: string | null | undefined) => string | null;
  readonly replyTo: IssueComment | null;
  readonly replyToName: string | null;
  readonly onCancelReply: () => void;
  readonly editorRef: RefObject<NpRichTextHandle | null>;
  /** A line shown above the trigger preview (the session panel's "sent after this turn"). */
  readonly notice?: ReactElement | null;
  readonly placeholder?: string;
  /** Called with the posted comment once it is in the issue detail cache (NP-132: the page brings it into view). */
  readonly onSent?: (comment: IssueComment) => void;
}

/**
 * The comment box under the activity, in the rich text editor (iteration 2 "rich text"): Markdown out, with `@` for
 * members and agents and `/note` for a comment that triggers nobody. A reply posts with `parentId` set to the comment
 * being answered. The line under the box previews which agents the comment will trigger, from the same rules the
 * server applies (protocol §2).
 */
export function CommentComposer({
  issueId,
  executor,
  agents,
  agentName,
  replyTo,
  replyToName,
  onCancelReply,
  editorRef,
  notice,
  placeholder,
  onSent,
}: CommentComposerProps): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'comment' | 'note'>('comment');
  const [pending, setPending] = useState(false);
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const candidates = useMentionCandidates(agents, members.data);

  // "Note" posts the comment as a `/note`, which wakes nobody (nocosolution/guidelines/NocoSolution 前端规范.md §S3).
  const outgoing =
    mode === 'note' && content.trim() && !/^\s*\/note\b/u.test(content)
      ? `/note ${content}`
      : content;
  const preview = computeTriggerPreview({
    content: outgoing,
    replyTo,
    executor,
  });
  const names = preview.agentIds
    .map((id) => agentName(id) ?? t('np.common.unknownAgent'))
    .join(t('np.comment.nameSeparator'));

  async function submit(): Promise<void> {
    const text = outgoing.trim();
    if (!content.trim() || pending) return;
    setPending(true);
    try {
      const { comment } = await createComment(api, issueId, {
        content: text,
        parentId: replyTo?.id,
      });
      setContent('');
      editorRef.current?.clear();
      onCancelReply();
      // Shown at once from the response; the refetch then brings the run it triggered.
      queryClient.setQueryData<IssueDetail>(npKeys.issue(issueId), (detail) =>
        detail ? withComment(detail, comment) : detail,
      );
      onSent?.(comment);
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.comment.failed'),
      });
    } finally {
      setPending(false);
    }
  }

  const waking = preview.agentIds.length > 0;
  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <Tabs
          value={mode}
          onValueChange={(value) =>
            setMode(value === 'note' ? 'note' : 'comment')
          }
        >
          <TabsList variant='line' className='h-7'>
            <TabsTrigger value='comment'>
              {t('np.composer.comment')}
            </TabsTrigger>
            <TabsTrigger value='note'>{t('np.composer.note')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {replyTo ? (
          <div className='flex min-w-0 items-center gap-1 text-xs text-muted-foreground'>
            <span className='truncate'>
              {t('np.comment.replyingTo', {
                name: replyToName ?? t('np.common.unknown'),
              })}
            </span>
            <Button
              variant='ghost'
              size='icon-xs'
              aria-label={t('np.comment.cancelReply')}
              onClick={onCancelReply}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </div>
      <NpRichTextEditor
        ref={editorRef}
        value={content}
        onChange={setContent}
        mentionCandidates={candidates}
        onSubmit={() => void submit()}
        disabled={pending}
        toolbar={false}
        placeholder={
          mode === 'note'
            ? t('np.composer.notePlaceholder')
            : (placeholder ?? t('np.comment.placeholder'))
        }
        aria-label={t('np.comment.label')}
        contentClassName='max-h-64 overflow-y-auto'
      />
      {notice ?? null}
      <p
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
          waking
            ? 'bg-primary/8 text-primary'
            : 'bg-muted/60 text-muted-foreground',
        )}
        aria-live='polite'
        data-testid='np-trigger-preview'
      >
        {waking ? (
          <ZapIcon className='size-3.5 shrink-0' aria-hidden='true' />
        ) : (
          <BotIcon className='size-3.5 shrink-0' aria-hidden='true' />
        )}
        <span className='truncate'>
          {t(`np.comment.preview.${preview.reason}`, { names })}
        </span>
      </p>
      <div className='flex items-center gap-2'>
        <span className='mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex'>
          <Kbd>{modifierKeyLabel()}</Kbd>
          <Kbd>Enter</Kbd>
          {t('np.composer.quickSend')}
        </span>
        <Button
          size='sm'
          className='ml-auto'
          disabled={pending || content.trim() === ''}
          onClick={() => void submit()}
        >
          {pending ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <SendIcon data-icon='inline-start' />
          )}
          {replyTo
            ? t('np.comment.sendReply')
            : mode === 'note'
              ? t('np.composer.sendNote')
              : t('np.comment.send')}
        </Button>
      </div>
    </div>
  );
}
