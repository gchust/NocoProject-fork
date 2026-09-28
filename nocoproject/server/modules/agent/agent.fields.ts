/**
 * Field validation for agents: the access level and concurrency (moved out of `agent.service.ts` in iteration 4)
 * and the iteration 4 fields `kind` (`coder` | `manager`, docs/phase1/iteration-4-contract.md §C) and
 * `reasoningEffort` (`minimal` … `max`, or null for the tool's default).
 */
import { invalid } from '../shared/errors.js';
import type {
  AgentAccessLevel,
  AgentKind,
  ReasoningEffort,
} from '../shared/protocol.js';
import { AGENT_KINDS, REASONING_EFFORTS } from '../shared/protocol.js';

export function isAccessLevel(value: unknown): value is AgentAccessLevel {
  return (
    value === 'ownerOnly' || value === 'specificUsers' || value === 'everyone'
  );
}

export function validateConcurrency(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 100
  ) {
    throw invalid(
      'INVALID_MAX_CONCURRENT_RUNS',
      'maxConcurrentRuns must be an integer between 1 and 100.',
    );
  }
  return value as number;
}

export function validateAccess(value: unknown): AgentAccessLevel {
  if (!isAccessLevel(value))
    throw invalid(
      'INVALID_ACCESS',
      'access must be ownerOnly, specificUsers or everyone.',
    );
  return value;
}

/** A stored kind (anything unknown reads as `coder`). */
export function agentKindOf(value: unknown): AgentKind {
  return value === 'manager' ? 'manager' : 'coder';
}

/** A stored reasoning effort (anything unknown reads as null). */
export function reasoningEffortOf(value: unknown): ReasoningEffort | null {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

export function validateKind(value: unknown): AgentKind {
  if (!(AGENT_KINDS as readonly unknown[]).includes(value))
    throw invalid('INVALID_KIND', 'kind must be coder or manager.');
  return value as AgentKind;
}

export function validateReasoningEffort(
  value: unknown,
): ReasoningEffort | null {
  if (value === null) return null;
  if (!(REASONING_EFFORTS as readonly unknown[]).includes(value))
    throw invalid(
      'INVALID_REASONING_EFFORT',
      `reasoningEffort must be null or one of ${REASONING_EFFORTS.join(', ')}.`,
    );
  return value as ReasoningEffort;
}
