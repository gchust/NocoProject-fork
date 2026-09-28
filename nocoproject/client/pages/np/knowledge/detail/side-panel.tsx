import { useTranslation } from '@nocobase/i18n/client';
import { HistoryIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpTag } from '@/components/np-tag';
import { cn } from '@/lib/utils';

import { useNpFormatters } from '../../format.js';
import { PropertyRow } from '../../issues/detail/property-fields.js';
import type { KnowledgeDetail } from '../../types-iter3.js';

/**
 * The knowledge document's right-hand column: where it lives, its slug and version, who changed it last, and the
 * version history — newest first, each version a button that shows that version in the main column.
 */
export function KnowledgeSidePanel({
  detail,
  projectName,
  viewing,
  onView,
}: {
  readonly detail: KnowledgeDetail;
  readonly projectName: string;
  readonly viewing: number;
  readonly onView: (version: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const format = useNpFormatters();
  const { doc, versions } = detail;
  return (
    <div className='space-y-6 p-4 md:p-6'>
      <section className='space-y-3' aria-labelledby='np-knowledge-details'>
        <h2 id='np-knowledge-details' className='text-sm font-semibold'>
          {t('np.properties.details')}
        </h2>
        <PropertyRow label={t('np.knowledge.columns.project')}>
          <span className='truncate'>{projectName}</span>
        </PropertyRow>
        <PropertyRow label={t('np.knowledge.columns.slug')}>
          <span className='font-mono text-xs'>{doc.slug}</span>
        </PropertyRow>
        <PropertyRow label={t('np.knowledge.columns.version')}>
          <span className='font-mono text-xs'>v{doc.version}</span>
        </PropertyRow>
        <PropertyRow label={t('np.knowledge.columns.updated')}>
          <span title={format.dateTime(doc.updatedAt)}>
            {format.relative(doc.updatedAt)}
          </span>
        </PropertyRow>
        {doc.updatedByName ? (
          <PropertyRow label={t('np.knowledge.updatedBy')}>
            <NpActorAvatar
              type={doc.updatedByType ?? 'user'}
              name={doc.updatedByName}
              size='xs'
              showName
            />
          </PropertyRow>
        ) : null}
      </section>
      <section className='space-y-3' aria-labelledby='np-knowledge-history'>
        <h2
          id='np-knowledge-history'
          className='flex items-center gap-2 text-sm font-semibold'
        >
          <HistoryIcon className='size-4' aria-hidden='true' />
          {t('np.knowledge.history')}
        </h2>
        {versions.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('np.knowledge.noHistory')}
          </p>
        ) : (
          <ol className='space-y-1'>
            {versions.map((version) => (
              <li key={version.version}>
                <button
                  type='button'
                  aria-current={
                    version.version === viewing ? 'true' : undefined
                  }
                  onClick={() => onView(version.version)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    version.version === viewing && 'bg-muted',
                  )}
                >
                  <span className='flex items-center gap-2'>
                    <span className='font-mono text-xs'>
                      v{version.version}
                    </span>
                    {version.version === doc.version ? (
                      <NpTag tone='green'>{t('np.knowledge.current')}</NpTag>
                    ) : null}
                    {version.proposalId ? (
                      <NpTag tone='violet'>
                        {t('np.knowledge.fromProposal')}
                      </NpTag>
                    ) : null}
                    <time
                      className='ml-auto text-xs text-muted-foreground'
                      dateTime={version.createdAt}
                      title={format.dateTime(version.createdAt)}
                    >
                      {format.relative(version.createdAt)}
                    </time>
                  </span>
                  <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
                    <NpActorAvatar
                      type={version.authorType}
                      name={version.authorName ?? version.authorId}
                      size='xs'
                      showName
                    />
                  </span>
                  {version.note ? (
                    <span className='line-clamp-2 text-xs'>{version.note}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
