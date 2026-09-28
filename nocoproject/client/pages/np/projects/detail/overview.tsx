import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { NpSectionHeading } from '@/components/np-section';
import { NP_TONE_DOT_CLASS } from '@/components/np-tones';
import { cn } from '@/lib/utils';

import { updateProject } from '../../api-projects.js';
import { statusLabelKey, statusTone } from '../../constants.js';
import type {
  Member,
  ProjectDetail,
  StatusCatalogEntry,
  UpdateProjectInput,
} from '../../types.js';
import { projectNumbers } from '../progress.js';
import { MembersSection } from './members-section.js';
import { ResourcesSection } from './resources-section.js';
import { ProjectDescription, ProjectProperties } from './side-panel.js';
import { useProjectMutation } from './use-project-mutation.js';

/**
 * The 概览 tab of a project (client/pages/np/README.md §3): key numbers, the status distribution, the description
 * (shared with agents as context) on the left; properties, repositories and members as cards on the right.
 */
export function ProjectOverview({
  project,
  catalog,
  workspaceMembers,
  canEdit,
}: {
  readonly project: ProjectDetail;
  readonly catalog: readonly StatusCatalogEntry[];
  readonly workspaceMembers: readonly Member[];
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const update = useProjectMutation((changes: UpdateProjectInput) =>
    updateProject(api, project.id, changes),
  );
  const byStatus = project.issueCounts?.byStatus ?? {};
  const numbers = projectNumbers(byStatus, catalog);
  const stats = [
    { key: 'total', value: numbers.total },
    { key: 'started', value: numbers.started },
    { key: 'review', value: numbers.review },
    { key: 'done', value: numbers.done },
  ] as const;

  return (
    <div className='flex flex-col gap-6 xl:flex-row xl:items-start'>
      <div className='min-w-0 flex-1 space-y-6'>
        <section
          aria-label={t('np.projectPage.numbers')}
          className='grid grid-cols-2 gap-3 md:grid-cols-4'
        >
          {stats.map((stat) => (
            <div
              key={stat.key}
              className='rounded-lg border bg-card px-4 py-3 text-card-foreground'
            >
              <p className='text-xs text-muted-foreground'>
                {t(`np.projectPage.stats.${stat.key}`)}
              </p>
              <p className='mt-1 font-heading text-2xl font-semibold tabular-nums'>
                {stat.value}
              </p>
            </div>
          ))}
        </section>
        <section
          className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
          aria-labelledby='np-project-distribution-heading'
        >
          <NpSectionHeading
            id='np-project-distribution-heading'
            title={t('np.projectPage.distribution')}
          />
          <StatusDistribution byStatus={byStatus} catalog={catalog} />
        </section>
        <section
          className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
          aria-labelledby='np-project-description-heading'
        >
          <NpSectionHeading
            id='np-project-description-heading'
            title={t('np.projects.descriptionLabel')}
          />
          <ProjectDescription
            description={project.description}
            canEdit={canEdit}
            saving={update.isPending}
            onSave={(value) => update.mutate({ description: value })}
          />
        </section>
      </div>
      <aside
        aria-label={t('np.projects.sidePanel')}
        className='space-y-3 xl:w-[20rem] xl:shrink-0'
      >
        <ProjectProperties
          project={project}
          workspaceMembers={workspaceMembers}
          canEdit={canEdit}
        />
        <div className='rounded-lg border bg-card p-4 text-card-foreground'>
          <ResourcesSection
            projectId={project.id}
            resources={project.resources ?? []}
            canEdit={canEdit}
          />
        </div>
        <div className='rounded-lg border bg-card p-4 text-card-foreground'>
          <MembersSection
            projectId={project.id}
            visibility={project.visibility ?? 'everyone'}
            members={project.members ?? []}
            workspaceMembers={workspaceMembers}
            canEdit={canEdit}
          />
        </div>
      </aside>
    </div>
  );
}

/** One stacked bar in workflow order, each status in its own color, with a legend of name and count. */
function StatusDistribution({
  byStatus,
  catalog,
}: {
  readonly byStatus: Readonly<Record<string, number>>;
  readonly catalog: readonly StatusCatalogEntry[];
}): ReactElement {
  const { t } = useTranslation();
  const keys = [
    ...catalog.map((entry) => entry.key),
    ...Object.keys(byStatus).filter(
      (key) => !catalog.some((entry) => entry.key === key),
    ),
  ];
  const rows = keys
    .map((key) => ({ key, count: byStatus[key] ?? 0 }))
    .filter((row) => row.count > 0);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return (
      <p className='text-sm text-muted-foreground'>
        {t('np.projectPage.noIssues')}
      </p>
    );
  }
  return (
    <div className='space-y-3'>
      <div
        className='flex h-2 w-full overflow-hidden rounded-full bg-muted'
        aria-hidden='true'
      >
        {rows.map((row) => (
          <span
            key={row.key}
            className={cn(
              'h-full first:rounded-l-full last:rounded-r-full',
              NP_TONE_DOT_CLASS[statusTone(row.key, catalog)],
            )}
            style={{ width: `${(row.count / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className='flex flex-wrap gap-x-5 gap-y-2 text-sm'>
        {rows.map((row) => (
          <li key={row.key} className='inline-flex items-center gap-1.5'>
            <span
              aria-hidden='true'
              className={cn(
                'size-2 rounded-full',
                NP_TONE_DOT_CLASS[statusTone(row.key, catalog)],
              )}
            />
            <span>{t(statusLabelKey(row.key), { defaultValue: row.key })}</span>
            <span className='text-muted-foreground tabular-nums'>
              {row.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
