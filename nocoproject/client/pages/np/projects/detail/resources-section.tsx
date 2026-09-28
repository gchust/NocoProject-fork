import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WebhookIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';

import {
  removeProjectResource,
  updateProjectResource,
} from '../../api-projects.js';
import type { ProjectResource } from '../../types.js';
import { EditResourceDialog } from './edit-resource.js';
import { reorderResources, sortResources } from './resource-order.js';
import { githubRepoOf } from './resource-url.js';
import { useProjectMutation } from './use-project-mutation.js';
import { GithubWebhookDialog } from './webhook-guide.js';

/**
 * Repositories the project's agents may check out (§F, §I). Adding opens the `resources/new` route dialog; editing
 * opens a dialog, and the arrows reorder (iteration 1 leftovers). GitHub repositories also open the webhook steps
 * (NP-118). Only the project lead and owner/admin see the controls.
 */
export function ResourcesSection({
  projectId,
  resources,
  canEdit,
}: {
  readonly projectId: string;
  readonly resources: readonly ProjectResource[];
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const remove = useProjectMutation(
    (resourceId: string) => removeProjectResource(api, projectId, resourceId),
    t('np.resources.removed'),
  );
  const [editing, setEditing] = useState<ProjectResource | null>(null);
  const [webhookFor, setWebhookFor] = useState<string | null>(null);
  const reorder = useProjectMutation(
    async (move: { readonly from: number; readonly to: number }) => {
      for (const change of reorderResources(resources, move.from, move.to)) {
        await updateProjectResource(api, projectId, change.id, {
          position: change.position,
        });
      }
    },
  );
  const sorted = sortResources(resources);
  const busy = remove.isPending || reorder.isPending;

  return (
    <section className='space-y-3' aria-labelledby='np-resources-heading'>
      <div className='flex items-center justify-between gap-2'>
        <h2 id='np-resources-heading' className='text-sm font-semibold'>
          {t('np.resources.title')}
        </h2>
        {canEdit ? (
          <Button
            variant='ghost'
            size='xs'
            nativeButton={false}
            render={<Link to='resources/new' />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.resources.add')}
          </Button>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.resources.empty')}
        </p>
      ) : (
        <ul className='space-y-2'>
          {sorted.map((resource, index) => (
            <li key={resource.id} className='flex items-start gap-2 text-sm'>
              <GitBranchIcon
                className='mt-0.5 size-4 shrink-0 text-muted-foreground'
                aria-hidden='true'
              />
              <div className='min-w-0 flex-1'>
                <p className='truncate font-medium'>
                  {resource.label || resource.url}
                </p>
                <p className='truncate text-xs text-muted-foreground'>
                  {resource.label ? `${resource.url} · ` : ''}
                  {resource.defaultRef ?? t('np.resources.defaultBranch')}
                </p>
              </div>
              {canEdit ? (
                <div className='flex shrink-0 items-center'>
                  {githubRepoOf(resource.url) ? (
                    <Button
                      variant='ghost'
                      size='icon-xs'
                      aria-label={t('np.repoWebhook.open', {
                        name: resource.label || resource.url,
                      })}
                      onClick={() => setWebhookFor(resource.url)}
                    >
                      <WebhookIcon />
                    </Button>
                  ) : null}
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    disabled={busy || index === 0}
                    aria-label={t('np.resourceEdit.moveUp', {
                      name: resource.label || resource.url,
                    })}
                    onClick={() =>
                      reorder.mutate({ from: index, to: index - 1 })
                    }
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    disabled={busy || index === sorted.length - 1}
                    aria-label={t('np.resourceEdit.moveDown', {
                      name: resource.label || resource.url,
                    })}
                    onClick={() =>
                      reorder.mutate({ from: index, to: index + 1 })
                    }
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    disabled={busy}
                    aria-label={t('np.resourceEdit.edit', {
                      name: resource.label || resource.url,
                    })}
                    onClick={() => setEditing(resource)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    disabled={busy}
                    aria-label={t('np.resources.remove', {
                      name: resource.label || resource.url,
                    })}
                    onClick={() => remove.mutate(resource.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <EditResourceDialog
        projectId={projectId}
        resource={editing}
        onClose={() => setEditing(null)}
      />
      <GithubWebhookDialog
        repoUrl={webhookFor}
        onClose={() => setWebhookFor(null)}
      />
    </section>
  );
}
