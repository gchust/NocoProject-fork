import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

import { isAssistantShortcut } from '@/components/np-shortcut-keys';

import {
  clampSelection,
  filterFromSearch,
  objectKey,
  parseSourceAttribute,
  type PmContextFilter,
  type PmContextObject,
  type PmSelection,
  SELECTION_KEY,
} from '../context/pm-context-model.js';
import {
  drawerStateFromSearch,
  type PmDrawerMode,
  type PmDrawerState,
  type PmDrawerView,
  readDrawerState,
  withoutDrawerParams,
  writeDrawerState,
} from './pm-assistant-state.js';

/**
 * The project manager assistant across the whole app (NP-185, `protocol-pm-assistant.md` §5, §8): the drawer's
 * state, ⌘J / Ctrl+J, what the current page contributes as context, and the text last selected on the page. The
 * provider sits in `AppLayout` around the routes, so none of it resets when the page changes; only the page's own
 * sources, the selection and the removed tags follow the route.
 */

export const PM_DRAWER_ID = 'np-pm-drawer';
/** Marks the drawer's DOM: selections inside it are not page context, and focus inside it means "in the drawer". */
export const PM_DRAWER_ATTRIBUTE = 'data-pm-drawer';

export interface PmOpenOptions {
  /** An object to keep in the context until the message is sent ("Ask the project manager"). */
  readonly pin?: PmContextObject;
  /** Text put into the composer, never sent on its own. */
  readonly draft?: string;
  /** Open this conversation; null opens a new one. Omitted keeps the current one. */
  readonly conversationId?: string | null;
  readonly view?: PmDrawerView;
}

export interface PmDraft {
  readonly text: string;
  readonly nonce: number;
}

export interface PmAssistantValue extends PmDrawerState {
  /** The viewer may use the project manager (the `np-pm` page is not denied). */
  readonly available: boolean;
  readonly openAssistant: (options?: PmOpenOptions) => void;
  readonly closeAssistant: () => void;
  readonly toggleAssistant: () => void;
  readonly setMode: (mode: PmDrawerMode) => void;
  readonly setView: (view: PmDrawerView) => void;
  /** Shows a conversation in the drawer; null starts a new one. */
  readonly selectConversation: (conversationId: string | null) => void;
  readonly pinned: readonly PmContextObject[];
  readonly clearPinned: () => void;
  readonly draft: PmDraft | null;
  /** The composer registers how to focus it; the returned function unregisters. */
  readonly registerComposer: (focus: () => void) => () => void;
  readonly focusComposer: () => void;
}

export interface PmSourcesValue {
  readonly objects: readonly PmContextObject[];
  readonly filter: PmContextFilter | null;
  readonly selection: PmSelection | null;
  readonly removed: ReadonlySet<string>;
  readonly register: (object: PmContextObject) => () => void;
  readonly registerFilter: (filter: PmContextFilter) => () => void;
  readonly remove: (key: string) => void;
}

const PmAssistantContext = createContext<PmAssistantValue | null>(null);
const PmSourcesContext = createContext<PmSourcesValue | null>(null);

/** The drawer's state and actions; outside the provider (tests of a single page) a closed, unavailable stub. */
export function usePmAssistant(): PmAssistantValue {
  return useContext(PmAssistantContext) ?? UNAVAILABLE;
}

export function usePmSources(): PmSourcesValue {
  return useContext(PmSourcesContext) ?? NO_SOURCES;
}

function noop(): void {}
const NO_SOURCES: PmSourcesValue = {
  objects: [],
  filter: null,
  selection: null,
  removed: new Set(),
  register: () => noop,
  registerFilter: () => noop,
  remove: noop,
};
const UNAVAILABLE: PmAssistantValue = {
  open: false,
  mode: 'docked',
  view: 'chat',
  conversationId: null,
  available: false,
  openAssistant: noop,
  closeAssistant: noop,
  toggleAssistant: noop,
  setMode: noop,
  setView: noop,
  selectConversation: noop,
  pinned: [],
  clearPinned: noop,
  draft: null,
  registerComposer: () => noop,
  focusComposer: noop,
};

function focusIsInDrawer(): boolean {
  const active = document.activeElement;
  return (
    active instanceof Element &&
    active.closest(`[${PM_DRAWER_ATTRIBUTE}]`) !== null
  );
}

export function PmAssistantProvider({
  available,
  children,
}: {
  readonly available: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<PmDrawerState>(() => readDrawerState());
  const [pinned, setPinned] = useState<readonly PmContextObject[]>([]);
  const [draft, setDraft] = useState<PmDraft | null>(null);
  const composerFocus = useRef<(() => void) | null>(null);
  const focusWanted = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const draftNonce = useRef(0);

  useEffect(() => writeDrawerState(state), [state]);

  const focusComposer = useCallback(() => {
    if (composerFocus.current) composerFocus.current();
    else focusWanted.current = true;
  }, []);

  const registerComposer = useCallback((focus: () => void) => {
    composerFocus.current = focus;
    if (focusWanted.current) {
      focusWanted.current = false;
      focus();
    }
    return () => {
      if (composerFocus.current === focus) composerFocus.current = null;
    };
  }, []);

  const openAssistant = useCallback(
    (options: PmOpenOptions = {}) => {
      if (!focusIsInDrawer() && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      }
      setState((current) => ({
        ...current,
        open: true,
        view: options.view ?? 'chat',
        conversationId:
          options.conversationId === undefined
            ? current.conversationId
            : options.conversationId,
      }));
      const pin = options.pin;
      if (pin) {
        setPinned((current) =>
          current.some((item) => objectKey(item) === objectKey(pin))
            ? current
            : [...current, pin],
        );
      }
      if (options.draft) {
        draftNonce.current += 1;
        setDraft({ text: options.draft, nonce: draftNonce.current });
      }
      if ((options.view ?? 'chat') === 'chat') focusComposer();
    },
    [focusComposer],
  );

  const closeAssistant = useCallback(() => {
    const inDrawer = focusIsInDrawer();
    setState((current) => ({ ...current, open: false, mode: 'docked' }));
    const target = returnFocus.current;
    returnFocus.current = null;
    if (inDrawer && target?.isConnected) target.focus();
  }, []);

  const toggleAssistant = useCallback(() => {
    if (state.open) closeAssistant();
    else openAssistant();
  }, [state.open, closeAssistant, openAssistant]);

  // ⌘J / Ctrl+J: open and focus the composer; open with focus elsewhere: bring focus in; focus inside: close.
  const shortcut = useRef<() => void>(noop);
  useEffect(() => {
    shortcut.current = () => {
      if (!state.open) openAssistant();
      else if (!focusIsInDrawer()) {
        if (state.view !== 'chat') {
          setState((current) => ({ ...current, view: 'chat' }));
        }
        if (document.activeElement instanceof HTMLElement) {
          returnFocus.current = document.activeElement;
        }
        focusComposer();
      } else closeAssistant();
    };
  });
  useEffect(() => {
    if (!available) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || !isAssistantShortcut(event)) return;
      event.preventDefault();
      shortcut.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [available]);

  // `?pm=` opens the drawer (links, the screenshot run), then leaves the URL.
  useEffect(() => {
    if (!available) return;
    const search = new URLSearchParams(location.search);
    const next = drawerStateFromSearch(search, state);
    if (!next) return;
    setState(next);
    void navigate(
      {
        pathname: location.pathname,
        search: withoutDrawerParams(search),
        hash: location.hash,
      },
      { replace: true },
    );
    // Reacts to the URL only; `state` is read for the fields `pm=history` keeps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, location.search]);

  const value = useMemo<PmAssistantValue>(
    () => ({
      ...state,
      open: available && state.open,
      available,
      openAssistant,
      closeAssistant,
      toggleAssistant,
      setMode: (mode) => setState((current) => ({ ...current, mode })),
      setView: (view) => setState((current) => ({ ...current, view })),
      selectConversation: (conversationId) =>
        setState((current) => ({ ...current, view: 'chat', conversationId })),
      pinned,
      clearPinned: () => setPinned([]),
      draft,
      registerComposer,
      focusComposer,
    }),
    [
      state,
      available,
      openAssistant,
      closeAssistant,
      toggleAssistant,
      pinned,
      draft,
      registerComposer,
      focusComposer,
    ],
  );

  return (
    <PmAssistantContext.Provider value={value}>
      <PmSourcesProvider
        pathname={location.pathname}
        onUnpin={(key) =>
          setPinned((current) =>
            current.filter((item) => objectKey(item) !== key),
          )
        }
      >
        {children}
      </PmSourcesProvider>
    </PmAssistantContext.Provider>
  );
}

let sourceSeed = 0;

/** What the current page contributes; objects, the filter, the selection and removed tags reset with the path. */
function PmSourcesProvider({
  pathname,
  onUnpin,
  children,
}: {
  readonly pathname: string;
  readonly onUnpin: (key: string) => void;
  readonly children: ReactNode;
}): ReactElement {
  const [objects, setObjects] = useState<
    ReadonlyMap<number, PmContextObject>
  >(new Map());
  const [filters, setFilters] = useState<
    ReadonlyMap<number, PmContextFilter>
  >(new Map());
  const [selection, setSelection] = useState<PmSelection | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const onUnpinRef = useRef(onUnpin);
  useEffect(() => {
    onUnpinRef.current = onUnpin;
  });

  useEffect(() => {
    setSelection(null);
    setRemoved(new Set());
  }, [pathname]);

  // The last non-empty selection outside the drawer: clicking into the composer clears the page's selection.
  useEffect(() => {
    function onSelectionChange(): void {
      const current = document.getSelection();
      if (!current || current.isCollapsed) return;
      const text = clampSelection(current.toString());
      if (!text) return;
      const anchor = current.anchorNode;
      const element =
        anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      if (element?.closest(`[${PM_DRAWER_ATTRIBUTE}]`)) return;
      if (element?.closest('input, textarea, [contenteditable="true"]')) return;
      const source = parseSourceAttribute(
        element?.closest('[data-pm-source]')?.getAttribute('data-pm-source'),
      );
      setSelection((previous) =>
        previous?.text === text ? previous : { text, ...(source ?? {}) },
      );
      setRemoved((current) => {
        if (!current.has(SELECTION_KEY)) return current;
        const next = new Set(current);
        next.delete(SELECTION_KEY);
        return next;
      });
    }
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const register = useCallback((object: PmContextObject) => {
    sourceSeed += 1;
    const key = sourceSeed;
    setObjects((current) => new Map(current).set(key, object));
    return () =>
      setObjects((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
  }, []);

  const registerFilter = useCallback((filter: PmContextFilter) => {
    sourceSeed += 1;
    const key = sourceSeed;
    setFilters((current) => new Map(current).set(key, filter));
    return () =>
      setFilters((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
  }, []);

  const remove = useCallback((key: string) => {
    onUnpinRef.current(key);
    setRemoved((current) => new Set(current).add(key));
  }, []);

  const value = useMemo<PmSourcesValue>(
    () => ({
      objects: [...objects.values()],
      // The innermost page registers last and wins.
      filter: [...filters.values()].at(-1) ?? null,
      selection,
      removed,
      register,
      registerFilter,
      remove,
    }),
    [objects, filters, selection, removed, register, registerFilter, remove],
  );
  return (
    <PmSourcesContext.Provider value={value}>
      {children}
    </PmSourcesContext.Provider>
  );
}

/**
 * Registers the object a page shows as context for the project manager while the page is mounted. Pass null while
 * it is loading. The label is what the tag shows.
 */
export function usePmContextSource(object: PmContextObject | null): void {
  const { register } = usePmSources();
  const type = object?.type;
  const id = object?.id;
  const label = object?.label;
  useEffect(() => {
    if (!type || !id) return;
    return register({ type, id, label: label ?? id });
  }, [register, type, id, label]);
}

/** Registers a list page's filter (from its URL) while the page is mounted; null registers nothing. */
export function usePmFilterSource(filter: PmContextFilter | null): void {
  const { registerFilter } = usePmSources();
  const serialized = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (!serialized) return;
    return registerFilter(JSON.parse(serialized) as PmContextFilter);
  }, [registerFilter, serialized]);
}

/** Registers the filter a list page keeps in its URL (the listed keys) as project manager context. */
export function usePmUrlFilter(
  page: PmContextFilter['page'],
  keys: readonly string[],
): void {
  const { search } = useLocation();
  usePmFilterSource(filterFromSearch(page, new URLSearchParams(search), keys));
}
