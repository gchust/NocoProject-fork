export type ConfigTab =
  'general' | 'members' | 'workflows' | 'labels' | 'github';

export const CONFIG_TABS: readonly ConfigTab[] = [
  'general',
  'members',
  'workflows',
  'labels',
  'github',
];

/**
 * The settings tabs a viewer sees (§G; NP-117): the ones whose settings item they may read (`config-access.ts`). By
 * default members read general values, the member list, workflow templates and labels; owner/admin also GitHub.
 */
export function visibleConfigTabs(
  readable: Readonly<Record<ConfigTab, boolean>>,
): readonly ConfigTab[] {
  return CONFIG_TABS.filter((tab) => readable[tab]);
}
