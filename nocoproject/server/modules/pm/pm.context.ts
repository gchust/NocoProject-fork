/**
 * The page context of a conversation message (NP-183, protocol-pm-assistant.md §8): the browser sends ids only; the
 * server checks the shape (400 `INVALID_CONTEXT`), drops every item the author may not see — silently, so an item's
 * existence does not leak — and stores the rest with their labels in `comments.context`. The agent reads it from the
 * claim (`triggers[].comment.context`).
 */
import { canSeeIssue, canSeeProject, type Viewer } from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import {
  PM_CONTEXT_FILTER_KEYS_MAX,
  PM_CONTEXT_ITEMS_MAX,
  PM_CONTEXT_ROUTE_MAX,
  PM_CONTEXT_SELECTION_MAX,
  type PmContextItemType,
  type PmPageContext,
  type PmResolvedContext,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';

const ITEM_TYPES: readonly PmContextItemType[] = [
  'issue',
  'project',
  'knowledgeDoc',
  'inboxItem',
  'run',
  'agent',
  'pullRequest',
];
const FILTER_PAGES = ['issues', 'board', 'inbox', 'knowledge'] as const;

type Item = PmResolvedContext['items'][number];

function bad(message: string): never {
  throw invalid('INVALID_CONTEXT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isItemType(value: unknown): value is PmContextItemType {
  return ITEM_TYPES.includes(value as PmContextItemType);
}

/** The context as sent, or 400 `INVALID_CONTEXT`. */
export function parsePageContext(value: unknown): PmPageContext {
  if (!isRecord(value)) bad('context must be an object.');
  const { route, items, filter, selection } = value;
  if (typeof route !== 'string' || route.length > PM_CONTEXT_ROUTE_MAX)
    bad(`context.route must be a string of at most ${PM_CONTEXT_ROUTE_MAX}.`);
  if (!Array.isArray(items) || items.length > PM_CONTEXT_ITEMS_MAX)
    bad(`context.items must be a list of at most ${PM_CONTEXT_ITEMS_MAX}.`);
  const parsed = items.map((item) => {
    if (
      !isRecord(item) ||
      !isItemType(item.type) ||
      typeof item.id !== 'string'
    )
      bad('Each context item needs a known type and an id.');
    return { type: item.type, id: item.id };
  });
  return {
    route,
    items: parsed,
    ...(filter === undefined ? {} : { filter: parseFilter(filter) }),
    ...(selection === undefined
      ? {}
      : { selection: parseSelection(selection) }),
  };
}

function parseFilter(value: unknown): NonNullable<PmPageContext['filter']> {
  if (
    !isRecord(value) ||
    !FILTER_PAGES.includes(value.page as (typeof FILTER_PAGES)[number]) ||
    !isRecord(value.params)
  )
    bad('context.filter needs a known page and params.');
  const entries = Object.entries(value.params);
  if (
    entries.length > PM_CONTEXT_FILTER_KEYS_MAX ||
    entries.some(([, v]) => typeof v !== 'string')
  )
    bad(
      `context.filter.params holds at most ${PM_CONTEXT_FILTER_KEYS_MAX} string values.`,
    );
  return {
    page: value.page as (typeof FILTER_PAGES)[number],
    params: Object.fromEntries(entries) as Record<string, string>,
  };
}

function parseSelection(
  value: unknown,
): NonNullable<PmPageContext['selection']> {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    value.text.length > PM_CONTEXT_SELECTION_MAX
  )
    bad(`context.selection.text must be at most ${PM_CONTEXT_SELECTION_MAX}.`);
  if (value.sourceType !== undefined && !isItemType(value.sourceType))
    bad('context.selection.sourceType is unknown.');
  if (value.sourceId !== undefined && typeof value.sourceId !== 'string')
    bad('context.selection.sourceId must be a string.');
  return {
    text: value.text,
    ...(value.sourceType === undefined
      ? {}
      : { sourceType: value.sourceType as PmContextItemType }),
    ...(value.sourceId === undefined
      ? {}
      : { sourceId: value.sourceId as string }),
  };
}

async function visibleIssue(
  conn: Conn,
  viewer: Viewer,
  issueId: string | null,
): Promise<Item | null> {
  if (!issueId) return null;
  const issue = await findIssue(conn, issueId);
  if (!issue || !(await canSeeIssue(conn, viewer, issue))) return null;
  return {
    type: 'issue',
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title,
  };
}

async function resolveItem(
  conn: Conn,
  viewer: Viewer,
  type: PmContextItemType,
  id: string,
): Promise<Item | null> {
  switch (type) {
    case 'issue':
      return visibleIssue(conn, viewer, id);
    case 'project': {
      const row = await conn.query
        .selectFrom('projects')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row || !(await canSeeProject(conn, viewer, id))) return null;
      return { type, id, identifier: null, title: str(row.name) ?? '' };
    }
    case 'knowledgeDoc': {
      const row = await conn.query
        .selectFrom('knowledgeDocs')
        .select(['projectId', 'title', 'slug', 'archivedAt'])
        .where('id', '=', id)
        .executeTakeFirst();
      const projectId = str(row?.projectId) || null;
      if (
        !row ||
        row.archivedAt ||
        !(await canSeeProject(conn, viewer, projectId))
      )
        return null;
      return {
        type,
        id,
        identifier: str(row.slug),
        title: str(row.title) ?? '',
      };
    }
    case 'inboxItem': {
      const row = await conn.query
        .selectFrom('inboxItems')
        .select(['userId', 'title'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row || row.userId !== viewer.userId) return null;
      return { type, id, identifier: null, title: str(row.title) ?? '' };
    }
    case 'run': {
      const row = await conn.query
        .selectFrom('runs')
        .select(['subjectId'])
        .where('id', '=', id)
        .executeTakeFirst();
      const issue = await visibleIssue(conn, viewer, str(row?.subjectId));
      return issue
        ? { type, id, identifier: issue.identifier, title: issue.title }
        : null;
    }
    case 'agent': {
      const row = await conn.query
        .selectFrom('agents')
        .select(['name', 'archivedAt', 'deletedAt'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row || row.archivedAt || row.deletedAt) return null;
      return { type, id, identifier: null, title: str(row.name) ?? '' };
    }
    case 'pullRequest': {
      const pr = await conn.query
        .selectFrom('pullRequests')
        .select(['repo', 'number', 'title'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!pr) return null;
      const links = await conn.query
        .selectFrom('issuePullRequests')
        .select('issueId')
        .where('pullRequestId', '=', id)
        .execute();
      for (const link of links)
        if (await visibleIssue(conn, viewer, str(link.issueId)))
          return {
            type,
            id,
            identifier: `${str(pr.repo)}#${String(pr.number)}`,
            title: str(pr.title) ?? '',
          };
      return null;
    }
  }
}

/** The context as stored and handed to the agent: only what `viewer` (the message's author) may see. */
export async function resolvePageContext(
  conn: Conn,
  viewer: Viewer,
  context: PmPageContext,
): Promise<PmResolvedContext> {
  const items: Item[] = [];
  for (const item of context.items) {
    const resolved = await resolveItem(conn, viewer, item.type, item.id);
    if (resolved) items.push(resolved);
  }
  return {
    route: context.route,
    items,
    ...(context.filter ? { filter: context.filter } : {}),
    ...(context.selection ? { selection: context.selection } : {}),
  };
}
