import type {
  PmContextItemType,
  PmFilterPage,
  PmPageContext,
} from '../../types-pm.js';

/**
 * Page context for a project manager message (`protocol-pm-assistant.md` §8.1), as pure data. Pages register what
 * they show (an object, a list filter); the drawer keeps the last text selected on the page and the objects pinned
 * by an "Ask the project manager" button. The composer shows all of it as removable tags and sends ids only — the
 * labels here are for the tags, the server resolves its own.
 */

export const PM_CONTEXT_LIMITS = {
  route: 500,
  items: 10,
  filterKeys: 20,
  selection: 2000,
} as const;

export interface PmContextObject {
  readonly type: PmContextItemType;
  readonly id: string;
  /** What the tag shows: the identifier and title, a project name, a document title. */
  readonly label: string;
}

export interface PmContextFilter {
  readonly page: PmFilterPage;
  readonly params: Readonly<Record<string, string>>;
}

export interface PmSelection {
  readonly text: string;
  readonly sourceType?: PmContextItemType;
  readonly sourceId?: string;
}

export type PmContextChip =
  | {
      readonly key: string;
      readonly kind: 'object';
      readonly object: PmContextObject;
      readonly pinned: boolean;
    }
  | {
      readonly key: string;
      readonly kind: 'filter';
      readonly filter: PmContextFilter;
    }
  | {
      readonly key: string;
      readonly kind: 'selection';
      readonly selection: PmSelection;
    };

export interface PmContextInput {
  /** pathname + search of the page the message is written on. */
  readonly route: string;
  /** Objects brought in by "Ask the project manager": kept across pages until sent or removed. */
  readonly pinned: readonly PmContextObject[];
  /** Objects the current page registered. */
  readonly sources: readonly PmContextObject[];
  readonly filter: PmContextFilter | null;
  readonly selection: PmSelection | null;
  /** Tag keys the member removed on this page. */
  readonly removed: ReadonlySet<string>;
}

export const SELECTION_KEY = 'selection';
export const FILTER_KEY = 'filter';

export function objectKey(object: {
  readonly type: string;
  readonly id: string;
}): string {
  return `${object.type}:${object.id}`;
}

const ITEM_TYPES: ReadonlySet<string> = new Set<PmContextItemType>([
  'issue',
  'project',
  'knowledgeDoc',
  'inboxItem',
  'run',
  'agent',
  'pullRequest',
]);

export function isContextItemType(value: string): value is PmContextItemType {
  return ITEM_TYPES.has(value);
}

/** The tags above the composer, pinned objects first, each object once, capped like the payload. */
export function contextChips(input: PmContextInput): PmContextChip[] {
  const chips: PmContextChip[] = [];
  const seen = new Set<string>();
  const pinnedKeys = new Set(input.pinned.map(objectKey));
  for (const object of [...input.pinned, ...input.sources]) {
    const key = objectKey(object);
    if (seen.has(key) || input.removed.has(key)) continue;
    seen.add(key);
    if (seen.size > PM_CONTEXT_LIMITS.items) break;
    chips.push({ key, kind: 'object', object, pinned: pinnedKeys.has(key) });
  }
  if (
    input.filter &&
    !input.removed.has(FILTER_KEY) &&
    Object.keys(input.filter.params).length > 0
  ) {
    chips.push({ key: FILTER_KEY, kind: 'filter', filter: input.filter });
  }
  if (input.selection && !input.removed.has(SELECTION_KEY)) {
    chips.push({
      key: SELECTION_KEY,
      kind: 'selection',
      selection: input.selection,
    });
  }
  return chips;
}

/** The `context` field of the message: what the tags show, ids only, within the contract's limits. */
export function buildPageContext(
  input: PmContextInput,
): PmPageContext | undefined {
  const chips = contextChips(input);
  const items: { type: PmContextItemType; id: string }[] = [];
  let filter: PmPageContext['filter'];
  let selection: PmPageContext['selection'];
  for (const chip of chips) {
    if (chip.kind === 'object') {
      items.push({ type: chip.object.type, id: chip.object.id });
    } else if (chip.kind === 'filter') {
      filter = chip.filter;
    } else {
      selection = chip.selection;
    }
  }
  const route = input.route.slice(0, PM_CONTEXT_LIMITS.route);
  if (!route && items.length === 0 && !filter && !selection) return undefined;
  return {
    route,
    items,
    ...(filter ? { filter } : {}),
    ...(selection ? { selection } : {}),
  };
}

/**
 * A list page's filter from its URL: the listed keys that carry a value, at most 20. Keys that only arrange the
 * page (the view, a tab, the open item) are not filters, so callers list the keys they filter by.
 */
export function filterFromSearch(
  page: PmFilterPage,
  search: URLSearchParams,
  keys: readonly string[],
): PmContextFilter | null {
  const params: Record<string, string> = {};
  let count = 0;
  for (const key of keys) {
    const value = search.getAll(key).filter(Boolean).join(',');
    if (!value) continue;
    params[key] = value;
    count += 1;
    if (count >= PM_CONTEXT_LIMITS.filterKeys) break;
  }
  return count > 0 ? { page, params } : null;
}

/** Selected text as it is sent: whitespace collapsed at the ends, cut at 2000 characters; empty is no selection. */
export function clampSelection(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > PM_CONTEXT_LIMITS.selection
    ? trimmed.slice(0, PM_CONTEXT_LIMITS.selection)
    : trimmed;
}

/** `data-pm-source="issue:<id>"` on an ancestor of the selection names the object the text comes from. */
export function parseSourceAttribute(
  value: string | null | undefined,
): { sourceType: PmContextItemType; sourceId: string } | null {
  if (!value) return null;
  const index = value.indexOf(':');
  if (index <= 0) return null;
  const type = value.slice(0, index);
  const id = value.slice(index + 1);
  if (!id || !isContextItemType(type)) return null;
  return { sourceType: type, sourceId: id };
}

/** The data attribute value for `parseSourceAttribute`. */
export function sourceAttribute(type: PmContextItemType, id: string): string {
  return `${type}:${id}`;
}

/** A short, single-line quote of a selection for its tag. */
export function selectionPreview(text: string, max = 40): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
