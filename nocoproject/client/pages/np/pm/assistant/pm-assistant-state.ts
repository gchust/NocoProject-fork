import type { PmAgentChoice, PmConversationDetail } from '../../types-pm.js';

/**
 * The project manager drawer's state as pure data (NP-185): whether it is open, docked or expanded, showing the
 * conversation or the history, and which conversation. It lives in `sessionStorage`, so a reload in the same tab
 * reopens the drawer where it was; every access is in try/catch (private windows, full storage). The first load of
 * a browser session finds nothing stored and opens the drawer where it docks (NP-197, `firstVisitDrawerState`).
 */

export type PmDrawerMode = 'docked' | 'expanded';
export type PmDrawerView = 'chat' | 'history';

export interface PmDrawerState {
  readonly open: boolean;
  readonly mode: PmDrawerMode;
  readonly view: PmDrawerView;
  /** null: a new conversation that exists only once its first message is sent. */
  readonly conversationId: string | null;
}

export const PM_DRAWER_STORAGE_KEY = 'nocoproject:pm-drawer';

export const INITIAL_DRAWER_STATE: PmDrawerState = {
  open: false,
  mode: 'docked',
  view: 'chat',
  conversationId: null,
};

/** Docking beside the content needs this width; below it the drawer covers the page (`pm-drawer.tsx`). */
export const PM_DOCK_QUERY = '(min-width: 1536px)';

export function readDrawerState(storage?: Storage | null): PmDrawerState {
  return readStoredDrawerState(storage) ?? INITIAL_DRAWER_STATE;
}

/** The stored state, or null when this browser session has none yet (its first load). */
export function readStoredDrawerState(
  storage?: Storage | null,
): PmDrawerState | null {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(
      PM_DRAWER_STORAGE_KEY,
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PmDrawerState> | null;
    if (!value || typeof value !== 'object') return INITIAL_DRAWER_STATE;
    return {
      open: value.open === true,
      mode: value.mode === 'expanded' ? 'expanded' : 'docked',
      view: value.view === 'history' ? 'history' : 'chat',
      conversationId:
        typeof value.conversationId === 'string' && value.conversationId
          ? value.conversationId
          : null,
    };
  } catch {
    return INITIAL_DRAWER_STATE;
  }
}

/**
 * The first load of a browser session (NP-197) opens the drawer where it docks beside the content; on narrower
 * screens it would cover the page, so it stays closed there. Once the member closes it, the stored state keeps it
 * closed on reloads until a new session. Returns the state and whether it was opened on its own.
 */
export function firstVisitDrawerState(storage?: Storage | null): {
  readonly state: PmDrawerState;
  readonly autoOpened: boolean;
} {
  const stored = readStoredDrawerState(storage);
  if (stored) return { state: stored, autoOpened: false };
  const docks =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(PM_DOCK_QUERY).matches;
  return {
    state: { ...INITIAL_DRAWER_STATE, open: docks },
    autoOpened: docks,
  };
}

export function writeDrawerState(
  state: PmDrawerState,
  storage?: Storage | null,
): void {
  try {
    (storage ?? window.sessionStorage).setItem(
      PM_DRAWER_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    // Not remembered; the drawer still works for this visit.
  }
}

/**
 * `?pm=<conversationId>` opens the drawer on that conversation (`new` on a new one, `history` on the history), and
 * `pmMode=expanded` expands it: how a link or the screenshot run opens it. Returns null without `pm`.
 */
export function drawerStateFromSearch(
  search: URLSearchParams,
  current: PmDrawerState,
): PmDrawerState | null {
  const value = search.get('pm');
  if (!value) return null;
  const mode: PmDrawerMode =
    search.get('pmMode') === 'expanded' ? 'expanded' : 'docked';
  if (value === 'history')
    return { ...current, open: true, mode, view: 'history' };
  return {
    open: true,
    mode,
    view: 'chat',
    conversationId: value === 'new' ? null : value,
  };
}

/** The search string without the drawer's own parameters, once they have been applied. */
export function withoutDrawerParams(search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.delete('pm');
  next.delete('pmMode');
  const text = next.toString();
  return text ? `?${text}` : '';
}

/** Where "switch and start a new conversation" goes, or null when there is nothing to switch to (§5.4, §6.2). */
export function switchTarget(
  choice: PmAgentChoice | undefined,
  conversation: PmConversationDetail | null | undefined,
): 'system' | 'personal' | null {
  if (!choice || !choice.allowPersonal) return null;
  const source = conversation?.agent?.source;
  if (source === 'personal') return choice.systemAgent ? 'system' : null;
  return choice.agentId &&
    choice.candidates.some((c) => c.id === choice.agentId)
    ? 'personal'
    : null;
}
