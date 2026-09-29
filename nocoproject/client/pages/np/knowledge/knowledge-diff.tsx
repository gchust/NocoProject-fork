import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useMemo } from 'react';

import { NpMarkdown } from '@/components/np-markdown';
import { cn } from '@/lib/utils';

import { diffStats, foldDiff, lineDiff } from './text-diff.js';

/** A document's full Markdown, for a new document (no earlier version to diff against) or the "show full text" toggle. */
export function KnowledgeContentBlock({
  content,
}: {
  readonly content: string;
}): ReactElement {
  return (
    <div className='max-h-96 overflow-y-auto rounded-md border bg-muted/40 px-4 py-3'>
      <NpMarkdown content={content} />
    </div>
  );
}

/**
 * Added lines in green, removed lines in red and struck, long unchanged runs folded (§8.1). Reused by the inbox
 * decision content and the knowledge proposal card, and meant for the future version-to-version comparison too.
 */
export function KnowledgeDiff({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}): ReactElement {
  const { t } = useTranslation();
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const blocks = useMemo(() => foldDiff(lines), [lines]);
  const stats = diffStats(lines);
  return (
    <figure className='overflow-hidden rounded-md border'>
      <figcaption className='flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground'>
        <span className='text-success tabular-nums'>+{stats.added}</span>
        <span className='text-destructive tabular-nums'>−{stats.removed}</span>
        <span>{t('np.decision.knowledge.diffCaption')}</span>
      </figcaption>
      <div className='max-h-96 overflow-auto bg-card font-mono text-xs leading-5'>
        {stats.added === 0 && stats.removed === 0 ? (
          <p className='px-3 py-2 font-sans text-muted-foreground'>
            {t('np.decision.knowledge.noChange')}
          </p>
        ) : (
          blocks.map((block) =>
            block.kind === 'gap' ? (
              <div
                key={`gap-${block.n}`}
                className='border-y border-dashed bg-muted/30 px-3 py-0.5 font-sans text-muted-foreground'
              >
                {t('np.decision.knowledge.unchanged', { count: block.count })}
              </div>
            ) : (
              block.lines.map((line) => (
                <div
                  key={line.n}
                  data-diff={line.op}
                  className={cn(
                    'flex gap-2 px-3 whitespace-pre-wrap wrap-anywhere',
                    line.op === 'add' && 'bg-success/10',
                    line.op === 'del' &&
                      'bg-destructive/10 text-muted-foreground line-through',
                  )}
                >
                  <span
                    aria-hidden='true'
                    className={cn(
                      'w-3 shrink-0 select-none',
                      line.op === 'add' && 'text-success',
                      line.op === 'del' && 'text-destructive',
                    )}
                  >
                    {line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '}
                  </span>
                  <span className='sr-only'>
                    {line.op === 'add'
                      ? t('np.decision.knowledge.added')
                      : line.op === 'del'
                        ? t('np.decision.knowledge.removed')
                        : ''}
                  </span>
                  <span className='min-w-0 flex-1'>{line.text || ' '}</span>
                </div>
              ))
            ),
          )
        )}
      </div>
    </figure>
  );
}
