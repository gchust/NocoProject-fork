import { DEFAULT_STATUS_CATALOG, isDormantStatus } from './constants.js';
import type { ExecutorRef, StatusCatalogEntry } from './types.js';

export interface StartConfirmationInput {
  readonly fromStatusKey: string;
  /** The status after the change; omitted when the status does not change. */
  readonly toStatusKey?: string;
  readonly executorBefore: ExecutorRef;
  /** The executor after the change; omitted when the executor does not change. */
  readonly executorAfter?: ExecutorRef;
  readonly catalog?: readonly StatusCatalogEntry[];
}

/**
 * Whether a change would queue a run for an agent, and therefore asks "start now?" first (§G "确认开始").
 *
 * It mirrors the two trigger rules a person's edit can fire (protocol §2): setting an agent as executor while the
 * issue is not dormant (`assign`), and moving an issue with an agent executor out of backlog into a non-terminal
 * status (`statusChange`). Anything that lands in a dormant status queues nothing, so it needs no confirmation.
 */
export function needsStartConfirmation({
  fromStatusKey,
  toStatusKey,
  executorBefore,
  executorAfter,
  catalog = DEFAULT_STATUS_CATALOG,
}: StartConfirmationInput): boolean {
  const executor = executorAfter ?? executorBefore;
  const status = toStatusKey ?? fromStatusKey;
  if (executor.type !== 'agent' || !executor.id) return false;
  if (isDormantStatus(status, catalog)) return false;

  const agentChanged =
    executorAfter !== undefined &&
    !(
      executorBefore.type === 'agent' && executorBefore.id === executorAfter.id
    );
  if (agentChanged) return true;

  return (
    toStatusKey !== undefined &&
    toStatusKey !== fromStatusKey &&
    fromStatusKey === 'backlog'
  );
}
