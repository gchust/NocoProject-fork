import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, ClipboardListIcon, PlayIcon } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';

import { NpMarkdown } from '@/components/np-markdown';
import { NpTag, type NpTone } from '@/components/np-tag';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import {
  discardPmPlan,
  editPmPlan,
  executePmPlan,
  fetchPmConversationPlans,
} from '../../api-pm.js';
import { npKeys } from '../../constants.js';
import type { PmPlan, PmPlanStatus } from '../../types-pm.js';
import {
  canRemove,
  hoursLeft,
  isPlanEditable,
  planEdit,
  type PmPlanEdits,
  type PmRowEdit,
  referencedRefs,
  rowsToConfirm,
  rowViews,
} from './pm-plan-model.js';
import { PmPlanRowItem } from './pm-plan-row.js';
import { usePlanLookup } from './pm-plan-values.js';

const STATUS_TONE: Readonly<Record<PmPlanStatus, NpTone>> = {
  pending: 'amber',
  executing: 'blue',
  executed: 'green',
  failed: 'red',
  discarded: 'slate',
  expired: 'slate',
  superseded: 'slate',
};

const CLOSED: ReadonlySet<PmPlanStatus> = new Set([
  'discarded',
  'expired',
  'superseded',
]);

function conflictTitle(
  t: (key: string) => string,
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return t('np.common.forbidden');
    if (error.code === 'PLAN_EXPIRED')
      return t('np.pmAssistant.plan.expiredError');
    if (error.code === 'PLAN_NOT_PENDING')
      return t('np.pmAssistant.plan.notPending');
    if (error.code === 'REVISION_CONFLICT')
      return t('np.pmAssistant.plan.revisionConflict');
    if (error.code === 'INVALID_REF')
      return t('np.pmAssistant.plan.referenced');
  }
  return t(fallback);
}

/**
 * An operation plan card in the conversation (`protocol-pm-assistant.md` §4, NP-185). The member reads every row,
 * edits or removes rows (saved with the plan's revision), then executes — the server runs every row in one
 * transaction — or discards it. Rows that start an agent's run, close an issue or change an owner are confirmed
 * first. Closed plans (discarded, expired, superseded) fold into one line.
 */
export function PmPlanCard({
  commentId,
  conversationId,
  issueId,
}: {
  readonly commentId: string;
  readonly conversationId: string;
  readonly issueId: string;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const titleId = useId();
  // Every card of the conversation reads the same list; it sits under the conversation's issue, so the issue's
  // realtime refresh refetches it.
  const key = npKeys.pmPlans(issueId);
  const plans = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      fetchPmConversationPlans(api, conversationId, signal),
    retry: false,
  });
  const plan = plans.data?.find(
    (candidate) => candidate.commentId === commentId,
  );

  if (!plan) {
    return plans.isPending ? (
      <Skeleton className='h-24 w-full rounded-lg' />
    ) : (
      <p className='rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground'>
        {t('np.pmAssistant.plan.loadFailed')}
      </p>
    );
  }
  return (
    <PlanBody
      key={`${plan.id}:${plan.revision}:${plan.status}`}
      plan={plan}
      titleId={titleId}
      onPlan={(next) => {
        queryClient.setQueryData<PmPlan[]>(key, (current) =>
          current?.map((item) => (item.id === next.id ? next : item)),
        );
        void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
        void queryClient.invalidateQueries({
          queryKey: [...npKeys.pm, 'conversations'],
        });
      }}
      onReload={() => void queryClient.invalidateQueries({ queryKey: key })}
    />
  );
}

function PlanBody({
  plan,
  titleId,
  onPlan,
  onReload,
}: {
  readonly plan: PmPlan;
  readonly titleId: string;
  readonly onPlan: (plan: PmPlan) => void;
  readonly onReload: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const lookup = usePlanLookup();
  const [edits, setEdits] = useState<PmPlanEdits>(() => new Map());
  const [editing, setEditing] = useState<ReadonlySet<number>>(() => new Set());
  const [confirm, setConfirm] = useState<'execute' | 'discard' | null>(null);
  const closed = CLOSED.has(plan.status);
  const [expanded, setExpanded] = useState(!closed);
  const editable = isPlanEditable(plan);
  const views = rowViews(plan, edits);
  const referenced = referencedRefs(views);
  const dirty = edits.size > 0;
  const toConfirm = rowsToConfirm(views);

  function edit(seq: number, change: PmRowEdit): void {
    setEdits((current) => {
      const next = new Map(current);
      next.set(seq, { ...current.get(seq), ...change });
      return next;
    });
  }

  function failed(fallback: string) {
    return (error: unknown) => {
      toast.add({
        type: 'error',
        priority: 'high',
        title: conflictTitle(t, error, fallback),
      });
      if (
        error instanceof ApiClientError &&
        ['REVISION_CONFLICT', 'PLAN_NOT_PENDING', 'PLAN_EXPIRED'].includes(
          error.code ?? '',
        )
      ) {
        onReload();
      }
    };
  }

  const save = useMutation({
    mutationFn: () => {
      const body = planEdit(plan, edits);
      if (!body) return Promise.resolve(plan);
      return editPmPlan(api, plan.id, body);
    },
    onSuccess: (next) => {
      onPlan(next);
      toast.add({ type: 'success', title: t('np.pmAssistant.plan.saved') });
    },
    onError: failed('np.common.requestFailed'),
  });
  const execute = useMutation({
    mutationFn: () => executePmPlan(api, plan.id, plan.revision),
    onSuccess: (next) => {
      onPlan(next);
      toast.add(
        next.status === 'executed'
          ? { type: 'success', title: t('np.pmAssistant.plan.executed') }
          : {
              type: 'error',
              priority: 'high',
              title: t('np.pmAssistant.plan.executeFailed'),
            },
      );
    },
    onError: failed('np.pmAssistant.plan.executeFailed'),
  });
  const discard = useMutation({
    mutationFn: () => discardPmPlan(api, plan.id),
    onSuccess: (next) => {
      onPlan(next);
      toast.add({ type: 'success', title: t('np.pmAssistant.plan.discarded') });
    },
    onError: failed('np.common.requestFailed'),
  });
  const busy = save.isPending || execute.isPending || discard.isPending;
  const hours = hoursLeft(plan.expiresAt);

  return (
    <section
      role='group'
      aria-labelledby={titleId}
      className={cn(
        'space-y-3 rounded-lg border bg-card p-3',
        plan.status === 'pending' && 'border-attention/60',
      )}
      data-testid='np-pm-plan'
      data-plan-status={plan.status}
    >
      <header className='flex min-w-0 items-start gap-2'>
        <ClipboardListIcon
          className='mt-0.5 size-4 shrink-0 text-muted-foreground'
          aria-hidden='true'
        />
        <div className='min-w-0 flex-1'>
          <h3 id={titleId} className='text-sm font-semibold wrap-anywhere'>
            {plan.title}
          </h3>
          <p className='mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
            <NpTag tone={STATUS_TONE[plan.status]}>
              {t(`np.pmAssistant.plan.status.${plan.status}`)}
            </NpTag>
            <span>
              {t('np.pmAssistant.plan.rowCount', { count: plan.rows.length })}
            </span>
            {plan.status === 'pending' && hours > 0 ? (
              <span>{t('np.pmAssistant.plan.expiresIn', { hours })}</span>
            ) : null}
          </p>
        </div>
        {closed ? (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t('np.pmAssistant.plan.collapse')
                : t('np.pmAssistant.plan.expand')
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRightIcon
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
          </Button>
        ) : null}
      </header>
      {expanded ? (
        <>
          {plan.summary ? (
            <div className='text-sm'>
              <NpMarkdown content={plan.summary} />
            </div>
          ) : null}
          <ol
            className='space-y-1.5'
            aria-label={t('np.pmAssistant.plan.rows')}
          >
            {views.map((view) => (
              <PmPlanRowItem
                key={view.row.seq}
                view={view}
                views={views}
                lookup={lookup}
                editable={editable && !busy}
                editing={editing.has(view.row.seq)}
                removable={canRemove(view, referenced)}
                onEdit={(on) =>
                  setEditing((current) => {
                    const next = new Set(current);
                    if (on) next.add(view.row.seq);
                    else next.delete(view.row.seq);
                    return next;
                  })
                }
                onChange={(params) => edit(view.row.seq, { params })}
                onRemove={() => edit(view.row.seq, { removed: true })}
                onRestore={() => edit(view.row.seq, { removed: false })}
              />
            ))}
          </ol>
          {editable ? (
            <footer className='flex flex-wrap items-center gap-2'>
              {dirty ? (
                <>
                  <Button
                    size='sm'
                    disabled={busy}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? (
                      <Spinner data-icon='inline-start' />
                    ) : null}
                    {t('np.pmAssistant.plan.save')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={busy}
                    onClick={() => {
                      setEdits(new Map());
                      setEditing(new Set());
                    }}
                  >
                    {t('np.pmAssistant.plan.revert')}
                  </Button>
                  <span className='text-xs text-muted-foreground'>
                    {t('np.pmAssistant.plan.unsaved')}
                  </span>
                </>
              ) : (
                <Button
                  size='sm'
                  disabled={busy || !plan.executable}
                  onClick={() =>
                    toConfirm.length > 0
                      ? setConfirm('execute')
                      : execute.mutate()
                  }
                >
                  {execute.isPending ? (
                    <Spinner data-icon='inline-start' />
                  ) : (
                    <PlayIcon data-icon='inline-start' />
                  )}
                  {t('np.pmAssistant.plan.execute')}
                </Button>
              )}
              <Button
                size='sm'
                variant='outline'
                className='ml-auto'
                disabled={busy}
                onClick={() => setConfirm('discard')}
              >
                {t('np.pmAssistant.plan.discard')}
              </Button>
            </footer>
          ) : null}
        </>
      ) : null}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'discard'
                ? t('np.pmAssistant.plan.discardTitle')
                : t('np.pmAssistant.plan.executeTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'discard'
                ? t('np.pmAssistant.plan.discardDescription')
                : t('np.pmAssistant.plan.executeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === 'execute' ? (
            <ul className='list-disc space-y-1 pl-5 text-sm'>
              {toConfirm.map((view) => (
                <li key={view.row.seq}>
                  {t(`np.pmAssistant.plan.types.${view.row.type}`)}
                  {' · '}
                  {view.row.flags
                    .map((flag) => t(`np.pmAssistant.plan.flag.${flag}`))
                    .join(t('np.comment.nameSeparator'))}
                </li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === 'discard' ? 'destructive' : 'default'}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === 'discard') discard.mutate();
                else execute.mutate();
              }}
            >
              {confirm === 'discard'
                ? t('np.pmAssistant.plan.discard')
                : t('np.pmAssistant.plan.execute')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
