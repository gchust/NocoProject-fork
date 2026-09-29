import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject wording for business roles in `/config/members` (NP-153, `server/modules/shared/protocol.roles-server.ts`):
 * the Members and Roles sections, the role page and the server's refusals. Merged into `np` by `en-US.ts`; the group
 * is new, so the spread shadows nothing. `np-roles-zh-CN.ts` is checked against the shape derived from this object.
 */
const npRolesEnUS = {
  roles: {
    tabsLabel: 'Members and roles',
    tabs: {
      members: 'Members',
      roles: 'Roles',
    },
    title: 'Roles',
    description:
      'A role decides which NocoProject pages, settings and business actions its holders have. Holding "Define roles" gives access to anything in NocoProject.',
    new: 'New role',
    newTitle: 'New role',
    name: 'Name',
    loadFailed: 'Unable to load roles',
    notFound: 'This role does not exist.',
    backToList: 'Back to roles',
    breadcrumb: 'Role',
    builtIn: 'Built-in',
    custom: 'Custom',
    platformGrants: 'Platform permissions',
    platformHint:
      'This role also holds platform permissions. They are kept when you save here; assign the role in the platform settings.',
    ownerReadOnly:
      'The owner role holds every NocoProject permission and is not changed here.',
    holders: 'Held by {{count}}',
    none: 'No role',
    pick: 'Add a role',
    rolesFor: 'Roles of {{name}}',
    assigned: 'Roles of {{name}} updated.',
    created: 'Role {{name}} created.',
    saved: 'Role {{name}} saved.',
    deleted: 'Role {{name}} deleted.',
    save: 'Save',
    discard: 'Discard changes',
    actions: 'Actions',
    delete: 'Delete',
    deleteNamed: 'Delete {{name}}',
    deleteTitle: 'Delete the role {{name}}?',
    deleteDescription: 'The role and its permissions are removed.',
    deleteInUse:
      '{{count}} people still hold this role. Change their roles before deleting it.',
    columns: {
      name: 'Name',
      kind: 'Type',
      holders: 'Holders',
    },
    groups: {
      pages: 'Pages',
      settings: 'Settings',
      business: 'Business actions',
    },
    defineRolesNote:
      'Holding "Define roles" gives access to anything in NocoProject: its holder can add any permission to their own role.',
    scopeRelated: 'NocoProject rules',
    scopeAll: 'All records',
    scopeFor: 'Data scope of {{name}}',
    errors: {
      notNpRole:
        'That is not a NocoProject role; platform roles are managed in the platform settings.',
      platformGrants:
        'This role holds platform permissions; assign it in the platform settings.',
      lastOwner: 'The last owner keeps the owner role.',
      inUse: 'Someone still holds this role; change their roles first.',
      builtIn: 'Built-in roles cannot be deleted.',
      notEditable: 'The owner role is not changed here.',
      grantNotAllowed:
        'The role contains a permission NocoProject does not offer.',
      userDisabled: 'A disabled account cannot be given a role.',
      invalidTitle: 'The name must be 1 to 100 characters.',
    },
  },
};

export default npRolesEnUS;
export type NpRolesResource = LocaleResource<typeof npRolesEnUS>;
