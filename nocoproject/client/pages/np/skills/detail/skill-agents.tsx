import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement } from 'react';
import { Link } from 'react-router';

import { NpActorAvatar } from '@/components/np-actor-avatar';

import type { SkillAgentRef } from '../../types.js';

/** The agents this skill is mounted on (NP-140): avatar and name, each linking to the agent's detail page. */
export function SkillAgents({
  agents,
}: {
  readonly agents: readonly SkillAgentRef[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <section
      className='max-w-2xl space-y-3'
      aria-labelledby='np-skill-agents-heading'
    >
      <h2
        id='np-skill-agents-heading'
        className='font-heading text-sm font-semibold'
      >
        {t('np.skills.mountedAgents')}
        <span className='ml-2 text-xs font-normal text-muted-foreground tabular-nums'>
          {agents.length}
        </span>
      </h2>
      {agents.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.skills.noAgents')}
        </p>
      ) : (
        <ul className='space-y-1'>
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                to={`/agents/${encodeURIComponent(agent.id)}`}
                className='flex items-center gap-2 rounded-md p-1 hover:bg-accent'
              >
                <NpActorAvatar type='agent' name={agent.name} />
                <span className='truncate text-sm font-medium'>
                  {agent.name}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
