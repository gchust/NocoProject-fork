import { useTranslation } from '@nocobase/i18n/client';
import {
  ArchiveIcon,
  HistoryIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoreHorizontalIcon,
  RepeatIcon,
  SquarePenIcon,
  XIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

import { PmAgentBadge } from '../conversation/pm-agent-status.js';
import {
  usePmAgentChoice,
  usePmConversationActions,
  usePmConversationDetail,
} from '../conversation/use-pm-conversation.js';
import { PM_TITLE_MAX } from '../history/pm-history-list.js';
import { usePmAssistant } from './pm-assistant.js';
import { switchTarget } from './pm-assistant-state.js';

/**
 * The drawer's header (NP-185): the conversation's title (click to rename; Enter saves, Escape cancels) and its
 * agent, then new conversation, history, expand or restore, close, and a menu with "switch and start a new
 * conversation" and "archive".
 */
export function PmDrawerHeader({
  compact,
}: {
  /** The mobile full-screen form: no expand button. */
  readonly compact: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  const detail = usePmConversationDetail(assistant.conversationId);
  const conversation = detail.data;
  const choice = usePmAgentChoice(assistant.open);
  const actions = usePmConversationActions();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const history = assistant.view === 'history';
  const target = switchTarget(choice.data, conversation);
  const shownTitle = history
    ? t('np.pmAssistant.history.title')
    : (conversation?.title ?? t('np.pmAssistant.newConversation'));

  function saveTitle(): void {
    setRenaming(false);
    const next = title.trim().slice(0, PM_TITLE_MAX);
    if (conversation && next && next !== conversation.title) {
      actions.rename.mutate({ id: conversation.id, title: next });
    }
  }

  return (
    <header className='flex shrink-0 flex-col gap-1 border-b px-3 py-2'>
      <div className='flex min-w-0 items-center gap-1'>
        {renaming && conversation ? (
          <Input
            autoFocus
            value={title}
            maxLength={PM_TITLE_MAX}
            className='h-8 flex-1'
            aria-label={t('np.pmAssistant.rename')}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveTitle();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 className='min-w-0 flex-1'>
            {conversation && !history ? (
              <button
                type='button'
                className='block max-w-full truncate rounded-md px-1 text-left text-sm font-semibold hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none'
                title={t('np.pmAssistant.renameHint', { title: shownTitle })}
                onClick={() => {
                  setTitle(conversation.title);
                  setRenaming(true);
                }}
              >
                {shownTitle}
              </button>
            ) : (
              <span className='block truncate px-1 text-sm font-semibold'>
                {shownTitle}
              </span>
            )}
          </h2>
        )}
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('np.pmAssistant.newConversation')}
          title={t('np.pmAssistant.newConversation')}
          onClick={() => {
            assistant.selectConversation(null);
            assistant.focusComposer();
          }}
        >
          <SquarePenIcon />
        </Button>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('np.pmAssistant.history.title')}
          title={t('np.pmAssistant.history.title')}
          aria-pressed={history}
          onClick={() => assistant.setView(history ? 'chat' : 'history')}
        >
          <HistoryIcon />
        </Button>
        {compact ? null : (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={
              assistant.mode === 'expanded'
                ? t('np.pmAssistant.restoreSize')
                : t('np.pmAssistant.expand')
            }
            title={
              assistant.mode === 'expanded'
                ? t('np.pmAssistant.restoreSize')
                : t('np.pmAssistant.expand')
            }
            onClick={() =>
              assistant.setMode(
                assistant.mode === 'expanded' ? 'docked' : 'expanded',
              )
            }
          >
            {assistant.mode === 'expanded' ? (
              <Minimize2Icon />
            ) : (
              <Maximize2Icon />
            )}
          </Button>
        )}
        {conversation && !history ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant='ghost'
                  size='icon-sm'
                  aria-label={t('np.pmAssistant.more')}
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuGroup>
                {target ? (
                  <DropdownMenuItem
                    onClick={() =>
                      actions.create.mutate(
                        { switchTo: target },
                        {
                          onSuccess: (created) => {
                            assistant.selectConversation(created.id);
                            assistant.focusComposer();
                          },
                        },
                      )
                    }
                  >
                    <RepeatIcon />
                    {t(`np.pmAssistant.switchTo.${target}`)}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={() => {
                    actions.archive.mutate({
                      id: conversation.id,
                      archived: true,
                    });
                    assistant.selectConversation(null);
                  }}
                >
                  <ArchiveIcon />
                  {t('np.pmAssistant.archive')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('np.pmAssistant.close')}
          title={t('np.pmAssistant.close')}
          onClick={assistant.closeAssistant}
        >
          <XIcon />
        </Button>
      </div>
      {conversation && !history ? (
        <PmAgentBadge agent={conversation.agent} />
      ) : null}
    </header>
  );
}
