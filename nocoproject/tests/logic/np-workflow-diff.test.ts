// @vitest-environment node
/**
 * The structured diff of workflow template proposals (NP-77 stage 2, `workflow/workflow.diff.ts`): status add /
 * remove / rename / reorder, transitions merged by `from → to` (actors and approvers), whole-action changes per
 * status, and the separately highlighted `runExecutor.agentId` entries.
 */
import { describe, expect, it } from 'vitest';

import { BUILTIN_DEFINITION } from '../../server/modules/issue/status.ts';
import type { WorkflowDefinitionV5 } from '../../server/modules/shared/protocol.ts';
import { diffWorkflows } from '../../server/modules/workflow/workflow.diff.ts';

const BASE: WorkflowDefinitionV5 = BUILTIN_DEFINITION;

function diff(next: WorkflowDefinitionV5, nextName: string | null = null) {
  return diffWorkflows({
    base: BASE,
    next,
    baseName: '软件开发',
    nextName,
    agentNames: new Map([['a-rev', 'Reviewer']]),
  });
}

describe('diffWorkflows', () => {
  it('reports nothing for an identical definition', () => {
    const result = diff(structuredClone(BASE) as WorkflowDefinitionV5);
    expect(result.empty).toBe(true);
    expect(result.statuses).toEqual({ added: [], removed: [], changed: [] });
    expect(result.runExecutorAgents).toEqual([]);
  });

  it('lists added, removed, renamed and reordered statuses', () => {
    const statuses = BASE.statuses
      .filter((status) => status.key !== 'backlog')
      .map((status) =>
        status.key === 'todo' ? { ...status, name: '待开始' } : status,
      );
    const [first, second, ...rest] = statuses;
    const next: WorkflowDefinitionV5 = {
      ...BASE,
      statuses: [
        second!,
        first!,
        ...rest,
        {
          key: 'code_review',
          name: '代码评审',
          category: 'started',
          color: 'purple',
          builtIn: false,
        },
      ],
    };
    const result = diff(next);
    expect(result.statuses.added).toEqual([
      { key: 'code_review', name: '代码评审', category: 'started' },
    ]);
    expect(result.statuses.removed.map((status) => status.key)).toEqual([
      'backlog',
    ]);
    expect(result.statuses.changed).toEqual([
      { key: 'todo', name: { from: BASE.statuses[1]!.name, to: '待开始' } },
    ]);
    expect(result.statuses.order?.to.slice(0, 2)).toEqual([
      second!.key,
      first!.key,
    ]);
    expect(result.empty).toBe(false);
  });

  it('merges transitions by from → to and reports actor and approval changes', () => {
    const next: WorkflowDefinitionV5 = {
      ...BASE,
      transitions: [
        ...BASE.transitions,
        { from: 'in_review', to: 'done', actors: ['user'] },
        {
          from: 'in_review',
          to: 'done',
          actors: ['system'],
          approval: { approvers: ['owner'] },
        } as WorkflowDefinitionV5['transitions'][number],
        { from: 'blocked', to: 'in_review', actors: ['agent'] },
      ],
    };
    const base: WorkflowDefinitionV5 = {
      ...BASE,
      transitions: [
        ...BASE.transitions,
        { from: 'in_review', to: 'done', actors: ['user'] },
      ],
    };
    const result = diffWorkflows({
      base,
      next,
      baseName: 'T',
      nextName: null,
      agentNames: new Map(),
    });
    expect(result.transitions.added).toEqual([
      { from: 'blocked', to: 'in_review', actors: ['agent'], approvers: null },
    ]);
    expect(result.transitions.changed).toEqual([
      {
        from: 'in_review',
        to: 'done',
        actors: { from: ['user'], to: ['system', 'user'] },
        approvers: { from: null, to: ['owner'] },
      },
    ]);
    expect(result.transitions.removed).toEqual([]);
  });

  it('highlights runExecutor agents and marks the new ones', () => {
    const withReviewer = (instruction: string): WorkflowDefinitionV5 => ({
      ...BASE,
      statuses: BASE.statuses.map((status) =>
        status.key === 'in_review'
          ? {
              ...status,
              onEnter: [
                { type: 'runExecutor', agentId: 'a-rev', instruction },
                { type: 'notifyOwner' },
              ],
            }
          : status,
      ),
    });
    const added = diff(withReviewer('Review {{issue.identifier}}'), '新名字');
    expect(added.runExecutorAgents).toEqual([
      {
        statusKey: 'in_review',
        agentId: 'a-rev',
        agentName: 'Reviewer',
        isNew: true,
      },
    ]);
    expect(added.actions).toEqual([
      {
        statusKey: 'in_review',
        added: [
          {
            type: 'runExecutor',
            agentId: 'a-rev',
            instruction: 'Review {{issue.identifier}}',
          },
          { type: 'notifyOwner' },
        ],
        removed: [],
      },
    ]);
    expect(added.name).toEqual({ from: '软件开发', to: '新名字' });

    const edited = diffWorkflows({
      base: withReviewer('old'),
      next: withReviewer('new'),
      baseName: 'T',
      nextName: 'T',
      agentNames: new Map(),
    });
    expect(edited.runExecutorAgents).toEqual([
      {
        statusKey: 'in_review',
        agentId: 'a-rev',
        agentName: null,
        isNew: false,
      },
    ]);
    expect(edited.actions[0]?.removed).toEqual([
      { type: 'runExecutor', agentId: 'a-rev', instruction: 'old' },
    ]);
    expect(edited.name).toBeUndefined();
  });
});
