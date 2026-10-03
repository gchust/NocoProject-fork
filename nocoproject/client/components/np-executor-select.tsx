import { useTranslation } from '@nocobase/i18n/client';
import { BotIcon, UserIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpOnlineState } from '@/components/np-badges';
import { RuntimeTypeName, RuntimeTypeTag } from '@/components/np-runtime-type';
import { cn } from '@/lib/utils';
import { executorCandidates } from '@/pages/np/api-iter4';
import { isRuntimeOnline } from '@/pages/np/constants';
import type { AgentListItem, ExecutorRef, Member } from '@/pages/np/types';
import {
  RUNTIME_TYPES,
  runtimeTypeOf,
  type RuntimeType,
} from '@/pages/np/types-runtime-types';

export interface NpExecutorSelectProps {
  readonly id?: string;
  readonly value: ExecutorRef;
  readonly agents: readonly AgentListItem[];
  /** Members who may execute an issue themselves (§E `executor_assigned`); omitted, only agents are offered. */
  readonly members?: readonly Member[];
  /** Label for a person currently set as executor when `members` does not list them. */
  readonly userExecutorName?: string | null;
  readonly onChange: (executor: ExecutorRef) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly 'aria-label'?: string;
}

function encode(executor: ExecutorRef): string {
  return executor.type === 'none' || !executor.id
    ? 'none'
    : `${executor.type}:${executor.id}`;
}

function decode(value: string): ExecutorRef {
  const separator = value.indexOf(':');
  if (value === 'none' || separator < 0) return { type: 'none', id: null };
  const type = value.slice(0, separator);
  return {
    type: type === 'user' ? 'user' : 'agent',
    id: value.slice(separator + 1),
  };
}

/**
 * Executor picker: nobody, one of the agents (with its runtime's online state), or a member. An agent the viewer may
 * not invoke (`canInvoke === false`, §H) is listed but disabled; the server refuses the assignment anyway. Project
 * manager agents are left out (iteration 4 §C `MANAGER_NOT_EXECUTOR`) unless one is already the executor.
 *
 * Agents are grouped by type (NP-219) with the type tag beside each name. An agent that cannot execute (no
 * `issue.execute`, which every built-in agent lacks) is listed disabled with the reason in words, so the choice is
 * visibly absent rather than silently missing.
 */
export function NpExecutorSelect({
  id,
  value,
  agents,
  members = [],
  userExecutorName,
  onChange,
  disabled,
  className,
  'aria-label': ariaLabel,
}: NpExecutorSelectProps): ReactElement {
  const { t } = useTranslation();
  const selected = encode(value);
  const offered = executorCandidates(
    agents,
    value.type === 'agent' ? value.id : null,
  );
  const unavailable = agents.filter(
    (agent) =>
      !offered.includes(agent) && agent.kind !== 'manager' && !agent.archivedAt,
  );
  const listed = [...offered, ...unavailable];
  const items = [
    { value: 'none', label: t('np.executor.none') },
    ...listed.map((agent) => ({
      value: `agent:${agent.id}`,
      label: agent.name,
    })),
    ...members.map((member) => ({
      value: `user:${member.userId}`,
      label: member.name,
    })),
  ];
  if (
    value.type === 'user' &&
    value.id &&
    !items.some((item) => item.value === selected)
  ) {
    items.push({
      value: selected,
      label: userExecutorName ?? t('np.executor.person'),
    });
  }
  // An agent that is no longer listed (archived) still displays by id rather than as an empty trigger.
  if (!items.some((item) => item.value === selected)) {
    items.push({ value: selected, label: value.id ?? selected });
  }

  const current = items.find((item) => item.value === selected);

  const renderItem = (item: { value: string; label: string }): ReactElement => {
    const agent = item.value.startsWith('agent:')
      ? listed.find((candidate) => `agent:${candidate.id}` === item.value)
      : undefined;
    const person = item.value.startsWith('user:');
    const cannotExecute = agent !== undefined && !offered.includes(agent);
    const blocked =
      cannotExecute || (agent?.canInvoke === false && item.value !== selected);
    const type: RuntimeType | null = agent ? runtimeTypeOf(agent) : null;
    return (
      <SelectItem
        key={item.value}
        value={item.value}
        disabled={blocked}
        className='[&>span:first-child]:min-w-0 [&>span:first-child]:shrink [&>span:first-child]:grow'
      >
        {agent && type ? (
          <span className='flex min-w-0 flex-1 items-center gap-2'>
            <BotIcon
              className='size-3.5 text-muted-foreground'
              aria-hidden='true'
            />
            <span
              className={cn(
                'truncate',
                (cannotExecute || !isRuntimeOnline(agent)) &&
                  'text-muted-foreground',
              )}
              title={item.label}
            >
              {item.label}
            </span>
            <RuntimeTypeTag type={type} iconOnly className='shrink-0' />
            {cannotExecute ? (
              <span className='shrink-0 text-xs text-muted-foreground'>
                {t('np.runtimeType.reasons.cannotExecute')}
              </span>
            ) : agent.canInvoke === false ? (
              <span className='shrink-0 text-xs text-muted-foreground'>
                {t('np.executor.noAccess')}
              </span>
            ) : (
              <NpOnlineState
                online={isRuntimeOnline(agent)}
                className='ml-auto'
                title={
                  isRuntimeOnline(agent)
                    ? undefined
                    : t('np.runtimeType.reasons.computerOffline')
                }
              />
            )}
          </span>
        ) : person ? (
          <span className='flex min-w-0 items-center gap-2'>
            <UserIcon
              className='size-3.5 text-muted-foreground'
              aria-hidden='true'
            />
            <span className='truncate' title={item.label}>
              {item.label}
            </span>
          </span>
        ) : (
          item.label
        )}
      </SelectItem>
    );
  };

  return (
    <Select
      items={items}
      value={selected}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== selected) onChange(decode(next));
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        title={selected === 'none' ? undefined : current?.label}
        className={cn('w-full', className)}
      >
        {/* The trigger shows who executes as the shared avatar and name, and a muted dash for nobody (nocosolution/guidelines/frontend-standard.md §6). A long name truncates before the chevron; the trigger's title holds it in full. */}
        <SelectValue className='min-w-0'>
          {(current: string) => {
            const item = items.find((entry) => entry.value === current);
            if (!item || current === 'none') {
              return (
                <span className='text-muted-foreground'>
                  —<span className='sr-only'>{t('np.executor.none')}</span>
                </span>
              );
            }
            const agent = current.startsWith('agent:')
              ? listed.find((candidate) => `agent:${candidate.id}` === current)
              : undefined;
            return (
              <span className='flex min-w-0 items-center gap-1.5'>
                <NpActorAvatar
                  type={current.startsWith('agent:') ? 'agent' : 'user'}
                  name={item.label}
                  size='xs'
                  showName
                />
                {current.startsWith('agent:') ? (
                  <RuntimeTypeTag
                    type={runtimeTypeOf(agent ?? {})}
                    iconOnly
                    className='shrink-0'
                  />
                ) : null}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      {/* The popup grows to fit the names (up to 24rem, never past the viewport) instead of clipping them at the trigger's width. */}
      <SelectContent className='w-auto max-w-[min(24rem,var(--available-width))] min-w-(--anchor-width)'>
        {renderItem(items[0])}
        {RUNTIME_TYPES.map((type) => {
          const group = listed.filter((agent) => runtimeTypeOf(agent) === type);
          if (group.length === 0) return null;
          return (
            <SelectGroup key={type}>
              <SelectLabel>
                <RuntimeTypeName type={type} />
              </SelectLabel>
              {group.map((agent) =>
                renderItem(
                  items.find((item) => item.value === `agent:${agent.id}`)!,
                ),
              )}
            </SelectGroup>
          );
        })}
        {items
          .filter(
            (item) =>
              item.value !== 'none' &&
              !listed.some((agent) => `agent:${agent.id}` === item.value),
          )
          .map(renderItem)}
      </SelectContent>
    </Select>
  );
}
