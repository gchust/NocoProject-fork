import { useTranslation } from '@nocobase/i18n/client';
import { CheckCircle2Icon, ChevronDownIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpSectionHeading } from '@/components/np-section';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import { DecisionContent } from '../../decision/decision-content.js';
import {
  useDecisionSentence,
  useDecisionTitle,
} from '../../decision/decision-model.js';
import { InboxTypeIcon } from '../../decision/decision-meta.js';
import {
  type DecisionRunner,
  useDecisionRunner,
} from '../../decision/use-decision.js';
import { useNpFormatters } from '../../format.js';
import { DecisionActionsBar } from '../../inbox/decision-actions-bar.js';
import { readInboxActions } from '../../inbox/decision-actions.js';
import { useActionLabel } from '../../inbox/use-action-label.js';
import type { AgentListItem, InboxItem, IssueDetail } from '../../types.js';

interface ResolvedHere {
  readonly item: InboxItem;
  readonly label: string;
}

/**
 * "Waiting for you" on the issue page (nocosolution/guidelines/NocoSolution 前端规范.md §S3). Each open decision the viewer has on this issue is a
 * card: what it is, one sentence, the thing being decided in full, and the actions right under it. Deciding runs
 * through `useDecisionRunner` (the inbox's code): the card shows the action in flight, then folds into a one-line
 * done state ("✓" plus the action label) that can be expanded again for the rest of the visit. Nothing renders when nothing waits.
 */
export function DecisionSection({
  detail,
  agents,
  decisions,
}: {
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  readonly decisions: readonly InboxItem[];
}): ReactElement | null {
  const { t } = useTranslation();
  const actionLabel = useActionLabel();
  const [resolved, setResolved] = useState<readonly ResolvedHere[]>([]);
  const runner = useDecisionRunner({
    onResolved: (item, action) =>
      setResolved((current) =>
        current.some((entry) => entry.item.id === item.id)
          ? current
          : [...current, { item, label: actionLabel(action, item.type) }],
      ),
  });
  const open = decisions.filter(
    (item) =>
      !resolved.some((entry) => entry.item.id === item.id) &&
      (item.resolvedAt === null || runner.pendingKey(item.id) !== null),
  );
  if (open.length === 0 && resolved.length === 0) return null;
  return (
    <section className='space-y-3' aria-labelledby='np-decisions-heading'>
      <NpSectionHeading
        id='np-decisions-heading'
        title={t('np.decision.section.title')}
        count={open.length > 0 ? open.length : undefined}
      />
      {open.map((item) => (
        <DecisionCard
          key={item.id}
          item={item}
          detail={detail}
          agents={agents}
          runner={runner}
        />
      ))}
      {resolved.map((entry) => (
        <ResolvedDecision
          key={entry.item.id}
          entry={entry}
          detail={detail}
          agents={agents}
        />
      ))}
    </section>
  );
}

function DecisionCard({
  item,
  detail,
  agents,
  runner,
}: {
  readonly item: InboxItem;
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  readonly runner: DecisionRunner;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const title = useDecisionTitle();
  const sentence = useDecisionSentence();
  // On the issue page "open the issue" is where you already are.
  const actions = readInboxActions(item).filter((action) => !action.opensIssue);
  const headingId = `np-decision-${item.id}`;
  return (
    <article
      aria-labelledby={headingId}
      data-decision={item.type}
      className='relative overflow-hidden rounded-lg border bg-card text-card-foreground animate-in duration-200 fade-in motion-reduce:animate-none'
    >
      <span
        aria-hidden='true'
        className='absolute inset-y-0 left-0 w-1 bg-attention'
      />
      <div className='space-y-4 py-4 pr-4 pl-5'>
        <header className='flex items-start gap-2.5'>
          <InboxTypeIcon item={item} className='mt-0.5' />
          <div className='min-w-0 flex-1'>
            <h3 id={headingId} className='text-sm font-semibold'>
              {title(item)}
            </h3>
            <p className='text-sm text-muted-foreground wrap-anywhere'>
              {sentence(item)}
            </p>
          </div>
          <time
            className='shrink-0 text-xs text-muted-foreground'
            dateTime={item.updatedAt}
            title={format.dateTime(item.updatedAt)}
          >
            {format.relative(item.updatedAt)}
          </time>
        </header>
        <DecisionContent
          item={item}
          detail={detail}
          agents={agents}
          detailLoading={false}
        />
        <div className='flex flex-wrap items-center gap-3 border-t pt-3'>
          <DecisionActionsBar
            className='min-w-0 flex-1'
            actions={actions}
            itemTitle={item.title}
            itemType={item.type}
            pendingKey={runner.pendingKey(item.id)}
            disabled={runner.busy}
            onRun={(action, comment) => runner.run(item, action, comment)}
          />
          <Link
            to={{
              pathname: '/inbox',
              search: `?item=${encodeURIComponent(item.id)}`,
            }}
            className='ml-auto shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline'
          >
            {t('np.decision.section.viewInInbox')}
          </Link>
        </div>
      </div>
    </article>
  );
}

/** A decision taken on this page, folded to one line; expanding shows what was decided. */
function ResolvedDecision({
  entry,
  detail,
  agents,
}: {
  readonly entry: ResolvedHere;
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
}): ReactElement {
  const { t } = useTranslation();
  const title = useDecisionTitle();
  return (
    <Collapsible className='rounded-lg border bg-card/60 text-card-foreground'>
      <CollapsibleTrigger className='group/resolved flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
        <CheckCircle2Icon className='size-4 text-success' aria-hidden='true' />
        <span className='font-medium'>
          {t('np.decision.section.doneWith', { action: entry.label })}
        </span>
        <span className='truncate text-muted-foreground'>
          {title(entry.item)}
        </span>
        <ChevronDownIcon
          className='ml-auto size-4 text-muted-foreground transition-transform group-data-panel-open/resolved:rotate-180'
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='border-t px-4 py-3'>
          <DecisionContent
            item={entry.item}
            detail={detail}
            agents={agents}
            detailLoading={false}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
