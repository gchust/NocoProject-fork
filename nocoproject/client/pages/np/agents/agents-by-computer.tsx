import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef, Row } from '@tanstack/react-table';
import { ListIcon, MonitorIcon } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';

import { GroupedDataTable } from '@/components/data-table-grouped';
import { NpListSkeleton } from '@/components/np-states';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { fetchComputers } from '../api-computers.js';
import { fetchRuntimes } from '../api.js';
import { npKeys } from '../constants.js';
import { ComputerGroupHeader } from '../runtimes/computer-group-header.js';
import {
  computerKeyByRuntime,
  groupRuntimesByComputer,
  NO_COMPUTER,
} from '../runtimes/computer-groups.js';
import type { AgentListItem } from '../types.js';
import type { AgentsGrouping } from './agents-grouping.js';

export function AgentsGroupingToggle({
  value,
  onChange,
}: {
  readonly value: AgentsGrouping;
  readonly onChange: (next: AgentsGrouping) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      variant='outline'
      size='sm'
      spacing={0}
      value={[value]}
      onValueChange={(values: string[]) => {
        const [next] = values;
        if (next === 'list' || next === 'computer') onChange(next);
      }}
      aria-label={t('np.agents.grouping.label')}
    >
      <ToggleGroupItem value='list' aria-label={t('np.agents.grouping.list')}>
        <ListIcon />
      </ToggleGroupItem>
      <ToggleGroupItem
        value='computer'
        aria-label={t('np.agents.grouping.computer')}
      >
        <MonitorIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/**
 * NP-188: the agents under the computer their runtime is on (runtimes and credentials share the runtimes page's
 * queries). Agents without a runtime, or on one the viewer cannot see, are grouped last.
 */
export function AgentsByComputer({
  agents,
  columns,
  onRowClick,
}: {
  readonly agents: AgentListItem[];
  readonly columns: ColumnDef<AgentListItem, unknown>[];
  readonly onRowClick: (row: Row<AgentListItem>) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const runtimes = useQuery({
    queryKey: npKeys.runtimes,
    queryFn: () => fetchRuntimes(api),
  });
  const computers = useQuery({
    queryKey: npKeys.computers,
    queryFn: () => fetchComputers(api),
  });
  const computerGroups = useMemo(
    () => groupRuntimesByComputer(runtimes.data ?? [], computers.data),
    [runtimes.data, computers.data],
  );
  const keyByRuntime = useMemo(
    () => computerKeyByRuntime(runtimes.data ?? []),
    [runtimes.data],
  );

  if (!runtimes.data && !runtimes.isError) return <NpListSkeleton rows={4} />;

  const groupOf = (agent: AgentListItem) =>
    (agent.runtimeId ? keyByRuntime.get(agent.runtimeId) : undefined) ??
    NO_COMPUTER;
  const countOf = (id: string) =>
    t('np.computers.group.agents', {
      count: agents.filter((agent) => groupOf(agent) === id).length,
    });
  const groups = [
    ...computerGroups.map((group) => ({
      id: group.id,
      header: <ComputerGroupHeader group={group} count={countOf(group.id)} />,
    })),
    {
      id: NO_COMPUTER,
      header: <ComputerGroupHeader group={null} count={countOf(NO_COMPUTER)} />,
    },
  ];

  return (
    <GroupedDataTable
      columns={columns}
      data={agents}
      getRowId={(agent) => agent.id}
      groups={groups}
      groupOf={groupOf}
      onRowClick={onRowClick}
    />
  );
}
