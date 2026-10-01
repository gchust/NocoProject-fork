import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { toast } from '@/components/ui/toast';

import { refineIntakeDrafts } from '../api-intake.js';
import { type DraftRow, draftInputs, rowsFromDrafts } from './intake-model.js';

/** The server's limit on one instruction (`MAX_REFINE_INSTRUCTION`). */
export const REFINE_INSTRUCTION_MAX = 2000;

export interface Revision {
  readonly key: number;
  readonly instruction: string;
  /** The table before this revision; undo puts it back. */
  readonly before: readonly DraftRow[];
  readonly undone: boolean;
}

export interface IntakeRefineState {
  readonly instruction: string;
  readonly setInstruction: (value: string) => void;
  readonly submit: () => void;
  readonly pending: boolean;
  readonly revisions: readonly Revision[];
  /** Restores the table before the latest revision still in effect. */
  readonly undo: () => void;
}

/**
 * NP-120: revise the drafts by one instruction. The current rows (unsaved edits included) go to the server, which has
 * AI rewrite them and stores the result; the table then shows it. Each revision keeps the rows it replaced, so the
 * latest one still in effect can be undone, and then the one before it. Undo only changes the table: "Save" or
 * "Create" writes it back, like any manual edit. The list lives as long as the editor. `storeRows` receives the rows
 * the server stored; `setRows` the rows an undo puts back, which only the table holds.
 */
export function useIntakeRefine(
  batchId: string,
  rows: readonly DraftRow[],
  setRows: (rows: DraftRow[]) => void,
  storeRows: (rows: DraftRow[]) => void,
): IntakeRefineState {
  const { t } = useTranslation();
  const api = useApiClient();
  const [instruction, setInstruction] = useState('');
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);

  const refine = useMutation({
    mutationFn: (request: {
      instruction: string;
      before: readonly DraftRow[];
    }) =>
      refineIntakeDrafts(
        api,
        batchId,
        request.instruction,
        draftInputs(request.before),
      ),
    onSuccess: (drafts, request) => {
      storeRows(rowsFromDrafts(drafts));
      setRevisions((current) => [
        ...current,
        {
          key: current.length + 1,
          instruction: request.instruction,
          before: request.before,
          undone: false,
        },
      ]);
      setInstruction('');
      toast.add({ type: 'success', title: t('np.intakeRefine.revised') });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: errorTitle(t, error),
      }),
  });

  const latest = [...revisions].reverse().find((item) => !item.undone);
  return {
    instruction,
    setInstruction,
    pending: refine.isPending,
    revisions,
    submit: () => {
      const text = instruction.trim();
      if (!text || text.length > REFINE_INSTRUCTION_MAX || refine.isPending)
        return;
      refine.mutate({ instruction: text, before: rows });
    },
    undo: () => {
      if (!latest) return;
      setRows([...latest.before]);
      setRevisions((current) =>
        current.map((item) =>
          item.key === latest.key ? { ...item, undone: true } : item,
        ),
      );
      toast.add({ type: 'success', title: t('np.intakeRefine.undone') });
    },
  };
}

function errorTitle(t: (key: string) => string, error: unknown): string {
  if (!(error instanceof ApiClientError)) return t('np.intakeRefine.failed');
  if (error.code === 'AI_TIMEOUT' || error.status === 504)
    return t('np.intakeRefine.timeout');
  if (error.code === 'AI_UNAVAILABLE') return t('np.intakeRefine.unavailable');
  if (error.status === 403) return t('np.common.forbidden');
  if (error.status === 409) return t('np.intake.stateChanged');
  return t('np.intakeRefine.failed');
}
