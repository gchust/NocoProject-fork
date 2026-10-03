import { useTranslation } from '@nocobase/i18n/client';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { cn } from '@/lib/utils';

import { PmConversationView } from '../conversation/pm-conversation-view.js';
import { PmHistoryList } from '../history/pm-history-list.js';
import {
  PM_DRAWER_ATTRIBUTE,
  PM_DRAWER_ID,
  usePmAssistant,
} from './pm-assistant.js';
import {
  clampDrawerWidth,
  PM_DOCK_QUERY,
  PM_DRAWER_DEFAULT_WIDTH,
  PM_DRAWER_MAX_WIDTH,
  PM_DRAWER_MIN_WIDTH,
} from './pm-assistant-state.js';
import { PmDrawerHeader } from './pm-drawer-header.js';

/** Marks the shell's root: the page behind the full-screen overlay is made inert up to here. */
export const NP_SHELL_ATTRIBUTE = 'data-np-shell';

/** What one arrow key press on the resize handle moves the width by. */
const RESIZE_STEP = 16;

function subscribeDock(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(PM_DOCK_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

function readDock(): boolean {
  return typeof window === 'undefined' || !window.matchMedia
    ? true
    : window.matchMedia(PM_DOCK_QUERY).matches;
}

/** Whether the window is wide enough for the drawer to dock beside the page (`PM_DOCK_QUERY`). */
function useDocks(): boolean {
  return useSyncExternalStore(subscribeDock, readDock, () => true);
}

/**
 * The project manager drawer (NP-185), a sibling of `<main>` in `AppLayout` so it survives page changes. From
 * 1024px (`PM_DOCK_QUERY`) it docks beside the content and narrows it: 26.25rem (420px) by default, never below
 * 22.5rem, dragged wider by its left edge up to 40rem (kept in the drawer state), and never so wide that the page
 * keeps less than 24rem. Widths are rem because the compact preset shrinks the spacing scale. "Expand" covers the
 * content area. Below 1024px it is one full-screen overlay over the page, never half of it: the page behind is
 * inert. It is one element in every form, so switching between them keeps the conversation, the draft and the
 * scroll position. None of the forms is a dialog (`role="dialog"` would silence the `C` shortcut) and none traps
 * focus; Escape restores the width, then closes. Once opened it stays mounted while closed, so the conversation's
 * subscriptions and a streaming turn carry on.
 */
export function PmDrawer(): ReactElement | null {
  const { available } = usePmAssistant();
  return available ? <PmDrawerFrame /> : null;
}

function PmDrawerFrame(): ReactElement | null {
  const { t } = useTranslation();
  const assistant = usePmAssistant();
  const docks = useDocks();
  const [mounted, setMounted] = useState(assistant.open);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  if (assistant.open && !mounted) setMounted(true);

  const { mode, setMode, closeAssistant, open } = assistant;
  const overlay = !docks;
  useEffect(() => {
    const element = asideRef.current;
    if (!element || !open) return;
    // A native listener: Escape inside a menu or a select (rendered in a portal) never reaches it.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (mode === 'expanded' && !overlay) setMode('docked');
      else closeAssistant();
    }
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [open, mode, overlay, setMode, closeAssistant, mounted]);

  // The overlay hides the page, so the page must not take focus or clicks either.
  const covering = overlay && open;
  useEffect(() => {
    const aside = asideRef.current;
    const shell = aside?.closest(`[${NP_SHELL_ATTRIBUTE}]`);
    if (!covering || !aside || !shell) return;
    const inerted: Element[] = [];
    let node: Element = aside;
    while (node !== shell && node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          inerted.push(sibling);
        }
      }
      node = node.parentElement;
    }
    return () => inerted.forEach((element) => element.removeAttribute('inert'));
  }, [covering]);

  if (!mounted) return null;

  const expanded = mode === 'expanded' && !overlay;
  const resizable = !overlay && !expanded;
  const width = dragWidth ?? assistant.width ?? PM_DRAWER_DEFAULT_WIDTH;

  function onResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = asideRef.current?.offsetWidth ?? width;
    let latest = startWidth;
    function onMove(move: PointerEvent): void {
      latest = clampDrawerWidth(startWidth + startX - move.clientX);
      setDragWidth(latest);
    }
    function onEnd(): void {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      setDragWidth(null);
      assistant.setWidth(latest);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  function onResizeKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const delta =
      event.key === 'ArrowLeft'
        ? RESIZE_STEP
        : event.key === 'ArrowRight'
          ? -RESIZE_STEP
          : 0;
    if (event.key === 'Home') assistant.setWidth(null);
    else if (delta === 0) return;
    else assistant.setWidth(width + delta);
    event.preventDefault();
  }

  return (
    <aside
      ref={asideRef}
      id={PM_DRAWER_ID}
      {...{ [PM_DRAWER_ATTRIBUTE]: '' }}
      aria-label={t('np.pmAssistant.title')}
      hidden={!open}
      data-mode={overlay ? 'overlay' : expanded ? 'expanded' : 'docked'}
      data-testid='np-pm-drawer'
      style={
        resizable
          ? ({ '--np-pm-drawer-width': `${width}px` } as CSSProperties)
          : undefined
      }
      className={cn(
        'flex min-h-0 flex-col bg-background',
        overlay
          ? 'fixed inset-0 z-50 h-dvh'
          : expanded
            ? 'absolute inset-0 z-30'
            : 'relative w-(--np-pm-drawer-width) max-w-[calc(100%-24rem)] min-w-[22.5rem] shrink-0 border-l',
      )}
    >
      {resizable ? (
        <div
          role='separator'
          aria-orientation='vertical'
          aria-label={t('np.pmAssistant.resize')}
          aria-valuemin={PM_DRAWER_MIN_WIDTH}
          aria-valuemax={PM_DRAWER_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-testid='np-pm-drawer-resize'
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          onDoubleClick={() => assistant.setWidth(null)}
          className='absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100'
        />
      ) : null}
      <PmDrawerHeader compact={overlay} />
      <PmDrawerBody />
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
