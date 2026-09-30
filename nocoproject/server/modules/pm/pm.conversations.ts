/**
 * Project manager conversations (NP-183, protocol-pm-assistant.md §5, §6.5). A member may hold any number; each is a
 * private `originType = 'pm'` issue without an NP-n number plus a `pmConversations` row, visible only to its owner
 * (404 for everybody else). Creating one starts no run; the owner's first message does.
 *
 * - The agent is picked at creation from the member's choice (`memberPreferences`: system default or their personal
 *   project manager, which must still pass §6.3, else the system default as `fallback`) and then stays: changing the
 *   choice or the system default affects new conversations only. When the bound agent becomes unusable, the owner's
 *   next message rebinds the conversation to the system default (`fallback`) before the message's run is enqueued.
 * - Titles: an explicit title is `user`; otherwise the first message's first 30 characters (`auto`), which the agent
 *   may rewrite once (`agent`, 409 `TITLE_LOCKED` after a member renamed it).
 * - `fallback` / `restore` switch a personal conversation to the system default and back (§6.5).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { viewerOf } from '../shared/authz.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { isPostgres, knexOf, now, str } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import { decodeCursor, encodeCursor, pageLimit } from '../shared/pagination.js';
import {
  PM_TITLE_AUTO_CHARS,
  PM_TITLE_MAX,
  type IssueV4,
  type PmConversationCreateRequest,
  type PmConversationDetail,
  type PmConversationPage,
  type PmConversationPatch,
  type PmConversationResponse,
  type PmResolvedContext,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { findIssue } from '../issue/issue.records.js';
import type { IssueService } from '../issue/issue.service.js';
import { preferencesOf } from '../member/member.service.js';
import type { SettingsService } from '../system/settings.service.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import {
  allowsPersonal,
  boundAgentUsable,
  loadPmAgentFacts,
  personalIneligibility,
  systemPmAgent,
} from './pm-agent.eligibility.js';
import {
  autoTitle,
  conversationDetail,
  conversationSummary,
  findConversation,
  mapConversation,
  rebindConversation,
  touchConversation,
  type ConversationRow,
} from './pm.conversation-records.js';
import { parsePageContext, resolvePageContext } from './pm.context.js';

export interface ConversationDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly settings: SettingsService;
  readonly issues: () => IssueService;
  readonly triggers: () => TriggerService;
}

export interface ConversationQuery {
  readonly q?: string | null;
  readonly archived?: boolean;
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

/** What a message in a conversation needs from the conversation, inside the message's transaction. */
export interface ConversationMessage {
  readonly issue: IssueV4;
  readonly actor: Actor;
  readonly content: string;
  /** `CreateCommentRequest.context` as sent (validated here). */
  readonly context?: unknown;
}

export interface ConversationMessageResult {
  readonly context: PmResolvedContext | null;
  /** The issue as the trigger rules must see it (its executor may have been rebound). */
  readonly issue: IssueV4;
}

export interface ConversationService {
  list(actor: Actor, query: ConversationQuery): Promise<PmConversationPage>;
  create(
    actor: Actor,
    input: PmConversationCreateRequest,
  ): Promise<PmConversationDetail>;
  get(actor: Actor, id: string): Promise<PmConversationDetail>;
  patch(
    actor: Actor,
    id: string,
    patch: PmConversationPatch,
  ): Promise<PmConversationDetail>;
  fallback(actor: Actor, id: string): Promise<PmConversationDetail>;
  restore(actor: Actor, id: string): Promise<PmConversationDetail>;
  /** `GET` / `POST /np/pm/conversation` (iteration 4): the latest unarchived conversation, created on POST. */
  legacy(actor: Actor, create: boolean): Promise<PmConversationResponse>;
  /** `POST /np/agent/pm/conversation/title` for a conversation run's conversation. */
  agentTitle(issueId: string, title: unknown): Promise<PmConversationDetail>;
  /** Called by `comment.service` for every comment; a no-op outside conversations. */
  onMessage(
    tx: Tx,
    message: ConversationMessage,
  ): Promise<ConversationMessageResult>;
  /** The detail of a conversation for its owner, or null when `issueId` is not a conversation. */
  detailOf(issueId: string): Promise<PmConversationDetail | null>;
}

const LIST_DEFAULT = 30;
const LIST_MAX = 100;

async function lockMember(tx: Tx, userId: string): Promise<void> {
  if (!isPostgres(tx.conn)) return;
  const knex = await knexOf(tx.conn);
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `nocoproject:pm:${userId}`,
  ]);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

/** The conversation `id` of its owner `userId`, else 404. */
async function owned(
  deps: ConversationDeps,
  tx: Tx | null,
  userId: string,
  id: string,
): Promise<{ row: ConversationRow; issue: IssueV4 }> {
  const conn = tx?.conn ?? deps.tx.read();
  const row = await findConversation(conn, id);
  const issue = row ? await findIssue(conn, id) : null;
  if (!row || !issue || row.ownerUserId !== userId)
    throw notFound('Conversation');
  return { row, issue };
}

/** Which agent a new conversation of `userId` gets (§5.6, §6). */
async function pickAgent(deps: ConversationDeps, tx: Tx, userId: string) {
  const prefs = await preferencesOf(tx.conn, userId);
  const system = await systemPmAgent(tx.conn, deps.settings, userId);
  if (prefs.pmAgentMode === 'personal' && prefs.pmAgentId) {
    const personal = await loadPmAgentFacts(tx.conn, prefs.pmAgentId);
    const allow = await allowsPersonal(tx.conn, deps.settings);
    if (personal && personalIneligibility(personal, userId, allow) === null)
      return {
        agentId: personal.id,
        agentSource: 'personal' as const,
        personalAgentId: null,
      };
    if (system)
      return {
        agentId: system.id,
        agentSource: 'fallback' as const,
        personalAgentId: prefs.pmAgentId,
      };
  }
  if (!system)
    throw conflict(
      'PM_NOT_CONFIGURED',
      'No project manager is configured (agentEntries.conversation must name a project manager type agent you may use).',
    );
  return {
    agentId: system.id,
    agentSource: 'system' as const,
    personalAgentId: null,
  };
}

function titleOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > 200)
    throw invalid('INVALID_TITLE', 'title must be 1–200 characters.');
  return value.trim();
}

async function createConversation(
  deps: ConversationDeps,
  actor: Actor,
  input: PmConversationCreateRequest,
  switchTo: (tx: Tx, userId: string, mode: 'system' | 'personal') => Promise<void>,
): Promise<PmConversationDetail> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  const title = titleOf(input?.title);
  const id = await deps.tx.run(async (tx) => {
    await lockMember(tx, userId);
    if (input?.switchTo === 'system' || input?.switchTo === 'personal')
      await switchTo(tx, userId, input.switchTo);
    const agent = await pickAgent(deps, tx, userId);
    const created = await deps.issues().insertIssue(tx, actor, {
      title: title ?? '',
      description: '',
      statusKey: 'todo',
      priority: 'none',
      ownerUserId: userId,
      executor: { executorType: 'agent', executorId: agent.agentId },
      parentIssueId: null,
      projectId: null,
      stage: null,
      startDate: null,
      dueDate: null,
      autoExecuteSubtasks: false,
      labelIds: [],
      createdById: userId,
      executionMode: 'session',
      originType: 'pm',
      originId: null,
      process: 'direct',
    });
    const timestamp = now();
    await tx.conn.query
      .insertInto('pmConversations')
      .values({
        issueId: created.id,
        ownerUserId: userId,
        ...agent,
        titleSource: title ? 'user' : 'auto',
        lastMessageAt: timestamp,
        archivedAt: null,
        createdAt: timestamp,
      })
      .execute();
    return created.id;
  });
  return getConversation(deps, actor, id);
}

async function getConversation(
  deps: ConversationDeps,
  actor: Actor,
  id: string,
): Promise<PmConversationDetail> {
  const conn = deps.tx.read();
  const userId = (await viewerOf(conn, actor)).userId;
  const { row, issue } = await owned(deps, null, userId, id);
  return conversationDetail(conn, deps.settings, row, issue);
}

async function listConversations(
  deps: ConversationDeps,
  actor: Actor,
  query: ConversationQuery,
): Promise<PmConversationPage> {
  const conn = deps.tx.read();
  const userId = (await viewerOf(conn, actor)).userId;
  const limit = pageLimit(query.limit, LIST_DEFAULT, LIST_MAX);
  let select = conn.query
    .selectFrom('pmConversations')
    .innerJoin('issues', 'issues.id', 'pmConversations.issueId')
    .selectAll('pmConversations')
    .select(['issues.title as title'])
    .where('pmConversations.ownerUserId', '=', userId)
    .where('issues.deletedAt', 'is', null)
    .where(
      'pmConversations.archivedAt',
      query.archived ? 'is not' : 'is',
      null,
    );
  const q = query.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    select = select.where((eb) =>
      eb.or([
        eb('issues.title', 'like', pattern),
        eb.exists(
          eb
            .selectFrom('comments')
            .select('comments.id')
            .whereRef('comments.issueId', '=', 'pmConversations.issueId')
            .where('comments.content', 'like', pattern),
        ),
      ]),
    );
  }
  if (query.cursor) {
    const key = decodeCursor(query.cursor);
    select = select.where((eb) =>
      eb.or([
        eb('pmConversations.lastMessageAt', '<', key.at),
        eb.and([
          eb('pmConversations.lastMessageAt', '=', key.at),
          eb('pmConversations.issueId', '<', key.id),
        ]),
      ]),
    );
  }
  const rows = await select
    .orderBy('pmConversations.lastMessageAt', 'desc')
    .orderBy('pmConversations.issueId', 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const data = [];
  for (const raw of page)
    data.push(
      await conversationSummary(conn, deps.settings, mapConversation(raw), {
        title: str(raw.title) ?? '',
      }),
    );
  const last = page.at(-1);
  return {
    data,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(
            mapConversation(last).lastMessageAt,
            str(last.issueId) ?? '',
          )
        : null,
  };
}

async function setTitle(
  tx: Tx,
  issue: IssueV4,
  title: string,
  source: 'auto' | 'agent' | 'user',
): Promise<void> {
  const timestamp = now();
  await tx.conn.query
    .updateTable('issues')
    .set({ title, revision: issue.revision + 1, updatedAt: timestamp })
    .where('id', '=', issue.id)
    .execute();
  await tx.conn.query
    .updateTable('pmConversations')
    .set({ titleSource: source })
    .where('issueId', '=', issue.id)
    .execute();
  tx.emit({ type: 'issue.changed', issueId: issue.id });
}

async function patchConversation(
  deps: ConversationDeps,
  actor: Actor,
  id: string,
  patch: PmConversationPatch,
): Promise<PmConversationDetail> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  const title = titleOf(patch?.title);
  if (patch?.archived !== undefined && typeof patch.archived !== 'boolean')
    throw invalid('INVALID_CONVERSATION', 'archived must be a boolean.');
  await deps.tx.run(async (tx) => {
    const { issue } = await owned(deps, tx, userId, id);
    if (title !== undefined) await setTitle(tx, issue, title, 'user');
    if (patch.archived !== undefined)
      await tx.conn.query
        .updateTable('pmConversations')
        .set({ archivedAt: patch.archived ? now() : null })
        .where('issueId', '=', id)
        .execute();
  });
  return getConversation(deps, actor, id);
}

async function switchAgent(
  deps: ConversationDeps,
  actor: Actor,
  id: string,
  direction: 'fallback' | 'restore',
): Promise<PmConversationDetail> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  await deps.tx.run(async (tx) => {
    const { row } = await owned(deps, tx, userId, id);
    if (direction === 'fallback') {
      if (row.agentSource !== 'personal' || !row.agentId)
        throw conflict('NOT_PERSONAL', 'This conversation uses the system project manager.');
      const system = await systemPmAgent(tx.conn, deps.settings, userId);
      if (!system)
        throw conflict('PM_NOT_CONFIGURED', 'No system project manager is configured.');
      await rebindConversation(deps, tx, row, {
        agentId: system.id,
        agentSource: 'fallback',
        personalAgentId: row.agentId,
        reason: 'pmFallback',
        note: `This conversation now uses ${system.name} until you switch back.`,
      });
      return;
    }
    const personal = await loadPmAgentFacts(tx.conn, row.personalAgentId);
    if (
      row.agentSource !== 'fallback' ||
      !personal ||
      personalIneligibility(
        personal,
        userId,
        await allowsPersonal(tx.conn, deps.settings),
      ) !== null
    )
      throw conflict('PERSONAL_UNAVAILABLE', 'Your project manager cannot take this conversation back.');
    await rebindConversation(deps, tx, row, {
      agentId: personal.id,
      agentSource: 'personal',
      personalAgentId: null,
      reason: 'pmRestore',
      note: `This conversation uses ${personal.name} again.`,
    });
  });
  return getConversation(deps, actor, id);
}

async function legacyConversation(
  deps: ConversationDeps,
  actor: Actor,
  create: boolean,
  switchTo: (tx: Tx, userId: string, mode: 'system' | 'personal') => Promise<void>,
): Promise<PmConversationResponse> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  const latest = await deps.tx
    .read()
    .query.selectFrom('pmConversations')
    .innerJoin('issues', 'issues.id', 'pmConversations.issueId')
    .select(['pmConversations.issueId as issueId'])
    .where('pmConversations.ownerUserId', '=', userId)
    .where('pmConversations.archivedAt', 'is', null)
    .where('issues.deletedAt', 'is', null)
    .orderBy('pmConversations.lastMessageAt', 'desc')
    .executeTakeFirst();
  const id = str(latest?.issueId);
  if (!id && !create) throw notFound('Project manager conversation');
  const detail = id
    ? await getConversation(deps, actor, id)
    : await createConversation(deps, actor, {}, switchTo);
  return {
    issueId: detail.issueId,
    identifier: detail.identifier ?? '',
    agentId: detail.agent?.id ?? null,
  };
}

/** Rebinds before the message's run is enqueued when the bound agent is no longer usable (§5.6). */
async function ensureUsableAgent(
  deps: ConversationDeps,
  tx: Tx,
  row: ConversationRow,
  issue: IssueV4,
): Promise<IssueV4> {
  if (
    await boundAgentUsable(
      tx.conn,
      deps.settings,
      row.ownerUserId,
      row.agentId,
      row.agentSource,
    )
  )
    return issue;
  const system = await systemPmAgent(tx.conn, deps.settings, row.ownerUserId);
  // Nothing usable: the message is kept; no run starts until a project manager is configured.
  if (!system || system.id === row.agentId) return issue;
  return rebindConversation(deps, tx, row, {
    agentId: system.id,
    agentSource: 'fallback',
    personalAgentId:
      row.agentSource === 'personal' ? row.agentId : row.personalAgentId,
    reason: 'pmAgentUnavailable',
    note: `The previous project manager is not available; ${system.name} answers from now on.`,
  });
}

async function onMessage(
  deps: ConversationDeps,
  tx: Tx,
  message: ConversationMessage,
): Promise<ConversationMessageResult> {
  const row = await findConversation(tx.conn, message.issue.id);
  if (!row) return { context: null, issue: message.issue };
  await touchConversation(tx.conn, row.issueId);
  const { actor } = message;
  if (actor.type !== 'user' || actor.id !== row.ownerUserId || actor.via === 'pm')
    return { context: null, issue: message.issue };
  let context: PmResolvedContext | null = null;
  if (message.context !== undefined && message.context !== null)
    context = await resolvePageContext(
      tx.conn,
      await viewerOf(tx.conn, actor),
      parsePageContext(message.context),
    );
  let issue = message.issue;
  if (row.titleSource === 'auto' && issue.title === '') {
    const title = autoTitle(message.content, PM_TITLE_AUTO_CHARS);
    if (title) {
      await setTitle(tx, issue, title, 'auto');
      issue = (await findIssue(tx.conn, issue.id)) as IssueV4;
    }
  }
  issue = await ensureUsableAgent(deps, tx, row, issue);
  return { context, issue };
}

async function agentTitle(
  deps: ConversationDeps,
  issueId: string,
  value: unknown,
): Promise<PmConversationDetail> {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    [...value.trim()].length > PM_TITLE_MAX
  )
    throw invalid('INVALID_TITLE', `title must be 1–${PM_TITLE_MAX} characters.`);
  const row = await deps.tx.run(async (tx) => {
    const found = await findConversation(tx.conn, issueId);
    const issue = await findIssue(tx.conn, issueId);
    if (!found || !issue) throw notFound('Conversation');
    if (found.titleSource === 'user')
      throw conflict('TITLE_LOCKED', 'The member named this conversation; keep their title.');
    await setTitle(tx, issue, value.trim(), 'agent');
    return found;
  });
  const conn = deps.tx.read();
  return conversationDetail(
    conn,
    deps.settings,
    { ...row, titleSource: 'agent' },
    (await findIssue(conn, issueId)) as IssueV4,
  );
}

export function createConversationService(
  deps: ConversationDeps,
  switchTo: (tx: Tx, userId: string, mode: 'system' | 'personal') => Promise<void>,
): ConversationService {
  return {
    list: (actor, query) => listConversations(deps, actor, query),
    create: (actor, input) => createConversation(deps, actor, input, switchTo),
    get: (actor, id) => getConversation(deps, actor, id),
    patch: (actor, id, patch) => patchConversation(deps, actor, id, patch),
    fallback: (actor, id) => switchAgent(deps, actor, id, 'fallback'),
    restore: (actor, id) => switchAgent(deps, actor, id, 'restore'),
    legacy: (actor, create) => legacyConversation(deps, actor, create, switchTo),
    agentTitle: (issueId, title) => agentTitle(deps, issueId, title),
    onMessage: (tx, message) => onMessage(deps, tx, message),
    async detailOf(issueId) {
      const conn = deps.tx.read();
      const row = await findConversation(conn, issueId);
      const issue = row ? await findIssue(conn, issueId) : null;
      return row && issue
        ? conversationDetail(conn, deps.settings, row, issue)
        : null;
    },
  };
}
