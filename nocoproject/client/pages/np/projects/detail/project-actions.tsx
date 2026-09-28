import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontalIcon, Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router';

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';

import { deleteProject } from '../../api-projects.js';
import { npKeys } from '../../constants.js';
import type { ProjectDetail } from '../../types.js';

/**
 * The project's "more" menu (iteration 1 leftover "删除项目"): owner/admin delete the project after a confirmation.
 * Deleting keeps the issues and moves them out of the project (protocol §6). Nobody else gets the menu.
 */
export function ProjectActions({
  project,
  canDelete,
}: {
  readonly project: ProjectDetail;
  readonly canDelete: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteProject(api, project.id),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.projectMore.deleted', { name: project.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.projects });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void navigate('/projects');
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      }),
  });
  if (!canDelete) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant='outline'
              size='icon-sm'
              aria-label={t('np.projectMore.label')}
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant='destructive'
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon />
              {t('np.projectMore.delete')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.projectMore.deleteTitle', { name: project.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.projectMore.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false);
                remove.mutate();
              }}
            >
              {t('np.projectMore.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
