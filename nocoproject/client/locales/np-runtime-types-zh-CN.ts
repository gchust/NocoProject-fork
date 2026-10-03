import type { NpRuntimeTypesResource } from './np-runtime-types-en-US.js';

/** Chinese wording for computer and built-in agents (NP-219); merged into `np` by `zh-CN.ts`. */
const npRuntimeTypesZhCN: NpRuntimeTypesResource = {
  runtimeType: {
    label: '类型',
    compareTitle: 'Agent 在哪里工作',
    immutableHint: '类型创建后不能修改，要换只能新建',
    cannotLabel: '不能做',
    fitsLabel: '适合',
    all: '全部类型',
    filterLabel: '类型',
    reasons: {
      cannotExecute: '这个 Agent 不能改代码',
      computerOffline: '它所在的电脑离线',
    },
    serviceUnavailable: '模型服务不可用：{{reason}}',
    runs: {
      filter: '按类型筛选运行',
      model: '模型服务',
    },
    computer: {
      name: '电脑 Agent',
      runtimeName: '电脑运行时',
      summary: '在成员的电脑上工作，能改代码、跑命令、开 PR',
      cannot: '电脑离线时不可用',
      fits: '开发任务、长任务',
    },
    builtin: {
      name: '内置 Agent',
      runtimeName: '内置运行时',
      summary: '在系统里工作，能读写系统数据、随时在线',
      cannot: '不能访问代码仓库和终端',
      fits: '问答、分诊、总结、填表、页面内辅助',
    },
  },
  runtimeAdd: {
    label: '添加运行时',
    computer: '接入一台电脑',
    builtin: '使用一个模型服务',
  },
  builtinRuntimes: {
    columns: {
      name: '名称',
      service: '模型服务',
      models: '模型',
      status: '状态',
      lastChecked: '最近检测',
      usage: '本月用量',
      actions: '操作',
    },
    reasons: {
      plugin_missing: 'AI 插件未启用',
      service_removed: '模型服务已删除',
      no_enabled_model: '没有启用的模型',
      check_failed: '连通检测失败',
    },
    notChecked: '未检测',
    usageValue: '{{tokens}} tokens · {{cost}}',
    actions: {
      menu: '{{name}} 的操作',
      check: '测试连接',
      rename: '改名',
      makePublic: '设为公开',
      makePrivate: '设为私有',
      delete: '删除',
    },
    visibility: {
      public: '公开',
      private: '私有',
    },
    checking: '正在测试 {{name}}…',
    checkOk: '{{name}} 连接正常',
    checkFailed: '{{name}} 没有响应',
    renamed: '已改名为 {{name}}',
    madePublic: '{{name}} 已公开',
    madePrivate: '{{name}} 已设为私有',
    deleted: '已删除 {{name}}',
    enabled: '已启用 {{name}}',
    renameTitle: '改名：{{name}}',
    renameLabel: '名称',
    nameRequired: '请输入名称。',
    deleteTitle: '删除 {{name}}？',
    deleteDescription:
      'Agent 将不能再选它。历史运行记录保留，模型服务仍留在 AI 插件里。',
    inUse: '还有 Agent 在用这个运行时：{{names}}。',
    pluginMissingTitle: 'AI 插件未启用',
    pluginMissingDescription:
      '内置运行时使用 NocoBase AI 插件的模型服务，当前应用没有启用这个插件。',
    emptyTitle: '没有内置运行时',
    emptyDescription: '还没有使用 AI 插件的模型服务。',
    loadFailed: '无法加载模型服务',
    pick: {
      title: '使用一个模型服务',
      description: '从 AI 插件的模型服务里选一个。服务的配置仍在 AI 插件里。',
      listLabel: '模型服务',
      inUse: '已在使用',
      enable: '使用',
      models: '{{count}} 个模型：{{names}}',
      noServicesTitle: '没有可用的模型服务',
      noServicesDescription:
        '模型服务在 config.yml 的 ai.llmServices 里声明，模型在 AI 设置里启用。',
      manage: '打开 AI 设置',
      done: '完成',
    },
    errors: {
      INVALID_LLM_SERVICE: '这个模型服务已不存在，或者没有启用的模型。',
      RUNTIME_EXISTS: '这个模型服务已经在使用。',
      BUILTIN_RUNTIME_UNAVAILABLE: 'AI 插件未启用。',
      RUNTIME_IN_USE: '还有 Agent 在用这个运行时：{{names}}。',
    },
  },
  agentType: {
    choose: '先选类型。',
    unavailableNoRuntime: '还没有{{runtimeName}}。',
    capabilityUnavailable: '{{name}} 不能使用',
    noRuntimes: '还没有{{runtimeName}}。',
    sameTypeHint: '只能选同一类型的运行时：{{runtimeName}}。',
    modelDefault: '服务默认',
    modelDefaultNamed: '服务默认（{{model}}）',
    errors: {
      INVALID_RUNTIME_TYPE: '请选择类型。',
      RUNTIME_TYPE_IMMUTABLE: 'Agent 的类型不能修改。',
      RUNTIME_TYPE_MISMATCH: '请选择{{runtimeName}}。',
      CAPABILITY_NOT_FOR_RUNTIME_TYPE:
        '{{name}} 不能拥有这些能力：{{capabilities}}。',
      INVALID_MODEL: '这个模型没有在模型服务里启用。',
      BUILTIN_RUNTIME_UNAVAILABLE: 'AI 插件未启用。',
    },
  },
};

export default npRuntimeTypesZhCN;
