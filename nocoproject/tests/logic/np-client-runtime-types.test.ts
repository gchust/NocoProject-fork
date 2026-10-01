import { describe, expect, it } from 'vitest';

import {
  currentMonthRange,
  usageByRuntime,
} from '../../client/pages/np/runtimes/builtin-usage.js';
import type { AgentListItem, UsageRow } from '../../client/pages/np/types.js';
import {
  capabilitiesForType,
  readRuntimeType,
  runtimeTypeOf,
} from '../../client/pages/np/types-runtime-types.js';

const usage = (key: string, cost: number | null, runs = 1): UsageRow => ({
  key,
  name: key,
  runs,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 0,
  estimatedCost: cost,
});

const agent = (id: string, runtimeId: string | null): AgentListItem => ({
  id,
  name: id,
  runtimeId,
  provider: 'nocobase-ai',
});

describe('runtime types in the browser (NP-219)', () => {
  it('reads a record without a type as computer, and only the two known types from a URL', () => {
    expect(runtimeTypeOf({})).toBe('computer');
    expect(runtimeTypeOf({ runtimeType: 'builtin' })).toBe('builtin');
    expect(runtimeTypeOf({ runtimeType: 'other' })).toBe('computer');
    expect(readRuntimeType('builtin')).toBe('builtin');
    expect(readRuntimeType('cloud')).toBeNull();
    expect(readRuntimeType(null)).toBeNull();
  });

  it('drops the capabilities a built-in agent cannot hold', () => {
    expect(
      capabilitiesForType(
        ['context.read', 'issue.execute', 'repo.read', 'comment.create'],
        'builtin',
      ),
    ).toEqual(['context.read', 'comment.create']);
    expect(capabilitiesForType(['issue.execute'], 'computer')).toEqual([
      'issue.execute',
    ]);
  });

  it('adds each agent’s usage to the runtime it is set to; unpriced rows keep the cost unknown', () => {
    const byRuntime = usageByRuntime(
      [
        usage('a1', 0.5, 2),
        usage('a2', null),
        usage('a3', null),
        usage('gone', 1),
      ],
      [agent('a1', 'b1'), agent('a2', 'b1'), agent('a3', 'b2')],
    );
    expect(byRuntime.get('b1')).toEqual({ runs: 3, tokens: 250, cost: 0.5 });
    expect(byRuntime.get('b2')).toEqual({ runs: 1, tokens: 125, cost: null });
    expect(byRuntime.size).toBe(2);
  });

  it('spans this calendar month through today', () => {
    expect(currentMonthRange(new Date(2026, 9, 17))).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
    });
  });
});
