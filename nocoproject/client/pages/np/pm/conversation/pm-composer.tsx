import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import type { FileRecord } from '@nocobase/app-plugin-file/client';
import { useQueryClient } from '@tanstack/react-query';
import { PaperclipIcon, SendIcon, SquareIcon } from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'react-router';

import { isSubmitEnter } from '@/components/np-shortcut-keys';
import { NpSubmitHint } from '@/components/np-submit-hint';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  FileUploadField,
  type FileUploadFieldHandle,
  type FileUploadStatus,
} from '@/extensions/nocobase-file-component-ui';

import { cancelRun } from '../../api.js';
import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_SIZE,
  attachFiles,
} from '../../api-attachments.js';
import { createPmConversation, sendPmMessage } from '../../api-pm.js';
import { npKeys } from '../../constants.js';
import { withComment } from '../../detail-normalize.js';
import {
  uploadErrorTitle,
  useAttachmentRepository,
  useFileLabels,
  usePasteDrop,
} from '../../issues/detail/use-attachments.js';
import type { IssueDetail, RunSummary } from '../../types.js';
import type { PmConversationDetail } from '../../types-pm.js';
import { usePmAssistant, usePmSources } from '../assistant/pm-assistant.js';
import { PmContextChips } from '../context/pm-context-chips.js';
import {
  buildPageContext,
  contextChips,
  type PmContextInput,
} from '../context/pm-context-model.js';
import { withAttachmentLinks } from './pm-conversation-model.js';

export const PM_MESSAGE_MAX = 20_000;

/** What the composer reports once a message is saved on the server. */
export interface PmSent {
  readonly conversation: PmConversationDetail | null;
  /** The message was saved but no project manager could take it (`PM_NOT_CONFIGURED`, §5.6). */
  readonly notConfigured: boolean;
}

/**
 * The project manager's message box (NP-185): the page context as removable tags above it, attachments (choose,
 * paste or drop), Enter to send, Shift+Enter for a new line. While a turn runs the send button becomes "Stop" as
 * long as the box is empty; a message typed meanwhile goes out after the turn (the notice says so). A new
 * conversation is created on the server by its first message.
 */
export function PmComposer({
  conversation,
  activeRun,
  notice,
  onCreated,
  onSent,
}: {
  readonly conversation: PmConversationDetail | null;
  readonly activeRun: RunSummary | null;
  readonly notice?: ReactNode;
  readonly onCreated: (conversation: PmConversationDetail) => void;
  readonly onSent: (sent: PmSent) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const location = useLocation();
  const assistant = usePmAssistant();
  const sources = usePmSources();
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const repository = useAttachmentRepository();
  const fileLabels = useFileLabels();
  const uploadRef = useRef<FileUploadFieldHandle>(null);
  const pasteDrop = usePasteDrop(uploadRef);
  const [files, setFiles] = useState<readonly FileRecord[]>([]);
  const [uploadStatus, setUploadStatus] = useState<FileUploadStatus>('idle');
  const [showFiles, setShowFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { registerComposer, draft } = assistant;
  useEffect(
    () => registerComposer(() => textareaRef.current?.focus()),
    [registerComposer],
  );
  // A draft from "Ask the project manager" fills an empty box once (while rendering), then takes the focus.
  const [seenDraft, setSeenDraft] = useState<number | null>(null);
  if (draft && draft.nonce !== seenDraft) {
    setSeenDraft(draft.nonce);
    if (!content.trim()) setContent(draft.text);
  }
  const draftNonce = draft?.nonce;
  useEffect(() => {
    if (draftNonce !== undefined) textareaRef.current?.focus();
  }, [draftNonce]);

  const contextInput: PmContextInput = {
    route: `${location.pathname}${location.search}`,
    pinned: assistant.pinned,
    sources: sources.objects,
    filter: sources.filter,
    selection: sources.selection,
    removed: sources.removed,
  };
  const chips = contextChips(contextInput);
  const tooLong = content.length > PM_MESSAGE_MAX;
  const hasFiles = files.length > 0;
  const canSend =
    !pending &&
    uploadStatus === 'idle' &&
    !tooLong &&
    (content.trim() !== '' || hasFiles);
  const showStop = Boolean(activeRun) && content.trim() === '' && !hasFiles;

  async function ensureConversation(): Promise<PmConversationDetail> {
    if (conversation) return conversation;
    const created = await createPmConversation(api);
    queryClient.setQueryData(npKeys.pmConversation(created.id), created);
    onCreated(created);
    return created;
  }

  async function submit(): Promise<void> {
    if (!canSend) return;
    setPending(true);
    try {
      const target = await ensureConversation();
      const attached = hasFiles
        ? await attachFiles(
            api,
            target.issueId,
            files.map((file) => file.id),
          )
        : [];
      const result = await sendPmMessage(api, target.issueId, {
        content: withAttachmentLinks(content, attached),
        context: buildPageContext(contextInput),
      });
      setContent('');
      setFiles([]);
      setShowFiles(false);
      assistant.clearPinned();
      queryClient.setQueryData<IssueDetail>(
        npKeys.issue(target.issueId),
        (detail) => (detail ? withComment(detail, result.comment) : detail),
      );
      // NP-183: with no project manager available the message is saved (201) and `conversation.agent` is null.
      const agent = result.conversation?.agent;
      const next =
        result.conversation === undefined
          ? target
          : { ...target, agent: agent ?? null };
      if (result.conversation !== undefined) {
        queryClient.setQueryData(npKeys.pmConversation(target.id), next);
      }
      void queryClient.invalidateQueries({
        queryKey: npKeys.issue(target.issueId),
      });
      void queryClient.invalidateQueries({
        queryKey: [...npKeys.pm, 'conversations'],
      });
      onSent({
        conversation: next,
        notConfigured: result.conversation !== undefined && !agent,
      });
    } catch (error: unknown) {
      if (
        error instanceof ApiClientError &&
        error.code === 'PM_NOT_CONFIGURED' &&
        conversation
      ) {
        // §5.6: the message is kept; nobody can answer it until a project manager is configured.
        setContent('');
        setFiles([]);
        void queryClient.invalidateQueries({
          queryKey: npKeys.issue(conversation.issueId),
        });
        onSent({ conversation, notConfigured: true });
      } else {
        toast.add({
          type: 'error',
          priority: 'high',
          title:
            error instanceof ApiClientError && error.status === 403
              ? t('np.common.forbidden')
              : error instanceof ApiClientError &&
                  error.code === 'PM_NOT_CONFIGURED'
                ? t('np.pmAssistant.notConfigured')
                : t('np.pmAssistant.sendFailed'),
        });
      }
    } finally {
      setPending(false);
    }
  }

  async function stop(): Promise<void> {
    if (!activeRun || stopping === activeRun.id) return;
    setStopping(activeRun.id);
    try {
      await cancelRun(api, activeRun.id);
      toast.add({ type: 'success', title: t('np.runs.stopRequested') });
      if (conversation) {
        void queryClient.invalidateQueries({
          queryKey: npKeys.issue(conversation.issueId),
        });
      }
    } catch (error: unknown) {
      setStopping(null);
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      });
    }
  }

  const isStopping = activeRun !== null && stopping === activeRun.id;
  return (
    <div className='space-y-2' data-testid='np-pm-composer'>
      <PmContextChips chips={chips} onRemove={sources.remove} />
      {notice ?? null}
      <div
        className={
          showFiles || hasFiles || uploadStatus !== 'idle' ? '' : 'hidden'
        }
      >
        <FileUploadField
          ref={uploadRef}
          repository={repository}
          value={files}
          onChange={(next) => {
            setFiles(next);
            if (next.length > 0) setShowFiles(true);
          }}
          onStatusChange={setUploadStatus}
          multiple
          maxFiles={ATTACHMENT_MAX_FILES}
          maxSize={ATTACHMENT_MAX_FILE_SIZE}
          labels={fileLabels}
          removeOnDelete={false}
          onError={(failure) =>
            toast.add({
              type: 'error',
              priority: 'high',
              title: uploadErrorTitle(t, failure),
            })
          }
        />
      </div>
      <label htmlFor={inputId} className='sr-only'>
        {t('np.pmAssistant.composer.label')}
      </label>
      <Textarea
        id={inputId}
        ref={textareaRef}
        value={content}
        rows={3}
        className='max-h-48 min-h-20 resize-none'
        placeholder={t('np.pmAssistant.composer.placeholder')}
        aria-invalid={tooLong ? true : undefined}
        disabled={pending}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (isSubmitEnter(event.nativeEvent)) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) setShowFiles(true);
          pasteDrop.onPaste(event);
        }}
        onDragOver={pasteDrop.onDragOver}
        onDrop={(event) => {
          if (event.dataTransfer.files.length > 0) setShowFiles(true);
          pasteDrop.onDrop(event);
        }}
      />
      {tooLong ? (
        <p className='text-xs text-destructive'>
          {t('np.pmAssistant.composer.tooLong', { max: PM_MESSAGE_MAX })}
        </p>
      ) : null}
      <input
        ref={fileInputRef}
        type='file'
        multiple
        className='hidden'
        tabIndex={-1}
        aria-hidden='true'
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (picked.length === 0) return;
          setShowFiles(true);
          uploadRef.current?.addFiles(picked);
        }}
      />
      <div className='flex items-center gap-2'>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('np.pmAssistant.composer.attach')}
          title={t('np.pmAssistant.composer.attach')}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <NpSubmitHint className='mr-auto hidden sm:inline-flex' />
        {showStop ? (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto'
            disabled={isStopping}
            onClick={() => void stop()}
          >
            {isStopping ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SquareIcon data-icon='inline-start' />
            )}
            {isStopping
              ? t('np.pmAssistant.composer.stopping')
              : t('np.pmAssistant.composer.stop')}
          </Button>
        ) : (
          <Button
            size='sm'
            className='ml-auto'
            disabled={!canSend}
            onClick={() => void submit()}
          >
            {pending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SendIcon data-icon='inline-start' />
            )}
            {t('np.pmAssistant.composer.send')}
          </Button>
        )}
      </div>
    </div>
  );
}
