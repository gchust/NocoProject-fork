import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { NpStartRequest } from '@/components/np-start-dialog';
import { toast } from '@/components/ui/toast';

import { fetchIssueDetail, updateIssue } from '../../api.js';
import { npKeys } from '../../constants.js';
import type {
  IssueListItem,
  StartDecision,
  StatusCatalogEntry,
  UpdateIssueInput,
} from '../../types.js';
import { isRejectedTransition, planBoardMove } from './board-model.js';

interface PendingMove {
  readonly issue: IssueListItem;
  readonly changes: UpdateIssueInput;
  readonly request: NpStartRequest;
}

export interface BoardMove {
  /** Issue id → the status it is being moved to, shown until the server answers. */
  readonly overrides: ReadonlyMap<string, string>;
  /** The move waiting for a "start now?" answer, for `NpStartDialog`. */
  readonly startRequest: NpStartRequest | null;
  readonly drop: (issue: IssueListItem, toStatusKey: string) => void;
  readonly decide: (decision: StartDecision) => void;
  readonly cancel: () => void;
}

/**
 * Drag-to-change-status for the board (§J 1). A drop moves the card at once; the PATCH follows, after a "confirm
 * start" answer when the move would queue an agent run. A rejected transition (403 `TRANSITION_NOT_ALLOWED`, 409)
 * or any other failure snaps the card back with a toast. The override is removed only after the list has been
 * refetched, so an accepted card does not flicker back to its old column in between.
 */
export function useBoardMove(
  catalog: readonly StatusCatalogEntry[],
): BoardMove {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [pending, setPending] = useState<PendingMove | null>(null);

  function setOverride(issueId: string, statusKey: string | null): void {
    setOverrides((current) => {
      const next = new Map(current);
      if (statusKey) next.set(issueId, statusKey);
      else next.delete(issueId);
      return next;
    });
  }

  async function send(
    issue: IssueListItem,
    changes: UpdateIssueInput,
  ): Promise<void> {
    try {
      const revision =
        issue.revision ??
        (await fetchIssueDetail(api, issue.id)).issue.revision;
      const result = await updateIssue(api, issue.id, changes, revision);
      if (result.pendingApproval) {
        toast.add({
          type: 'info',
          title: t('np.approvals.pendingToast'),
          description: t('np.approvals.pendingToastDescription'),
        });
      }
      await queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issue.id) });
    } catch (error: unknown) {
      const status = error instanceof ApiClientError ? error.status : undefined;
      const code = error instanceof ApiClientError ? error.code : undefined;
      toast.add({
        type: 'error',
        priority: 'high',
        title: isRejectedTransition(status, code)
          ? t('np.board.moveRejected', { identifier: issue.identifier })
          : status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    } finally {
      setOverride(issue.id, null);
    }
  }

  function drop(issue: IssueListItem, toStatusKey: string): void {
    const plan = planBoardMove(issue, toStatusKey, catalog);
    if (plan.kind === 'none') return;
    setOverride(issue.id, toStatusKey);
    if (plan.kind === 'confirm') {
      setPending({
        issue,
        changes: plan.changes,
        request: {
          agentNames: [plan.agentName],
          issueIdentifier: issue.identifier,
          autoExecuteSubtasks: issue.autoExecuteSubtasks ?? false,
        },
      });
      return;
    }
    void send(issue, plan.changes);
  }

  function decide(decision: StartDecision): void {
    if (!pending) return;
    const { issue, changes } = pending;
    setPending(null);
    void send(issue, { ...changes, ...decision });
  }

  function cancel(): void {
    if (!pending) return;
    setOverride(pending.issue.id, null);
    setPending(null);
  }

  return {
    overrides,
    startRequest: pending?.request ?? null,
    drop,
    decide,
    cancel,
  };
}
