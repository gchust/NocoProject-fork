import { useTranslation } from '@nocobase/i18n/client';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type { KnowledgeProposal } from '../types-iter3.js';
import { KnowledgeProposalCard } from './proposal-card.js';

interface ProposalGroup {
  readonly key: string;
  readonly title: string;
  readonly proposals: readonly KnowledgeProposal[];
}

/** Pending proposals by the document they target (a new document's own slug, in case more than one is proposed). */
function groupByDocument(
  proposals: readonly KnowledgeProposal[],
): ProposalGroup[] {
  const order: string[] = [];
  const titles = new Map<string, string>();
  const members = new Map<string, KnowledgeProposal[]>();
  for (const proposal of proposals) {
    const key = proposal.docId ?? `new:${proposal.slug ?? proposal.id}`;
    let group = members.get(key);
    if (!group) {
      group = [];
      members.set(key, group);
      titles.set(key, proposal.docTitle || proposal.title);
      order.push(key);
    }
    group.push(proposal);
  }
  return order.map((key) => ({
    key,
    title: titles.get(key) ?? '',
    proposals: members.get(key) ?? [],
  }));
}

/**
 * The agents' pending knowledge proposals on `/knowledge` and a project's 知识库 tab (§B, NP-139): folded by default
 * into one line so they do not crowd out the document list, grouped by their target document once opened. Renders
 * nothing when there is nothing pending.
 */
export function KnowledgePendingProposals({
  proposals,
}: {
  readonly proposals: readonly KnowledgeProposal[];
}): ReactElement | null {
  const { t } = useTranslation();
  const groups = useMemo(() => groupByDocument(proposals), [proposals]);
  if (proposals.length === 0) return null;
  return (
    <section className='space-y-3'>
      <Collapsible>
        <CollapsibleTrigger
          render={
            <Button
              variant='ghost'
              size='sm'
              className='-ml-2 gap-1.5 px-2 group/fold'
            />
          }
        >
          <ChevronRightIcon
            data-icon='inline-start'
            className='transition-transform group-data-panel-open/fold:rotate-90'
          />
          <span className='font-heading text-sm font-semibold'>
            {t('np.knowledge.proposals.folded', { count: proposals.length })}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className='mt-3 space-y-4'>
            {groups.map((group) => (
              <div key={group.key} className='space-y-2'>
                {groups.length > 1 ? (
                  <h3 className='text-xs font-medium text-muted-foreground'>
                    {group.title} · {group.proposals.length}
                  </h3>
                ) : null}
                <ul className='grid gap-3 lg:grid-cols-2'>
                  {group.proposals.map((proposal) => (
                    <li key={proposal.id}>
                      <KnowledgeProposalCard proposal={proposal} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
