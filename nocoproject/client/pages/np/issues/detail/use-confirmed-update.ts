import { useState } from 'react';

import type { NpStartRequest } from '@/components/np-start-dialog';

import { needsStartConfirmation } from '../../start-confirmation.js';
import type {
  AgentListItem,
  Issue,
  StartDecision,
  StatusCatalogEntry,
  UpdateIssueInput,
} from '../../types.js';

export interface ConfirmedUpdate {
  /** Apply a status or executor change, asking "start now?" first when it would queue an agent run. */
  readonly apply: (changes: UpdateIssueInput) => void;
  readonly startRequest: NpStartRequest | null;
  readonly decide: (decision: StartDecision) => void;
  readonly cancel: () => void;
}

/**
 * Wraps the issue PATCH of the properties panel with the "confirm start" step (§J 2): assigning an agent while the
 * issue is active, or moving an agent-executed issue out of backlog, opens `NpStartDialog`; the answer is sent with
 * the change as `start` and `autoExecuteSubtasks`. Closing the dialog drops the change.
 */
export function useConfirmedUpdate({
  issue,
  catalog,
  agents,
  mutate,
}: {
  readonly issue: Issue;
  readonly catalog: readonly StatusCatalogEntry[];
  readonly agents: readonly AgentListItem[];
  readonly mutate: (changes: UpdateIssueInput) => void;
}): ConfirmedUpdate {
  const [pending, setPending] = useState<{
    readonly changes: UpdateIssueInput;
    readonly request: NpStartRequest;
  } | null>(null);

  function apply(changes: UpdateIssueInput): void {
    const executorBefore = { type: issue.executorType, id: issue.executorId };
    const confirm = needsStartConfirmation({
      fromStatusKey: issue.statusKey,
      toStatusKey: changes.statusKey,
      executorBefore,
      executorAfter: changes.executor,
      catalog,
    });
    if (!confirm) {
      mutate(changes);
      return;
    }
    const agentId = (changes.executor ?? executorBefore).id;
    const agentName =
      agents.find((agent) => agent.id === agentId)?.name ??
      issue.executorName ??
      agentId ??
      '';
    setPending({
      changes,
      request: {
        agentNames: [agentName],
        issueIdentifier: issue.identifier,
        autoExecuteSubtasks: issue.autoExecuteSubtasks ?? false,
      },
    });
  }

  return {
    apply,
    startRequest: pending?.request ?? null,
    decide: (decision) => {
      if (!pending) return;
      setPending(null);
      mutate({ ...pending.changes, ...decision });
    },
    cancel: () => setPending(null),
  };
}
