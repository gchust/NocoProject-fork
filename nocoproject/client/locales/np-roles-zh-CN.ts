import type { NpRolesResource } from './np-roles-en-US.js';

/** Chinese wording for business roles in `/config/members` (NP-153); merged into `np` by `zh-CN.ts`. */
const npRolesZhCN: NpRolesResource = {
  roles: {
    tabsLabel: '成员与岗位',
    tabs: {
      members: '成员',
      roles: '岗位',
    },
    title: '岗位',
    description:
      '岗位决定持有人能进入哪些 NocoProject 页面、使用哪些设置和业务动作。持有“定义岗位”等于可获得 NocoProject 内的任何权限。',
    new: '新建岗位',
    newTitle: '新建岗位',
    name: '名称',
    loadFailed: '无法加载岗位',
    notFound: '这个岗位不存在。',
    backToList: '返回岗位列表',
    breadcrumb: '岗位',
    builtIn: '内置',
    custom: '自定义',
    platformGrants: '含平台权限',
    platformHint:
      '这个岗位还包含平台权限。在这里保存时会保留它们；分配这个岗位请到平台设置。',
    ownerReadOnly: '所有者岗位拥有 NocoProject 的全部权限，不在这里修改。',
    holders: '{{count}} 人持有',
    none: '无岗位',
    pick: '添加岗位',
    rolesFor: '{{name}} 的岗位',
    assigned: '已更新 {{name}} 的岗位。',
    created: '已新建岗位 {{name}}。',
    saved: '已保存岗位 {{name}}。',
    deleted: '已删除岗位 {{name}}。',
    save: '保存',
    discard: '放弃修改',
    actions: '操作',
    delete: '删除',
    deleteNamed: '删除 {{name}}',
    deleteTitle: '删除岗位 {{name}}？',
    deleteDescription: '岗位及其权限会被删除。',
    deleteInUse: '还有 {{count}} 人持有这个岗位。先修改他们的岗位，再删除。',
    columns: {
      name: '名称',
      kind: '类型',
      holders: '持有人数',
    },
    groups: {
      pages: '页面',
      settings: '设置',
      business: '业务动作',
    },
    defineRolesNote:
      '持有“定义岗位”等于可获得 NocoProject 内的任何权限：持有人可以给自己的岗位加上任意权限。',
    scopeRelated: '领域范围',
    scopeAll: '全部',
    scopeFor: '{{name}} 的数据范围',
    errors: {
      notNpRole: '这不是 NocoProject 岗位；平台权限集请在平台设置中管理。',
      platformGrants: '这个岗位包含平台权限，请在平台设置中分配。',
      lastOwner: '最后一位所有者不能撤销所有者岗位。',
      inUse: '还有人持有这个岗位，请先修改他们的岗位。',
      builtIn: '内置岗位不能删除。',
      notEditable: '所有者岗位不在这里修改。',
      grantNotAllowed: '岗位里有 NocoProject 不提供的权限。',
      userDisabled: '已停用的账号不能分配岗位。',
      invalidTitle: '名称需为 1 到 100 个字符。',
    },
  },
};

export default npRolesZhCN;
