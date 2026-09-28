import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpDetailSkeleton, NpLoadError } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { RouteChildPage } from '@/components/route-child-page';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { fetchWorkflowTemplate } from '../api-iter3.js';
import { npKeys } from '../constants.js';
import {
  WorkflowFlow,
  WorkflowMatrix,
  WorkflowRules,
} from './workflow-views.js';

/**
 * Route `/config/workflows/:workflowId` (§F): one workflow template, read-only, as a covering page — the status line
 * colored by category with its side branches, the transition matrix (people, agents and the system per cell, an
 * "approval" badge where a move waits for one), the rules, and how many projects use it.
 */
export default function WorkflowDetailPage(): ReactElement {
  const { workflowId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const workflow = useQuery({
    queryKey: npKeys.workflow(workflowId),
    queryFn: ({ signal }) => fetchWorkflowTemplate(api, workflowId, signal),
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 2,
  });

  let body: ReactElement;
  if (workflow.isError && !workflow.data) {
    body = (
      <NpLoadError
        title={t('np.workflows.detailLoadFailed')}
        error={workflow.error}
        action={
          <Button
            variant='outline'
            size='sm'
            nativeButton={false}
            render={<Link to='..' relative='path' />}
          >
            {t('np.workflows.backToList')}
          </Button>
        }
      />
    );
  } else if (!workflow.data) {
    body = <NpDetailSkeleton />;
  } else {
    const { definition } = workflow.data;
    body = (
      <>
        <PageHeader
          title={
            <span className='inline-flex items-center gap-3'>
              {workflow.data.name}
              {workflow.data.isDefault ? (
                <NpTag tone='blue'>{t('np.workflows.default')}</NpTag>
              ) : null}
            </span>
          }
          description={t('np.workflows.usedBy', {
            count: workflow.data.projectCount ?? 0,
          })}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('np.workflows.flowTitle')}</CardTitle>
            <CardDescription>
              {t('np.workflows.flowDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WorkflowFlow definition={definition} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('np.workflows.matrix')}</CardTitle>
            <CardDescription>
              {t('np.workflows.matrixDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WorkflowMatrix definition={definition} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('np.workflows.rulesTitle')}</CardTitle>
            <CardDescription>{t('np.workflows.readOnly')}</CardDescription>
          </CardHeader>
          <CardContent>
            <WorkflowRules definition={definition} />
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <RouteChildPage>
      <PageContainer>
        <Breadcrumbs />
        {body}
      </PageContainer>
    </RouteChildPage>
  );
}
