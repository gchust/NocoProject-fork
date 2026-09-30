import type { PmAgentChoice, PmConversationDetail } from '../../types-pm.js';

/**
 * The project manager drawer's state as pure data (NP-185): whether it is open, docked or expanded, showing the
 * conversation or the history, and which conversation. It lives in `sessionStorage`, so a reload in the same tab
 * reopens the drawer where it was; every access is in try/catch (private windows, full storage).
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

export function readDrawerState(storage?: Storage | null): PmDrawerState {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(
      PM_DRAWER_STORAGE_KEY,
    );
    if (!raw) return INITIAL_DRAWER_STATE;
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
  const source = conversation?.agent.source;
  if (source === 'personal') return choice.systemAgent ? 'system' : null;
  return choice.agentId &&
    choice.candidates.some((c) => c.id === choice.agentId)
    ? 'personal'
    : null;
}
