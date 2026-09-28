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
 * The settings tabs a viewer sees (§G): owner/admin all five; everyone else the read-only ones — general values, the
 * member list, workflow templates and labels. GitHub is owner/admin only (its endpoints answer 403 to members).
 */
export function visibleConfigTabs(isAdmin: boolean): readonly ConfigTab[] {
  return isAdmin ? CONFIG_TABS : CONFIG_TABS.filter((tab) => tab !== 'github');
}
