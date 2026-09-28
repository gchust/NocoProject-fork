/**
 * The design-first process on issue writes (docs/phase1/iteration-4-contract.md §B):
 *
 * - creation: `process` from the request (`direct` / `design_first`, by `user`), else `settings.defaultProcess`
 *   (by `default`), and `auto` asks the classifier (`intake/process-classifier.ts`, by `heuristic` or `ai`); the
 *   choice is recorded as the `process_selected` activity;
 * - `PATCH { process }` only while the issue is in backlog / todo (409 `PROCESS_LOCKED`), recorded as
 *   `process_selected` by `user`;
 * - the design gate: an agent may not write `in_progress` on a design-first issue before the design is approved
 *   (403 `DESIGN_NOT_APPROVED`), may enter `analysis` only on a design-first issue, and `proposal_review` only once a
 *   proposal exists (409 `PROPOSAL_REQUIRED`); a member may skip the design (activity `design_skipped`).
 */
import type { Conn } from '../shared/db.js';
import { iso, str } from '../shared/db.js';
import { conflict, forbidden, invalid } from '../shared/errors.js';
import type {
  DefaultProcess,
  DesignProposal,
  IssueProcess,
  IssueV4,
} from '../shared/protocol.js';
import {
  DEFAULT_PROCESSES,
  ISSUE_PROCESSES,
  PROCESS_EDITABLE_STATUSES,
  STATUS_ANALYSIS,
  STATUS_PROPOSAL_REVIEW,
} from '../shared/protocol.js';
import type { SettingsService } from '../system/settings.service.js';
import type {
  ProcessClassifier,
  ProcessRule,
} from '../intake/process-classifier.js';
import type { ActivityEntry } from './issue.fields.js';

/** `process_selected.details.by`: the request, the workspace default, or the classifier. */
export type ProcessSource = 'user' | 'default' | 'heuristic' | 'ai';

export interface ProcessSelection {
  readonly process: IssueProcess;
  readonly by: ProcessSource;
  readonly rule?: ProcessRule | null;
}

export function validateProcess(
  value: unknown,
  allowAuto: true,
): DefaultProcess;
export function validateProcess(value: unknown, allowAuto: false): IssueProcess;
export function validateProcess(
  value: unknown,
  allowAuto: boolean,
): DefaultProcess {
  const allowed: readonly string[] = allowAuto
    ? DEFAULT_PROCESSES
    : ISSUE_PROCESSES;
  if (typeof value !== 'string' || !allowed.includes(value))
    throw invalid('INVALID_PROCESS', `process must be ${allowed.join(', ')}.`);
  return value as DefaultProcess;
}

export interface SelectProcessDeps {
  readonly settings: SettingsService;
  readonly classifier: ProcessClassifier;
}

/**
 * The process of a new issue. Runs outside any transaction: the classifier may make a model call of up to 30
 * seconds. `useAi: false` keeps it to the heuristic (intake batches).
 */
export async function selectProcess(
  deps: SelectProcessDeps,
  conn: Conn,
  input: {
    readonly process?: unknown;
    readonly title: string;
    readonly description: string;
  },
  options: { readonly userId: string; readonly useAi: boolean },
): Promise<ProcessSelection> {
  const requested =
    input.process === undefined || input.process === null
      ? 'auto'
      : validateProcess(input.process, true);
  if (requested !== 'auto') return { process: requested, by: 'user' };
  const fallback = (await deps.settings.read(conn)).defaultProcess;
  if (fallback !== 'auto') return { process: fallback, by: 'default' };
  const decision = await deps.classifier.classify(
    { title: input.title, description: input.description },
    options,
  );
  return { process: decision.process, by: decision.by, rule: decision.rule };
}

/** The `process_selected` activity details for a selection. */
export function processActivity(
  selection: ProcessSelection,
): Record<string, unknown> {
  return {
    process: selection.process,
    by: selection.by,
    ...(selection.rule ? { rule: selection.rule } : {}),
  };
}

/** `PATCH { process }` (only in backlog / todo). */
export function processChange(
  before: IssueV4,
  value: unknown,
  values: Record<string, unknown>,
  activities: ActivityEntry[],
): void {
  if (value === undefined) return;
  const next = validateProcess(value, false);
  if (next === before.process) return;
  if (!PROCESS_EDITABLE_STATUSES.includes(before.statusKey))
    throw conflict(
      'PROCESS_LOCKED',
      `The process can only change in ${PROCESS_EDITABLE_STATUSES.join(' or ')}; the issue is ${before.statusKey}.`,
    );
  values.process = next;
  activities.push({
    action: 'process_selected',
    details: { process: next, from: before.process, by: 'user' },
  });
}

/** A member moving an unapproved design-first issue to in_progress skips the design (recorded, not refused). */
export function designSkip(
  before: IssueV4,
  values: Record<string, unknown>,
  activities: ActivityEntry[],
): void {
  const process =
    (values.process as IssueProcess | undefined) ?? before.process;
  if (
    values.statusKey === 'in_progress' &&
    process === 'design_first' &&
    !before.designApprovedAt
  )
    activities.push({
      action: 'design_skipped',
      details: { from: before.statusKey },
    });
}

/** The latest design proposal on an issue (a `kind = 'proposal'` comment), or null. */
export async function latestProposal(
  conn: Conn,
  issueId: string,
): Promise<DesignProposal | null> {
  const row = await conn.query
    .selectFrom('comments')
    .select(['id', 'content', 'createdAt'])
    .where('issueId', '=', issueId)
    .where('kind', '=', 'proposal')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!row) return null;
  return {
    commentId: str(row.id) ?? '',
    content: str(row.content) ?? '',
    createdAt: iso(row.createdAt),
  };
}

/** The design gate on an agent's status write (see the file comment). */
export async function agentProcessGate(
  conn: Conn,
  before: IssueV4,
  target: string,
): Promise<void> {
  if (
    target === 'in_progress' &&
    before.process === 'design_first' &&
    !before.designApprovedAt
  )
    throw forbidden(
      'DESIGN_NOT_APPROVED',
      'This issue is design-first: submit a proposal and wait for approval before starting the implementation.',
    );
  if (target === STATUS_ANALYSIS && before.process !== 'design_first')
    throw forbidden(
      'TRANSITION_NOT_ALLOWED',
      'Only design-first issues go through analysis.',
    );
  if (
    target === STATUS_PROPOSAL_REVIEW &&
    !(await latestProposal(conn, before.id))
  )
    throw conflict(
      'PROPOSAL_REQUIRED',
      'Submit the design proposal (issue design-proposal) before asking for review.',
    );
}
