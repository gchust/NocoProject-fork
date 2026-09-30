import { useTranslation } from '@nocobase/i18n/client';
import { BotMessageSquareIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router';

import { modifierKeyLabel } from '@/components/np-shortcut-keys';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { PmContextObject } from '../context/pm-context-model.js';
import { PM_DRAWER_ID, usePmAssistant } from './pm-assistant.js';

const HEADER_BUTTON_CLASS =
  'inline-flex size-10 items-center justify-center rounded-xl border border-border/70 bg-background/60 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted';

/** The top bar's project manager button (NP-185): toggles the drawer; the tooltip names ⌘J / Ctrl+J. */
export function PmHeaderButton(): ReactElement | null {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  if (!assistant.available) return null;
  const label = t('np.pmAssistant.title');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type='button'
            className={HEADER_BUTTON_CLASS}
            aria-label={label}
            aria-expanded={assistant.open}
            aria-controls={PM_DRAWER_ID}
            aria-keyshortcuts='Meta+J Control+J'
            onClick={assistant.toggleAssistant}
            data-testid='np-pm-header-button'
          />
        }
      >
        <BotMessageSquareIcon className='size-5' />
      </TooltipTrigger>
      <TooltipContent side='bottom'>
        {label}
        <Kbd className='ml-1.5'>{`${modifierKeyLabel()} J`}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** Below `md` the drawer opens from a floating button; hidden while it is open and on the conversation pages. */
export function PmFloatingButton(): ReactElement | null {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  const { pathname } = useLocation();
  if (!assistant.available || assistant.open || /^\/pm(\/|$)/u.test(pathname)) {
    return null;
  }
  return (
    <Button
      size='icon'
      className='fixed right-4 bottom-4 z-40 size-12 rounded-full shadow-lg md:hidden'
      aria-label={t('np.pmAssistant.title')}
      aria-controls={PM_DRAWER_ID}
      aria-expanded={false}
      onClick={() => assistant.openAssistant()}
      data-testid='np-pm-fab'
    >
      <BotMessageSquareIcon className='size-5' />
    </Button>
  );
}

/**
 * "Ask the project manager" on a task, a project, a document or an inbox item: opens the drawer with the object
 * pinned in the context, and optionally a draft in the composer (never sent on its own).
 */
export function AskPmButton({
  object,
  draft,
  label,
  variant = 'outline',
  size = 'sm',
  iconOnly = false,
  className,
}: {
  readonly object: PmContextObject;
  readonly draft?: string;
  readonly label?: string;
  readonly variant?: 'outline' | 'ghost' | 'link';
  readonly size?: 'sm' | 'icon-sm' | 'default';
  readonly iconOnly?: boolean;
  readonly className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  if (!assistant.available) return null;
  const text = label ?? t('np.pmAssistant.ask');
  const open = (): void =>
    assistant.openAssistant({ pin: object, draft, view: 'chat' });
  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={variant}
              size='icon-sm'
              aria-label={text}
              className={className}
              onClick={open}
            />
          }
        >
          <BotMessageSquareIcon />
        </TooltipTrigger>
        <TooltipContent side='bottom'>{text}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={open}
    >
      <BotMessageSquareIcon data-icon='inline-start' />
      {text}
    </Button>
  );
}
