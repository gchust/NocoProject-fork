import { useTranslation } from '@nocobase/i18n/client';
import { ExternalLinkIcon, SendIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { modifierKeyLabel } from '@/components/np-shortcut-keys';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import {
  MergePullRequestDialog,
  type MergeTarget,
} from '../issues/detail/merge-pull-request-dialog.js';
import type { InboxDecisionAction } from '../types-iter3.js';
import {
  actionVariant,
  externalUrl,
  inAppPath,
  mergeTargetOf,
} from './decision-actions.js';
import { useActionLabel } from './use-action-label.js';

/**
 * The buttons of a decision (§E), shared by the inbox's detail pane and the issue page's "Waiting for you" card
 * (nocosolution/NocoSolution 前端规范.md §S15). The hierarchy is fixed: the primary action is the one filled button and comes
 * first, the other requests are outlined, a rejection is red, and navigation (open the issue, reassign) is a plain
 * text button. An action that `needsComment` opens an inline text field first (⌘Enter sends); an external link
 * (`openPr`) opens a new tab. `pendingKey` is the action in flight. NP-85: `confirm: 'prMerge'` opens the merge
 * dialog, which checks GitHub and merges itself; `disabledReason` greys the action out and says why.
 */
export function DecisionActionsBar({
  actions,
  itemTitle,
  itemType,
  pendingKey,
  disabled,
  onRun,
  className,
}: {
  readonly actions: readonly InboxDecisionAction[];
  readonly itemTitle: string;
  /** The inbox item type, for type-specific labels ("Accept" worded differently per decision type). */
  readonly itemType?: string;
  readonly pendingKey: string | null;
  readonly disabled: boolean;
  readonly onRun: (action: InboxDecisionAction, comment: string) => void;
  readonly className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const labelOf = useActionLabel();
  const label = (action: InboxDecisionAction) => labelOf(action, itemType);
  const [commenting, setCommenting] = useState<InboxDecisionAction | null>(
    null,
  );
  const [comment, setComment] = useState('');
  const [merging, setMerging] = useState<MergeTarget | null>(null);
  if (actions.length === 0) return null;

  function send(): void {
    if (!commenting || !comment.trim()) return;
    onRun(commenting, comment);
    setCommenting(null);
    setComment('');
  }

  if (commenting) {
    const name = label(commenting);
    return (
      <div
        className={cn('w-full space-y-2', className)}
        data-commenting={commenting.key}
      >
        <Textarea
          value={comment}
          rows={3}
          autoFocus
          placeholder={t('np.inboxActions.commentPlaceholder')}
          aria-label={t('np.inboxActions.commentFor', {
            action: name,
            title: itemTitle,
          })}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
            if (event.key === 'Escape') {
              event.stopPropagation();
              setCommenting(null);
              setComment('');
            }
          }}
        />
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <span className='mr-auto text-xs text-muted-foreground'>
            <Kbd>{modifierKeyLabel()}</Kbd> <Kbd>Enter</Kbd>
          </span>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              setCommenting(null);
              setComment('');
            }}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            size='sm'
            variant={actionVariant(commenting.kind)}
            disabled={!comment.trim() || disabled}
            onClick={send}
          >
            <SendIcon data-icon='inline-start' />
            {name}
          </Button>
        </div>
      </div>
    );
  }

  const ordered = [...actions].sort((a, b) => actionRank(a) - actionRank(b));
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {ordered.map((action) => {
        const external = externalUrl(action);
        const pending = pendingKey === action.key;
        const mergeTarget = mergeTargetOf(action);
        const reason = action.disabledReason
          ? t(`np.prMerge.blocker.${action.disabledReason}`, {
              defaultValue: action.disabledReason,
            })
          : null;
        return (
          <span key={action.key} className='contents'>
            <Button
              size='sm'
              variant={
                isNavigation(action) && action.kind !== 'primary'
                  ? 'ghost'
                  : actionVariant(action.kind)
              }
              disabled={disabled || pendingKey !== null || reason !== null}
              data-action={action.key}
              onClick={() => {
                if (mergeTarget) setMerging(mergeTarget);
                else if (action.needsComment) setCommenting(action);
                else onRun(action, '');
              }}
            >
              {pending ? <Spinner data-icon='inline-start' /> : null}
              {label(action)}
              {external ? <ExternalLinkIcon data-icon='inline-end' /> : null}
            </Button>
            {reason ? (
              <span
                className='text-xs text-muted-foreground'
                data-testid='np-action-disabled-reason'
              >
                {reason}
              </span>
            ) : null}
          </span>
        );
      })}
      <MergePullRequestDialog
        target={merging}
        onClose={() => setMerging(null)}
      />
    </div>
  );
}

/** Navigation rather than a decision: opening the issue, reassigning there, or a page elsewhere. */
function isNavigation(action: InboxDecisionAction): boolean {
  return (
    action.opensIssue === true ||
    inAppPath(action) !== null ||
    (!action.path && !externalUrl(action))
  );
}

/** Primary first, then the other decisions, then red, then navigation. */
function actionRank(action: InboxDecisionAction): number {
  if (action.kind === 'primary') return 0;
  if (isNavigation(action)) return 3;
  return action.kind === 'danger' ? 2 : 1;
}
