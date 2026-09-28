/**
 * Workflow definition validation (NP-77 方案 §5): the single source of truth for what a template may contain. Stage 2
 * (Agent proposals, the admin `PUT`) runs it when a proposal is submitted and again when it is accepted, passing the
 * current revision as `base` so existing statuses keep their key and category.
 *
 * Shape (Zod) first, then the cross-field rules:
 * - the 9 built-in statuses are all present, `builtIn: true`, with their fixed category; custom keys match
 *   `^[a-z][a-z0-9_]{1,31}$`, are unique and do not reuse a built-in key; a status of `base` keeps its category;
 * - transitions reference existing statuses (or `*`); a human can leave every status (`* → *` for users, or a user
 *   edge out of each status); agents never write a done / closed status (nor `*` as target);
 * - actions: at most one checklist per status with unique item keys (≤ 20); `runExecutor` / `suggestExecutor` not on
 *   done / closed statuses; instruction templates use only the whitelisted variables; `automation` is reserved and
 *   refused; referenced agents exist and are not archived (`agentExists`).
 *
 * Returns every issue with its path; `assertValidWorkflow` turns them into 400 `INVALID_WORKFLOW` with
 * `details.issues`.
 */
import { z } from 'zod';

import { NpError } from '../shared/errors.js';
import type {
  StatusCategory,
  WorkflowDefinition,
  WorkflowDefinitionV5,
  WorkflowValidationIssue,
} from '../shared/protocol.js';
import {
  APPROVER_ROLES,
  BUILTIN_STATUS_CATEGORIES,
  ERROR_INVALID_WORKFLOW,
  STAGE_INSTRUCTION_VARIABLES,
  WORKFLOW_LIMITS,
} from '../shared/protocol.js';
import { TEMPLATE_VARIABLE } from './instruction.js';

const STATUS_KEY = /^[a-z][a-z0-9_]{1,31}$/u;
const ITEM_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CATEGORIES = ['unstarted', 'started', 'done', 'closed'] as const;
const COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
] as const;
const ACTORS = ['user', 'agent', 'system'] as const;
const AGENT_ID = z.string().trim().min(1).max(32);

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('notifyOwner'),
    message: z.string().max(WORKFLOW_LIMITS.messageLength).optional(),
  }),
  z.strictObject({
    type: z.literal('runExecutor'),
    agentId: AGENT_ID.nullable().optional(),
    instruction: z.string().max(WORKFLOW_LIMITS.instructionLength).optional(),
  }),
  z.strictObject({
    type: z.literal('suggestExecutor'),
    agentId: AGENT_ID,
    reason: z.string().max(WORKFLOW_LIMITS.messageLength).optional(),
  }),
  z.strictObject({
    type: z.literal('checklist'),
    items: z
      .array(
        z.strictObject({
          key: z.string().regex(ITEM_KEY),
          label: z.string().trim().min(1).max(WORKFLOW_LIMITS.labelLength),
          required: z.boolean(),
        }),
      )
      .min(1)
      .max(WORKFLOW_LIMITS.checklistItems),
  }),
  z.strictObject({
    type: z.literal('requirePrMerged'),
    minCount: z.int().min(1).max(WORKFLOW_LIMITS.minCountMax).optional(),
  }),
  z.strictObject({
    type: z.literal('automation'),
    workflowKey: z.string().min(1).max(128),
  }),
]);

const definitionSchema = z.strictObject({
  statuses: z
    .array(
      z.strictObject({
        key: z.string().regex(STATUS_KEY),
        name: z.string().trim().min(1).max(WORKFLOW_LIMITS.nameLength),
        category: z.enum(CATEGORIES),
        color: z.enum(COLORS),
        builtIn: z.boolean(),
        onEnter: z
          .array(actionSchema)
          .max(WORKFLOW_LIMITS.actionsPerStatus)
          .optional(),
      }),
    )
    .min(1)
    .max(WORKFLOW_LIMITS.statuses),
  transitions: z
    .array(
      z.strictObject({
        from: z.string().min(1),
        to: z.string().min(1),
        actors: z.array(z.enum(ACTORS)).min(1),
        approval: z
          .strictObject({ approvers: z.array(z.enum(APPROVER_ROLES)).min(1) })
          .optional(),
      }),
    )
    .max(WORKFLOW_LIMITS.transitions),
  childBatchDoneWakesParentExecutor: z.boolean(),
});

export interface WorkflowValidationOptions {
  /** The revision being replaced: its statuses keep their key and category. */
  readonly base?: WorkflowDefinition | null;
  /** The ids among `ids` that name existing, unarchived agents. */
  readonly agentExists?: (
    ids: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

export type WorkflowValidationResult =
  | { readonly ok: true; readonly definition: WorkflowDefinitionV5 }
  | { readonly ok: false; readonly issues: readonly WorkflowValidationIssue[] };

function zodPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, index) =>
      typeof part === 'number'
        ? `[${part}]`
        : `${index === 0 ? '' : '.'}${String(part)}`,
    )
    .join('');
}

/** Variables of an instruction template that are not whitelisted. */
export function unknownTemplateVariables(template: string): string[] {
  const allowed = new Set<string>(STAGE_INSTRUCTION_VARIABLES);
  const unknown: string[] = [];
  for (const match of template.matchAll(TEMPLATE_VARIABLE)) {
    const name = match[1] ?? '';
    if (!allowed.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

function isTerminalCategory(category: StatusCategory | undefined): boolean {
  return category === 'done' || category === 'closed';
}

function statusRules(
  definition: WorkflowDefinitionV5,
  base: WorkflowDefinition | null | undefined,
  issues: WorkflowValidationIssue[],
): void {
  const seen = new Set<string>();
  definition.statuses.forEach((status, index) => {
    const at = `statuses[${index}]`;
    if (seen.has(status.key))
      issues.push({
        path: `${at}.key`,
        message: `Duplicate key ${status.key}.`,
      });
    seen.add(status.key);
    const builtIn = BUILTIN_STATUS_CATEGORIES[status.key];
    if (builtIn && !status.builtIn)
      issues.push({
        path: `${at}.builtIn`,
        message: `${status.key} is a built-in status and must keep builtIn: true.`,
      });
    if (!builtIn && status.builtIn)
      issues.push({
        path: `${at}.builtIn`,
        message: `Only the built-in statuses may set builtIn: true.`,
      });
    if (builtIn && status.category !== builtIn)
      issues.push({
        path: `${at}.category`,
        message: `The category of ${status.key} is fixed (${builtIn}).`,
      });
    const previous = base?.statuses.find((item) => item.key === status.key);
    if (previous && previous.category !== status.category)
      issues.push({
        path: `${at}.category`,
        message: `The category of an existing status cannot change (${status.key} is ${previous.category}).`,
      });
  });
  for (const key of Object.keys(BUILTIN_STATUS_CATEGORIES))
    if (!seen.has(key))
      issues.push({
        path: 'statuses',
        message: `The built-in status ${key} cannot be removed.`,
      });
}

function transitionRules(
  definition: WorkflowDefinitionV5,
  issues: WorkflowValidationIssue[],
): void {
  const categories = new Map(
    definition.statuses.map((status) => [status.key, status.category]),
  );
  const known = (key: string) => key === '*' || categories.has(key);
  definition.transitions.forEach((transition, index) => {
    const at = `transitions[${index}]`;
    for (const end of ['from', 'to'] as const)
      if (!known(transition[end]))
        issues.push({
          path: `${at}.${end}`,
          message: `Unknown status ${transition[end]}.`,
        });
    if (
      transition.actors.includes('agent') &&
      (transition.to === '*' ||
        isTerminalCategory(categories.get(transition.to)))
    )
      issues.push({
        path: `${at}.actors`,
        message:
          'Agents may not write done or closed statuses (nor use * as the target).',
      });
  });
  const human = definition.transitions.filter((transition) =>
    transition.actors.includes('user'),
  );
  if (
    human.some((transition) => transition.from === '*' && transition.to === '*')
  )
    return;
  for (const key of categories.keys()) {
    const exits = human.some(
      (transition) =>
        (transition.from === '*' || transition.from === key) &&
        transition.to !== key,
    );
    if (!exits)
      issues.push({
        path: 'transitions',
        message: `No transition lets a person leave ${key}.`,
      });
  }
}

function actionRules(
  definition: WorkflowDefinitionV5,
  issues: WorkflowValidationIssue[],
): string[] {
  const agentIds: string[] = [];
  definition.statuses.forEach((status, statusIndex) => {
    let checklists = 0;
    (status.onEnter ?? []).forEach((action, index) => {
      const at = `statuses[${statusIndex}].onEnter[${index}]`;
      switch (action.type) {
        case 'automation':
          issues.push({
            path: `${at}.type`,
            message: 'automation actions are reserved and not supported yet.',
          });
          break;
        case 'checklist': {
          checklists += 1;
          if (checklists > 1)
            issues.push({
              path: at,
              message: 'A status has at most one checklist.',
            });
          const keys = new Set<string>();
          action.items.forEach((item, itemIndex) => {
            if (keys.has(item.key))
              issues.push({
                path: `${at}.items[${itemIndex}].key`,
                message: `Duplicate checklist item ${item.key}.`,
              });
            keys.add(item.key);
          });
          break;
        }
        case 'runExecutor':
        case 'suggestExecutor': {
          if (isTerminalCategory(status.category))
            issues.push({
              path: `${at}.type`,
              message: `${action.type} cannot run when entering a done or closed status.`,
            });
          if (action.agentId) agentIds.push(action.agentId);
          const unknown =
            action.type === 'runExecutor' && action.instruction
              ? unknownTemplateVariables(action.instruction)
              : [];
          if (unknown.length > 0)
            issues.push({
              path: `${at}.instruction`,
              message: `Unknown template variables: ${unknown.join(', ')} (allowed: ${STAGE_INSTRUCTION_VARIABLES.join(', ')}).`,
            });
          break;
        }
        default:
          break;
      }
    });
  });
  return agentIds;
}

async function agentRules(
  definition: WorkflowDefinitionV5,
  agentIds: readonly string[],
  options: WorkflowValidationOptions,
  issues: WorkflowValidationIssue[],
): Promise<void> {
  if (!options.agentExists || agentIds.length === 0) return;
  const existing = await options.agentExists(Array.from(new Set(agentIds)));
  definition.statuses.forEach((status, statusIndex) =>
    (status.onEnter ?? []).forEach((action, index) => {
      if (
        (action.type === 'runExecutor' || action.type === 'suggestExecutor') &&
        action.agentId &&
        !existing.has(action.agentId)
      )
        issues.push({
          path: `statuses[${statusIndex}].onEnter[${index}].agentId`,
          message: `Agent ${action.agentId} does not exist or is archived.`,
        });
    }),
  );
}

export async function validateWorkflowDefinition(
  input: unknown,
  options: WorkflowValidationOptions = {},
): Promise<WorkflowValidationResult> {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: zodPath(issue.path) || '(root)',
        message: issue.message,
      })),
    };
  const definition = parsed.data as WorkflowDefinitionV5;
  const issues: WorkflowValidationIssue[] = [];
  statusRules(definition, options.base, issues);
  transitionRules(definition, issues);
  const agentIds = actionRules(definition, issues);
  await agentRules(definition, agentIds, options, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, definition };
}

/** `validateWorkflowDefinition` or 400 `INVALID_WORKFLOW` with `details.issues`. */
export async function assertValidWorkflow(
  input: unknown,
  options: WorkflowValidationOptions = {},
): Promise<WorkflowDefinitionV5> {
  const result = await validateWorkflowDefinition(input, options);
  if (result.ok) return result.definition;
  const first = result.issues[0];
  throw new NpError(
    'invalid',
    ERROR_INVALID_WORKFLOW,
    `Invalid workflow definition: ${first.path}: ${first.message}${result.issues.length > 1 ? ` (and ${result.issues.length - 1} more)` : ''}`,
    { issues: result.issues },
  );
}
