import { useTranslation } from '@nocobase/i18n/client';

import type { RuntimeType } from '@/pages/np/types-runtime-types';

/**
 * The names and one-line descriptions of the agent types (NP-219, `protocol-runtime-types.md` §1), read from the
 * `np.runtimeType` locale group — the one place they are worded. Other strings interpolate them (`{{name}}`).
 */
export interface RuntimeTypeCopy {
  /** "Computer agent" / "Built-in agent". */
  readonly name: string;
  /** "Computer runtime" / "Built-in runtime". */
  readonly runtimeName: string;
  readonly summary: string;
  readonly cannot: string;
  readonly fits: string;
}

/** The names and the one-line descriptions of a type, for interpolating into other strings. */
export function useRuntimeTypeCopy(): (type: RuntimeType) => RuntimeTypeCopy {
  const { t } = useTranslation();
  return (type) => ({
    name: t(`np.runtimeType.${type}.name`),
    runtimeName: t(`np.runtimeType.${type}.runtimeName`),
    summary: t(`np.runtimeType.${type}.summary`),
    cannot: t(`np.runtimeType.${type}.cannot`),
    fits: t(`np.runtimeType.${type}.fits`),
  });
}
