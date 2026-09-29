import { useCan } from '@nocobase/app-plugin-authorization/client';

import type { ConfigTab } from './config-model.js';

/**
 * NP-117: each `/config` tab is a settings item of the built-in authorization (`server/modules/shared/access.ts`),
 * granted through the permission sets `np-member` (read), `np-admin` and `np-owner` (read and change). These only hide
 * tabs and controls; every endpoint checks the same item itself.
 */
export const CONFIG_SETTINGS: Readonly<Record<ConfigTab, string>> = {
  general: 'nocoproject.general',
  members: 'nocoproject.members',
  workflows: 'nocoproject.workflows',
  labels: 'nocoproject.labels',
  github: 'nocoproject.github',
};

export function settingsCheck(
  tab: ConfigTab,
  action: 'read' | 'update' | 'invite' | 'assign' | 'define-roles',
): {
  readonly resource: { readonly type: 'settings'; readonly id: string };
  readonly action: string;
} {
  return { resource: { type: 'settings', id: CONFIG_SETTINGS[tab] }, action };
}

export interface ConfigAccess {
  /** Which tabs the viewer may open. */
  readonly readable: Readonly<Record<ConfigTab, boolean>>;
  /** Whether the viewer may change anything in the settings. */
  readonly editsAny: boolean;
  readonly isPending: boolean;
}

/** The viewer's access to the `/config` tabs; everything is false while the checks are pending or failed. */
export function useConfigAccess(): ConfigAccess {
  const general = useCan(settingsCheck('general', 'read'));
  const members = useCan(settingsCheck('members', 'read'));
  const workflows = useCan(settingsCheck('workflows', 'read'));
  const labels = useCan(settingsCheck('labels', 'read'));
  const github = useCan(settingsCheck('github', 'read'));
  const editGeneral = useCan(settingsCheck('general', 'update'));
  const editLabels = useCan(settingsCheck('labels', 'update'));
  return {
    readable: {
      general: general.can,
      members: members.can,
      workflows: workflows.can,
      labels: labels.can,
      github: github.can,
    },
    editsAny: editGeneral.can || editLabels.can,
    isPending:
      general.isPending ||
      members.isPending ||
      workflows.isPending ||
      labels.isPending ||
      github.isPending,
  };
}
