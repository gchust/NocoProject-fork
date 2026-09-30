/**
 * The shape of a project manager operation's `params` (NP-202, protocol-pm-assistant.md §4.2), checked before the
 * operation runs, for direct writes and plan rows alike. Unknown fields are refused rather than dropped: a guessed
 * `executorType` or `issueId` must not leave the agent believing its write happened. Values (a priority, a label, a
 * status) stay the services' to judge; only field names and structure are checked here.
 *
 * A failure is 400 `INVALID_PARAMS` with `details.errors` (`{ field, message }`, `field` like `params.set.executor`),
 * and its message names the right field for the common guesses.
 */
import { invalid } from '../shared/errors.js';
import type { PmOperation, PmOperationType } from '../shared/protocol.js';

type Kind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'target'
  | 'targets'
  | 'executor'
  | 'strings'
  | 'nullable';

interface Field {
  readonly kind: Kind;
  readonly required?: boolean;
}

type Shape = Readonly<Record<string, Field>>;

const opt = (kind: Kind): Field => ({ kind });
const req = (kind: Kind): Field => ({ kind, required: true });

const UPDATE_SET: Shape = {
  title: opt('string'),
  description: opt('string'),
  priority: opt('string'),
  labelIds: opt('strings'),
  startDate: opt('nullable'),
  dueDate: opt('nullable'),
  projectId: opt('nullable'),
  process: opt('string'),
  ownerUserId: opt('string'),
  executor: opt('executor'),
};

const SHAPES: Partial<Record<PmOperationType, Shape>> = {
  'issue.create': {
    title: req('string'),
    description: opt('string'),
    projectId: opt('nullable'),
    parent: opt('target'),
    stage: opt('number'),
    blockedBy: opt('targets'),
    ownerUserId: opt('string'),
    executor: opt('executor'),
    priority: opt('string'),
    labelIds: opt('strings'),
    process: opt('string'),
    startDate: opt('string'),
    dueDate: opt('string'),
  },
  'issue.update': { issue: req('target') },
  'issue.status': { issue: req('target'), statusKey: req('string') },
  'dependency.add': { issue: req('target'), blockedBy: req('target') },
  'dependency.remove': { issue: req('target'), blockedBy: req('target') },
  'comment.create': {
    issue: req('target'),
    content: req('string'),
    parentId: opt('string'),
    internal: opt('boolean'),
  },
  'decision.resolve': {
    inboxItemId: req('string'),
    action: req('string'),
    comment: opt('string'),
  },
  'project.create': {
    name: req('string'),
    description: opt('string'),
    workflowTemplateId: opt('string'),
    visibility: opt('string'),
  },
};

const EXECUTOR_HINT =
  'use executor: {"type": "agent" | "user", "id": "<id>"} or {"type": "none"}';
const ISSUE_HINT =
  'name the issue with issue: "<id or identifier>" (or {"ref": "<ref>"} for an earlier row)';

/** The right field for a guessed one. */
const GUESSES: Readonly<Record<string, string>> = {
  issueId: ISSUE_HINT,
  id: ISSUE_HINT,
  identifier: ISSUE_HINT,
  executorType: EXECUTOR_HINT,
  executorId: EXECUTOR_HINT,
  executorAgentId: EXECUTOR_HINT,
  executorUserId: EXECUTOR_HINT,
  agentId: EXECUTOR_HINT,
  assignee: EXECUTOR_HINT,
  owner: 'use ownerUserId',
  ownerId: 'use ownerUserId',
  labels: 'use labelIds',
  parentId: 'use parent: {"issue": "<id or identifier>"} or {"ref": "<ref>"}',
  parentIssueId:
    'use parent: {"issue": "<id or identifier>"} or {"ref": "<ref>"}',
  patch: 'put the changed fields under set',
  changes: 'put the changed fields under set',
  fields: 'put the changed fields under set',
};

interface Problem {
  readonly field: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function isTarget(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  return (
    (keys[0] === 'issue' || keys[0] === 'ref') &&
    typeof value[keys[0]] === 'string'
  );
}

function isExecutor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'none')
    return Object.keys(value).every((key) => key === 'type' || key === 'id');
  return (
    (value.type === 'user' || value.type === 'agent') &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    Object.keys(value).length === 2
  );
}

function fits(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'nullable':
      return value === null || typeof value === 'string';
    case 'strings':
      return (
        Array.isArray(value) && value.every((item) => typeof item === 'string')
      );
    case 'target':
      return isTarget(value);
    case 'targets':
      return Array.isArray(value) && value.every(isTarget);
    case 'executor':
      return isExecutor(value);
  }
}

const EXPECTED: Readonly<Record<Kind, string>> = {
  string: 'a string',
  number: 'a number',
  boolean: 'true or false',
  nullable: 'a string or null',
  strings: 'an array of strings',
  target: 'an issue id or identifier, {"issue": "..."} or {"ref": "..."}',
  targets: 'an array of {"issue": "..."} or {"ref": "..."}',
  executor: EXECUTOR_HINT.replace('use ', ''),
};

function checkShape(
  shape: Shape,
  values: Record<string, unknown>,
  path: string,
  context: string,
  extraHint?: (key: string) => string | undefined,
): Problem[] {
  const problems: Problem[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = `${path}.${key}`;
    const spec = shape[key];
    if (!spec) {
      const hint = extraHint?.(key) ?? GUESSES[key];
      problems.push({
        field,
        message: `${field} is not a field of ${context}${hint ? `; ${hint}` : ''}.`,
      });
    } else if (value !== undefined && !fits(spec.kind, value))
      problems.push({
        field,
        message: `${field} must be ${EXPECTED[spec.kind]}.`,
      });
  }
  for (const [key, spec] of Object.entries(shape))
    if (spec.required && values[key] === undefined)
      problems.push({
        field: `${path}.${key}`,
        message: `${path}.${key} is required${key === 'issue' ? `; ${ISSUE_HINT}` : ''}.`,
      });
  return problems;
}

function updateProblems(params: Record<string, unknown>): Problem[] {
  const { set, ...rest } = params;
  const problems = checkShape(
    SHAPES['issue.update']!,
    rest,
    'params',
    'issue.update',
    (key) =>
      key in UPDATE_SET
        ? `put ${key} under set, e.g. {"issue": "NP-1", "set": {"${key}": ...}}`
        : undefined,
  );
  if (!isRecord(set))
    problems.push({
      field: 'params.set',
      message:
        'params.set is required: an object with the fields to change, e.g. {"issue": "NP-1", "set": {"priority": "high"}}.',
    });
  else if (Object.keys(set).length === 0)
    problems.push({
      field: 'params.set',
      message: 'params.set names no field to change.',
    });
  else
    problems.push(
      ...checkShape(UPDATE_SET, set, 'params.set', 'issue.update set'),
    );
  return problems;
}

/** 400 `INVALID_PARAMS` unless `op.params` has the shape of its type; unknown types are the caller's to refuse. */
export function validateOpParams(op: PmOperation): void {
  const type = op?.type;
  const shape = SHAPES[type];
  if (!shape) return;
  const params: unknown = op.params;
  const problems: Problem[] = !isRecord(params)
    ? [{ field: 'params', message: 'params must be an object.' }]
    : type === 'issue.update'
      ? updateProblems(params)
      : checkShape(shape, params, 'params', type);
  if (problems.length === 0) return;
  throw invalid(
    'INVALID_PARAMS',
    `${type}: ${problems.map((problem) => problem.message).join(' ')}`,
    {
      errors: problems,
    },
  );
}
