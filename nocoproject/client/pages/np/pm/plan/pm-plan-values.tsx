import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';

import { fetchLabels, fetchMembers } from '../../api-collab.js';
import { fetchAgents, fetchProjects } from '../../api.js';
import { npKeys, statusLabelKey } from '../../constants.js';
import type { AgentListItem, Member } from '../../types.js';
import type { Label } from '../../types-collab.js';
import { toExecutorRef } from './pm-plan-model.js';

/**
 * What a plan card needs to show ids as names (agents, members, labels, projects) and to offer them in its editors;
 * the same cached lists the rest of the pages read.
 */
export interface PlanLookup {
  readonly agents: readonly AgentListItem[];
  readonly members: readonly Member[];
  readonly labels: readonly Label[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

export function usePlanLookup(): PlanLookup {
  const api = useApiClient();
  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const labels = useQuery({
    queryKey: npKeys.labels,
    queryFn: () => fetchLabels(api),
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  return {
    agents: agents.data ?? [],
    members: members.data ?? [],
    labels: labels.data ?? [],
    projects: projects.data ?? [],
  };
}

/** Formats a plan field's value the way the pages show it: names for ids, localized priorities and processes. */
export function usePlanValueText(
  lookup: PlanLookup,
): (field: string, value: unknown) => string {
  const { t } = useTranslation();
  const person = (id: unknown): string =>
    lookup.members.find((member) => member.userId === id)?.name ??
    (typeof id === 'string' ? id : '—');
  return (field, value) => {
    if (value === undefined || value === null || value === '') return '—';
    switch (field) {
      case 'priority':
        return t(`np.priority.${String(value)}`);
      case 'process':
        return t(`np.process.choices.${String(value)}`);
      case 'ownerUserId':
        return person(value);
      case 'executor': {
        const ref = toExecutorRef(value);
        if (ref.type === 'none') return t('np.executor.none');
        return ref.type === 'agent'
          ? (lookup.agents.find((agent) => agent.id === ref.id)?.name ??
              ref.id ??
              '—')
          : person(ref.id);
      }
      case 'labelIds':
        return Array.isArray(value)
          ? value
              .map(
                (id) =>
                  lookup.labels.find((label) => label.id === id)?.name ??
                  String(id),
              )
              .join(', ') || '—'
          : '—';
      case 'projectId':
        return (
          lookup.projects.find((project) => project.id === value)?.name ??
          String(value)
        );
      case 'statusKey':
        return t(statusLabelKey(String(value)), {
          defaultValue: String(value),
        });
      case 'visibility':
        return t(`np.pmAssistant.plan.visibility.${String(value)}`, {
          defaultValue: String(value),
        });
      default:
        return typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
    }
  };
}
