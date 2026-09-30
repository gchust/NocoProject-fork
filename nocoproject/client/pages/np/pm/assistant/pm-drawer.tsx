import { useTranslation } from '@nocobase/i18n/client';
import {
  type ReactElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

import { PmConversationView } from '../conversation/pm-conversation-view.js';
import { PmHistoryList } from '../history/pm-history-list.js';
import {
  PM_DRAWER_ATTRIBUTE,
  PM_DRAWER_ID,
  usePmAssistant,
} from './pm-assistant.js';
import { PM_DOCK_QUERY } from './pm-assistant-state.js';
import { PmDrawerHeader } from './pm-drawer-header.js';

// Docking beside the content needs room for the issue page's two columns next to it: at 1360px (the screenshot
// width) a docked drawer pushed the issue header's actions off the main column, so it docks from 1536px only.
const WIDE_QUERY = PM_DOCK_QUERY;

function subscribeWide(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

function readWide(): boolean {
  return typeof window === 'undefined' || !window.matchMedia
    ? true
    : window.matchMedia(WIDE_QUERY).matches;
}

function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, readWide, () => true);
}

/**
 * The project manager drawer (NP-185), a sibling of `<main>` in `AppLayout` so it survives page changes. From
 * 1536px it docks beside the content (26.25rem, i.e. 420px, fixed in rem because the compact preset shrinks the
 * spacing scale); between `md` and 1536px it floats over the right of the content (25rem); "expand" covers the
 * content area. Neither form is a dialog (`role="dialog"` would silence the `C` shortcut) and neither traps focus;
 * Escape restores the width, then closes. Below `md` it is a full-screen modal dialog. Once opened it stays
 * mounted while closed, so the conversation's subscriptions and a streaming turn carry on.
 */
export function PmDrawer(): ReactElement | null {
  const { available } = usePmAssistant();
  return available ? <PmDrawerFrame /> : null;
}

function PmDrawerFrame(): ReactElement | null {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  const mobile = useIsMobile();
  const wide = useWide();
  const [mounted, setMounted] = useState(assistant.open);
  const asideRef = useRef<HTMLElement>(null);
  if (assistant.open && !mounted) setMounted(true);

  const { mode, setMode, closeAssistant, open } = assistant;
  useEffect(() => {
    const element = asideRef.current;
    if (!element || !open) return;
    // A native listener: Escape inside a menu or a select (rendered in a portal) never reaches it.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (mode === 'expanded') setMode('docked');
      else closeAssistant();
    }
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [open, mode, setMode, closeAssistant, mounted, mobile]);

  if (!mounted) return null;

  const body = <PmDrawerBody />;
  if (mobile) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeAssistant();
        }}
      >
        <DialogContent
          id={PM_DRAWER_ID}
          {...{ [PM_DRAWER_ATTRIBUTE]: '' }}
          showCloseButton={false}
          className='flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none'
        >
          <DialogTitle className='sr-only'>
            {t('np.pmAssistant.title')}
          </DialogTitle>
          <PmDrawerHeader compact />
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  const expanded = mode === 'expanded';
  return (
    <aside
      ref={asideRef}
      id={PM_DRAWER_ID}
      {...{ [PM_DRAWER_ATTRIBUTE]: '' }}
      aria-label={t('np.pmAssistant.title')}
      hidden={!open}
      data-mode={expanded ? 'expanded' : wide ? 'docked' : 'floating'}
      data-testid='np-pm-drawer'
      className={cn(
        'flex min-h-0 flex-col bg-background',
        expanded
          ? 'absolute inset-0 z-30'
          : wide
            ? 'relative w-[26.25rem] shrink-0 border-l'
            : 'absolute inset-y-0 right-0 z-30 w-[25rem] max-w-full border-l shadow-xl',
      )}
    >
      <PmDrawerHeader compact={false} />
      {body}
    </aside>
  );
}

function PmDrawerBody(): ReactElement {
  const assistant = usePmAssistant();
  return (
    <div className='flex min-h-0 flex-1 flex-col p-3'>
      {assistant.view === 'history' ? (
        <div className='min-h-0 flex-1 overflow-y-auto'>
          <PmHistoryList
            activeId={assistant.conversationId}
            onOpen={(id) => {
              assistant.selectConversation(id);
              assistant.focusComposer();
            }}
          />
        </div>
      ) : (
        <PmConversationView
          conversationId={assistant.conversationId}
          onConversation={(id) => assistant.selectConversation(id)}
          onStartNew={() => assistant.selectConversation(null)}
        />
      )}
    </div>
  );
}
