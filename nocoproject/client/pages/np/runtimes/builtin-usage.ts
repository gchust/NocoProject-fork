import { toDateOnly } from '../format.js';
import type { AgentListItem, UsageRow } from '../types.js';
import { totalTokens } from '../usage-model.js';

/**
 * "Usage this month" of the built-in runtimes (NP-219 §9.1). `GET /np/usage` has no per-runtime grouping, so the
 * page asks for this month's built-in runs grouped by agent and adds each agent's row to the runtime it is set to.
 * An agent moved to another runtime during the month counts toward its current one; a deleted agent's runs drop out.
 */

export interface RuntimeUsage {
  readonly runs: number;
  readonly tokens: number;
  /** Null when none of the runs had a price. */
  readonly cost: number | null;
}

/** The first day of this calendar month through today, as `YYYY-MM-DD`. */
export function currentMonthRange(today: Date = new Date()): {
  readonly from: string;
  readonly to: string;
} {
  return {
    from: toDateOnly(new Date(today.getFullYear(), today.getMonth(), 1)) ?? '',
    to: toDateOnly(today) ?? '',
  };
}

export function usageByRuntime(
  rows: readonly UsageRow[],
  agents: readonly AgentListItem[],
): Map<string, RuntimeUsage> {
  const runtimeOf = new Map(
    agents.map((agent) => [agent.id, agent.runtimeId] as const),
  );
  const result = new Map<string, RuntimeUsage>();
  for (const row of rows) {
    const runtimeId = runtimeOf.get(row.key);
    if (!runtimeId) continue;
    const current = result.get(runtimeId);
    const cost =
      row.estimatedCost === null
        ? (current?.cost ?? null)
        : (current?.cost ?? 0) + row.estimatedCost;
    result.set(runtimeId, {
      runs: (current?.runs ?? 0) + row.runs,
      tokens: (current?.tokens ?? 0) + totalTokens(row),
      cost,
    });
  }
  return result;
}
