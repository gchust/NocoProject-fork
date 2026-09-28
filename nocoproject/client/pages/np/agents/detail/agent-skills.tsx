import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SaveIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';

import { NpMultiSelect } from '@/components/np-multi-select';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { fetchSkills } from '../../api-agent-extras.js';
import { updateAgent } from '../../api.js';
import { npKeys } from '../../constants.js';
import type { AgentListItem } from '../../types.js';

/**
 * Skills mounted on the agent (iteration 2 §H): the daemon writes each one into the work directory before every run
 * and the brief lists them. Saved on its own, as `PATCH /np/agents/:id { skillIds }`.
 */
export function AgentSkillsSection({
  agent,
  canEdit,
}: {
  readonly agent: AgentListItem;
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const skills = useQuery({
    queryKey: npKeys.skills,
    queryFn: ({ signal }) => fetchSkills(api, signal),
  });
  const initial = agent.skillIds ?? [];
  const [selected, setSelected] = useState<string[]>([...initial]);
  const dirty =
    selected.length !== initial.length ||
    selected.some((skillId) => !initial.includes(skillId));

  const save = useMutation({
    mutationFn: () => updateAgent(api, agent.id, { skillIds: selected }),
    onSuccess: () =>
      toast.add({ type: 'success', title: t('np.agentSkills.saved') }),
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.agents }),
  });

  return (
    <section
      className='max-w-2xl space-y-3'
      aria-labelledby='np-agent-skills-heading'
    >
      <div className='space-y-1'>
        <h2
          id='np-agent-skills-heading'
          className='font-heading text-sm font-semibold'
        >
          {t('np.agentSkills.title')}
        </h2>
        <p className='text-sm text-muted-foreground'>
          {t('np.agentSkills.description')}{' '}
          <Link
            to='/skills'
            className='font-medium text-primary underline-offset-4 hover:underline'
          >
            {t('np.agentSkills.manage')}
          </Link>
        </p>
      </div>
      <NpMultiSelect
        id='np-agent-skills'
        aria-label={t('np.agentSkills.title')}
        options={(skills.data ?? []).map((skill) => ({
          value: skill.id,
          label: skill.name,
        }))}
        value={selected}
        disabled={!canEdit || save.isPending}
        placeholder={t('np.agentSkills.placeholder')}
        emptyText={t('np.agentSkills.empty')}
        onChange={setSelected}
      />
      {canEdit ? (
        <div className='flex justify-end'>
          <Button
            variant='outline'
            size='sm'
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SaveIcon data-icon='inline-start' />
            )}
            {t('np.agentSkills.save')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
