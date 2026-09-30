/**
 * Project manager conversations (NP-183, protocol-pm-assistant.md §5): each is a private issue with
 * `originType = 'pm'` plus a `pmConversations` row. They are not work items, so every list, board, search, metric,
 * notification and dependency leaves them out, for their owner too; only the conversation pages and usage show them.
 * Use these helpers instead of repeating the predicate.
 */
import type { Expression, ExpressionBuilder, SqlBool } from '@nocobase/db';

import type { Conn } from './db.js';
import { invalid } from './errors.js';

export const CONVERSATION_ORIGIN = 'pm';

/** Whether an issue row is a conversation. */
export function isConversation(issue: object): boolean {
  return (
    (issue as { readonly originType?: unknown }).originType ===
    CONVERSATION_ORIGIN
  );
}

/** `where(notConversation(column))`: the row's issue column (default `originType` on `issues`) is not a conversation. */
export function notConversation(
  column = 'originType',
): (eb: ExpressionBuilder) => Expression<SqlBool> {
  return (eb) => eb(column, '!=', CONVERSATION_ORIGIN);
}

/** 400 `CONVERSATION_NOT_ISSUE` when an issue is a conversation (parent, child, dependency, plan row). */
export function requireWorkItem(issue: object): void {
  if (isConversation(issue))
    throw invalid(
      'CONVERSATION_NOT_ISSUE',
      'A project manager conversation cannot be used as a task.',
    );
}

/** The same check by id; unknown ids pass (the caller reports them). */
export async function requireWorkItemId(
  conn: Conn,
  issueId: string | null | undefined,
): Promise<void> {
  if (!issueId) return;
  const row = await conn.query
    .selectFrom('issues')
    .select('originType')
    .where('id', '=', issueId)
    .executeTakeFirst();
  if (row) requireWorkItem({ originType: String(row.originType) });
}
