import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, WorkflowIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, Outlet } from 'react-router';

import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { fetchWorkflowList } from '../api-iter3.js';
import { npKeys } from '../constants.js';
import type { WorkflowListItem } from '../types-iter3.js';
import { ConfigSectionHeading } from './config-section.js';
import { WorkflowFlow } from './workflow-views.js';

/**
 * Tab `/config/workflows` (§F): the workflow templates, read-only — each with its status line, whether it is the
 * default, and how many projects use it. A card opens `:workflowId`, a covering page with the transition matrix and
 * the rules. Editing templates is not part of this iteration.
 */
export default function WorkflowsConfigTab(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const workflows = useQuery({
    queryKey: [...npKeys.workflows, 'v3'],
    queryFn: ({ signal }) => fetchWorkflowList(api, signal),
  });

  let content: ReactElement;
  if (workflows.isError && !workflows.data) {
    content = (
      <NpLoadError
        title={t('np.workflows.loadFailed')}
        error={workflows.error}
        onRetry={() => void workflows.refetch()}
      />
    );
  } else if (!workflows.data) {
    content = <NpListSkeleton rows={3} />;
  } else if (workflows.data.length === 0) {
    content = (
      <NpEmpty icon={<WorkflowIcon />} title={t('np.workflows.empty')} />
    );
  } else {
    content = (
      <ul className='grid gap-3 lg:grid-cols-2'>
        {workflows.data.map((workflow) => (
          <li key={workflow.id}>
            <WorkflowCard workflow={workflow} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <section
        className='space-y-4'
        aria-labelledby='np-config-workflows-heading'
      >
        <ConfigSectionHeading
          id='np-config-workflows-heading'
          title={t('np.workflows.title')}
          description={t('np.workflows.description')}
        />
        {content}
      </section>
      <Outlet />
    </>
  );
}

function WorkflowCard({
  workflow,
}: {
  readonly workflow: WorkflowListItem;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Card className='h-full'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Link
            to={encodeURIComponent(workflow.id)}
            className='hover:underline focus-visible:underline'
          >
            {workflow.name}
          </Link>
          {workflow.isDefault ? (
            <NpTag tone='blue'>{t('np.workflows.default')}</NpTag>
          ) : null}
        </CardTitle>
        <CardDescription>
          {t('np.workflows.usedBy', { count: workflow.projectCount ?? 0 })}
          {' · '}
          {t('np.workflows.statusCount', {
            count: workflow.definition.statuses.length,
          })}
        </CardDescription>
        <CardAction>
          <ChevronRightIcon
            className='size-4 text-muted-foreground'
            aria-hidden='true'
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <WorkflowFlow definition={workflow.definition} compact />
      </CardContent>
    </Card>
  );
}
