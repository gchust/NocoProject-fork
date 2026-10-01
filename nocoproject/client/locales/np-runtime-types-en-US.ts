import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject wording for computer and built-in agents (NP-219, `protocol-runtime-types.md` §1, §9.1). `runtimeType`
 * is the one place the two types are named and described: every other string reaches those names through
 * `RuntimeTypeTag` / `RuntimeTypeName` or a `{{name}}` interpolation, so renaming the types (the AI plugin will be
 * renamed) changes this group only. Merged into `np` by `en-US.ts`; every group is new, so the spread shadows nothing.
 * `np-runtime-types-zh-CN.ts` is checked against the shape derived from this object.
 */
const npRuntimeTypesEnUS = {
  runtimeType: {
    label: 'Type',
    compareTitle: 'Where the agent works',
    immutableHint:
      'The type cannot be changed after the agent is created; to switch, create a new agent.',
    cannotLabel: 'Cannot',
    fitsLabel: 'Good for',
    all: 'All types',
    filterLabel: 'Type',
    computer: {
      name: 'Computer agent',
      runtimeName: 'Computer runtime',
      summary:
        'Works on a member’s computer: changes code, runs commands, opens pull requests',
      cannot: 'Unavailable while the computer is offline',
      fits: 'Development tasks, long tasks',
    },
    builtin: {
      name: 'Built-in agent',
      runtimeName: 'Built-in runtime',
      summary:
        'Works in the system: reads and writes system data, always online',
      cannot: 'Cannot access code repositories or a terminal',
      fits: 'Q&A, triage, summaries, filling forms, in-page help',
    },
  },
  runtimeAdd: {
    label: 'Add runtime',
    computer: 'Connect a computer',
    builtin: 'Use a model service',
  },
  builtinRuntimes: {
    columns: {
      name: 'Name',
      service: 'Model service',
      models: 'Models',
      status: 'Status',
      lastChecked: 'Last checked',
      usage: 'Usage this month',
      actions: 'Actions',
    },
    reasons: {
      plugin_missing: 'AI plugin not enabled',
      service_removed: 'Model service removed',
      no_enabled_model: 'No enabled model',
      check_failed: 'Connection check failed',
    },
    notChecked: 'Not checked',
    usageValue: '{{tokens}} tokens · {{cost}}',
    actions: {
      menu: 'Actions for {{name}}',
      check: 'Test connection',
      rename: 'Rename',
      makePublic: 'Make public',
      makePrivate: 'Make private',
      delete: 'Delete',
    },
    visibility: {
      public: 'Public',
      private: 'Private',
    },
    checking: 'Testing {{name}}…',
    checkOk: '{{name}} is reachable',
    checkFailed: '{{name}} did not respond',
    renamed: 'Renamed to {{name}}',
    madePublic: '{{name}} is public',
    madePrivate: '{{name}} is private',
    deleted: '{{name}} deleted',
    enabled: '{{name}} is in use',
    renameTitle: 'Rename {{name}}',
    renameLabel: 'Name',
    nameRequired: 'Enter a name.',
    deleteTitle: 'Delete {{name}}?',
    deleteDescription:
      'Agents can no longer be set to it. Past runs keep their records, and the model service stays in the AI plugin.',
    inUse: 'Agents still use this runtime: {{names}}.',
    pluginMissingTitle: 'AI plugin not enabled',
    pluginMissingDescription:
      'Built-in runtimes use the model services of the NocoBase AI plugin, which is not enabled in this application.',
    emptyTitle: 'No built-in runtime',
    emptyDescription: 'No model service of the AI plugin is in use yet.',
    loadFailed: 'Unable to load the model services',
    pick: {
      title: 'Use a model service',
      description:
        'Choose one of the AI plugin’s model services. Its settings stay in the AI plugin.',
      listLabel: 'Model services',
      inUse: 'In use',
      enable: 'Use',
      models: '{{count}} models: {{names}}',
      noServicesTitle: 'No model service available',
      noServicesDescription:
        'Model services are declared under ai.llmServices in config.yml; their models are enabled in the AI settings.',
      manage: 'Open AI settings',
      done: 'Done',
    },
    errors: {
      INVALID_LLM_SERVICE:
        'This model service no longer exists or has no enabled model.',
      RUNTIME_EXISTS: 'This model service is already in use.',
      BUILTIN_RUNTIME_UNAVAILABLE: 'The AI plugin is not enabled.',
      RUNTIME_IN_USE: 'Agents still use this runtime: {{names}}.',
    },
  },
  agentType: {
    choose: 'Choose a type to continue.',
    unavailableNoRuntime: 'No {{runtimeName}} is in use yet.',
    capabilityUnavailable: '{{name}}: not available',
    noRuntimes: 'No {{runtimeName}} is in use yet.',
    sameTypeHint: 'Only runtimes of the same type: {{runtimeName}}.',
    modelDefault: 'Service default',
    modelDefaultNamed: 'Service default ({{model}})',
    errors: {
      INVALID_RUNTIME_TYPE: 'Choose a type.',
      RUNTIME_TYPE_IMMUTABLE: 'The type of an agent cannot be changed.',
      RUNTIME_TYPE_MISMATCH: 'Choose a runtime of the type {{runtimeName}}.',
      CAPABILITY_NOT_FOR_RUNTIME_TYPE:
        '{{name}} cannot hold: {{capabilities}}.',
      INVALID_MODEL: 'This model is not enabled in the model service.',
      BUILTIN_RUNTIME_UNAVAILABLE: 'The AI plugin is not enabled.',
    },
  },
};

export default npRuntimeTypesEnUS;
export type NpRuntimeTypesResource = LocaleResource<typeof npRuntimeTypesEnUS>;
