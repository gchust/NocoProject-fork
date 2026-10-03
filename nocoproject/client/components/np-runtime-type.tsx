import { MonitorIcon, ZapIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpTag, type NpTone } from '@/components/np-tag';
import { useRuntimeTypeCopy } from '@/components/np-runtime-type-copy';
import { cn } from '@/lib/utils';

import type { RuntimeType } from '@/pages/np/types-runtime-types';

/**
 * Computer and built-in agents (NP-219, `protocol-runtime-types.md` §1): the one place a type gets its tag, icon and
 * names. The wording lives in the `np.runtimeType` locale group; pages show a type only through these components or
 * `useRuntimeTypeCopy`, never by writing the names themselves. Computer is slate with a monitor, built-in blue with a
 * bolt (amber stays reserved for "needs you").
 */
const TYPE_STYLE: Readonly<
  Record<RuntimeType, { readonly tone: NpTone; readonly icon: LucideIcon }>
> = {
  computer: { tone: 'slate', icon: MonitorIcon },
  builtin: { tone: 'blue', icon: ZapIcon },
};

export function RuntimeTypeIcon({
  type,
  className,
}: {
  readonly type: RuntimeType;
  readonly className?: string;
}): ReactElement {
  const Icon = TYPE_STYLE[type].icon;
  return <Icon aria-hidden='true' className={className} />;
}

/**
 * The type tag: icon and name, the one-line description on hover. `iconOnly` keeps the icon (tight spots such as
 * board cards) and moves the name into the accessible label and the tooltip. `of='runtime'` names the runtime type.
 */
export function RuntimeTypeTag({
  type,
  of = 'agent',
  iconOnly = false,
  className,
}: {
  readonly type: RuntimeType;
  readonly of?: 'agent' | 'runtime';
  readonly iconOnly?: boolean;
  readonly className?: string;
}): ReactElement {
  const copy = useRuntimeTypeCopy()(type);
  const name = of === 'runtime' ? copy.runtimeName : copy.name;
  return (
    <NpTag
      tone={TYPE_STYLE[type].tone}
      icon={<RuntimeTypeIcon type={type} />}
      data-runtime-type={type}
      title={iconOnly ? `${name}: ${copy.summary}` : copy.summary}
      aria-label={iconOnly ? name : undefined}
      role={iconOnly ? 'img' : undefined}
      className={cn(iconOnly && 'px-1', className)}
    >
      {iconOnly ? null : name}
    </NpTag>
  );
}

/** A type's name as plain text ("Computer agent"), e.g. a group heading. */
export function RuntimeTypeName({
  type,
  of = 'agent',
}: {
  readonly type: RuntimeType;
  readonly of?: 'agent' | 'runtime';
}): ReactElement {
  const copy = useRuntimeTypeCopy()(type);
  return <>{of === 'runtime' ? copy.runtimeName : copy.name}</>;
}
