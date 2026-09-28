// @vitest-environment node
/**
 * Workflow definition validation (NP-77 方案 §5), instruction templates and the compiled `stageActions`; no database.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_DEFINITION,
  compileWorkflow,
} from '../../server/modules/issue/status.ts';
import { NpError } from '../../server/modules/shared/errors.ts';
import type {
  StageAction,
  WorkflowDefinitionV5,
  WorkflowStatusDefinitionV5,
} from '../../server/modules/shared/protocol.ts';
import { renderInstruction } from '../../server/modules/workflow/instruction.ts';
import {
  assertValidWorkflow,
  unknownTemplateVariables,
  validateWorkflowDefinition,
} from '../../server/modules/workflow/workflow.validate.ts';

const REVIEW: WorkflowStatusDefinitionV5 = {
  key: 'code_review',
  name: 'Code Review',
  category: 'started',
  color: 'purple',
  builtIn: false,
};

function withStatuses(
  statuses: readonly WorkflowStatusDefinitionV5[],
  transitions = BUILTIN_DEFINITION.transitions,
): WorkflowDefinitionV5 {
  return { ...BUILTIN_DEFINITION, statuses, transitions };
}

function withActions(key: string, onEnter: readonly StageAction[]) {
  return withStatuses(
    BUILTIN_DEFINITION.statuses.map((status) =>
      status.key === key ? { ...status, onEnter } : status,
    ),
  );
}

async function problems(
  input: unknown,
  options: Parameters<typeof validateWorkflowDefinition>[1] = {},
): Promise<string[]> {
  const result = await validateWorkflowDefinition(input, options);
  return result.ok
    ? []
    : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateWorkflowDefinition', () => {
  it('accepts the built-in definition and a custom status with actions', async () => {
    expect(await problems(BUILTIN_DEFINITION)).toEqual([]);
    const definition = withStatuses([
      ...BUILTIN_DEFINITION.statuses,
      {
        ...REVIEW,
        onEnter: [
          { type: 'notifyOwner', message: 'Review' },
          {
            type: 'runExecutor',
            agentId: 'a1',
            instruction: 'Review {{ issue.identifier }} from {{from}}',
          },
          { type: 'suggestExecutor', agentId: 'a2' },
          {
            type: 'checklist',
            items: [{ key: 'tests', label: 'Tests', required: true }],
          },
          { type: 'requirePrMerged', minCount: 1 },
        ],
      },
    ]);
    const result = await validateWorkflowDefinition(definition, {
      agentExists: async (ids) => new Set(ids),
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the 9 built-in statuses with their categories', async () => {
    const without = withStatuses(
      BUILTIN_DEFINITION.statuses.filter((status) => status.key !== 'analysis'),
    );
    expect(await problems(without)).toContain(
      'statuses: The built-in status analysis cannot be removed.',
    );
    const moved = withStatuses(
      BUILTIN_DEFINITION.statuses.map((status) =>
        status.key === 'done'
          ? { ...status, category: 'closed' as const }
          : status,
      ),
    );
    expect((await problems(moved)).join('\n')).toMatch(
      /statuses\[7\]\.category: The category of done is fixed/u,
    );
    const unflagged = withStatuses(
      BUILTIN_DEFINITION.statuses.map((status) =>
        status.key === 'todo' ? { ...status, builtIn: false } : status,
      ),
    );
    expect((await problems(unflagged)).join('\n')).toMatch(
      /must keep builtIn/u,
    );
  });

  it('checks custom keys, duplicates and the category of statuses already in the base', async () => {
    expect(
      (
        await problems(
          withStatuses([
            ...BUILTIN_DEFINITION.statuses,
            { ...REVIEW, key: 'Review' },
          ]),
        )
      ).join('\n'),
    ).toMatch(/statuses\[9\]\.key/u);
    expect(
      await problems(
        withStatuses([...BUILTIN_DEFINITION.statuses, REVIEW, REVIEW]),
      ),
    ).toContain('statuses[10].key: Duplicate key code_review.');
    expect(
      await problems(
        withStatuses([
          ...BUILTIN_DEFINITION.statuses,
          { ...REVIEW, builtIn: true },
        ]),
      ),
    ).toContain(
      'statuses[9].builtIn: Only the built-in statuses may set builtIn: true.',
    );
    const base = withStatuses([...BUILTIN_DEFINITION.statuses, REVIEW]);
    const changed = withStatuses([
      ...BUILTIN_DEFINITION.statuses,
      { ...REVIEW, category: 'unstarted' },
    ]);
    expect((await problems(changed, { base })).join('\n')).toMatch(
      /category of an existing status cannot change \(code_review is started\)/u,
    );
    expect(await problems(changed)).toEqual([]);
  });

  it('checks transitions: known statuses, no agent terminal writes, a human exit from every status', async () => {
    const unknown = withStatuses(BUILTIN_DEFINITION.statuses, [
      ...BUILTIN_DEFINITION.transitions,
      { from: 'todo', to: 'nowhere', actors: ['user'] },
    ]);
    expect(await problems(unknown)).toContain(
      'transitions[14].to: Unknown status nowhere.',
    );
    for (const to of ['done', 'cancelled', '*']) {
      const agentWrites = withStatuses(BUILTIN_DEFINITION.statuses, [
        ...BUILTIN_DEFINITION.transitions,
        { from: 'in_review', to, actors: ['agent'] },
      ]);
      expect((await problems(agentWrites)).join('\n')).toMatch(
        /Agents may not write done or closed statuses/u,
      );
    }
    const locked = withStatuses(
      [...BUILTIN_DEFINITION.statuses, REVIEW],
      BUILTIN_DEFINITION.transitions.filter(
        (transition) => !(transition.from === '*' && transition.to === '*'),
      ),
    );
    expect(await problems(locked)).toContain(
      'transitions: No transition lets a person leave code_review.',
    );
  });

  it('checks actions', async () => {
    expect(
      await problems(
        withActions('in_review', [{ type: 'automation', workflowKey: 'x' }]),
      ),
    ).toContain(
      'statuses[5].onEnter[0].type: automation actions are reserved and not supported yet.',
    );
    expect(
      (await problems(withActions('done', [{ type: 'runExecutor' }]))).join(
        '\n',
      ),
    ).toMatch(/runExecutor cannot run when entering a done or closed status/u);
    expect(
      (
        await problems(
          withActions('cancelled', [
            { type: 'suggestExecutor', agentId: 'a1' },
          ]),
        )
      ).join('\n'),
    ).toMatch(/suggestExecutor cannot run/u);
    expect(
      await problems(
        withActions('in_review', [
          { type: 'runExecutor', instruction: '{{issue.body}} {{ to }}' },
        ]),
      ),
    ).toContain(
      'statuses[5].onEnter[0].instruction: Unknown template variables: issue.body (allowed: issue.identifier, issue.title, from, to, owner.name).',
    );
    const item = { key: 'a', label: 'A', required: true };
    expect(
      await problems(
        withActions('in_review', [{ type: 'checklist', items: [item, item] }]),
      ),
    ).toContain(
      'statuses[5].onEnter[0].items[1].key: Duplicate checklist item a.',
    );
    expect(
      await problems(
        withActions('in_review', [
          { type: 'checklist', items: [item] },
          { type: 'checklist', items: [item] },
        ]),
      ),
    ).toContain('statuses[5].onEnter[1]: A status has at most one checklist.');
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      key: `k${index}`,
      label: 'x',
      required: false,
    }));
    expect(
      (
        await problems(
          withActions('in_review', [{ type: 'checklist', items: tooMany }]),
        )
      ).join('\n'),
    ).toMatch(/statuses\[5\]\.onEnter\[0\]\.items/u);
    expect(
      await problems(
        withActions('in_review', [
          { type: 'suggestExecutor', agentId: 'gone' },
        ]),
        { agentExists: async () => new Set() },
      ),
    ).toContain(
      'statuses[5].onEnter[0].agentId: Agent gone does not exist or is archived.',
    );
    expect(
      (await problems(withActions('in_review', [{ type: 'unknown' } as never])))
        .length,
    ).toBeGreaterThan(0);
  });

  it('refuses unknown fields and non-objects with a path', async () => {
    expect(await problems(null)).toEqual([
      expect.stringMatching(/^\(root\): /u),
    ]);
    expect(
      (await problems({ ...BUILTIN_DEFINITION, extra: true })).join('\n'),
    ).toMatch(/extra/u);
  });

  it('assertValidWorkflow answers 400 INVALID_WORKFLOW with every issue in details', async () => {
    const bad = withActions('done', [
      { type: 'runExecutor' },
      { type: 'automation', workflowKey: 'x' },
    ]);
    const error = await assertValidWorkflow(bad).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NpError);
    expect(error).toMatchObject({ kind: 'invalid', code: 'INVALID_WORKFLOW' });
    expect(
      ((error as NpError).details as { issues: unknown[] }).issues,
    ).toHaveLength(2);
    expect(await assertValidWorkflow(BUILTIN_DEFINITION)).toMatchObject({
      statuses: expect.any(Array),
    });
  });
});

describe('instruction templates and compiled stage actions', () => {
  it('renders the whitelisted variables and leaves others alone', () => {
    expect(
      renderInstruction(
        ' {{issue.identifier}} {{ issue.title }}: {{from}}→{{to}} ({{owner.name}}) {{x}} ',
        {
          'issue.identifier': 'NP-1',
          'issue.title': 'Title',
          from: 'a',
          to: 'b',
          'owner.name': 'Alice',
        },
      ),
    ).toBe('NP-1 Title: a→b (Alice) {{x}}');
    expect(unknownTemplateVariables('{{to}} {{a}} {{ a }} {{b}}')).toEqual([
      'a',
      'b',
    ]);
  });

  it('compiles onEnter per status, dropping entries that are not actions', () => {
    const definition = withActions('in_review', [
      { type: 'notifyOwner' },
      'junk' as never,
      { type: 'nope' } as never,
      { type: 'requirePrMerged' },
    ]);
    const view = compileWorkflow({
      id: 'w',
      name: 'w',
      isDefault: false,
      definition,
      createdAt: '',
      updatedAt: '',
    });
    expect(view.stageActions('in_review').map((action) => action.type)).toEqual(
      ['notifyOwner', 'requirePrMerged'],
    );
    expect(view.stageActions('todo')).toEqual([]);
    expect(view.stageActions('missing')).toEqual([]);
  });
});
