import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject Phase 1 iteration 3 wording (`docs/phase1/iteration-3-contract.md` §B–§H), merged into `np` by
 * `en-US.ts` after the iteration 2 groups. Every group here is new, so the spread never shadows an earlier group;
 * `np-iter3-zh-CN.ts` is checked against the shape derived from this object.
 */
const npIter3EnUS = {
  actor: {
    user: 'Person',
    agent: 'Agent',
    system: 'System',
  },
  states: {
    notFound: 'It does not exist or has been deleted.',
  },
  feedback: {
    dependencyAdded: 'Blocker added',
    dependencyRemoved: 'Blocker removed',
  },
  pagination: {
    loadMore: 'Load more',
    shown: 'Showing {{count}}',
    countMore: '{{count}}+',
  },
  search: {
    title: 'Search issues',
    description: 'Search issues by title or identifier.',
    placeholder: 'Search by title or identifier…',
    hint: 'Type to search issues.',
    noResults: 'No matching issues.',
    issues: 'Issues',
    trigger: 'Search',
  },
  myIssues: {
    title: 'My issues',
    description:
      'Issues you are accountable for and issues you are working on yourself.',
    tabsLabel: 'My issues views',
    tabs: {
      owned: 'I own',
      executing: 'I execute',
    },
    empty: {
      owned: 'You do not own any issues',
      executing: 'You are not executing any issues',
    },
    emptyDescription:
      'Issues assigned to you show up here. Create one or pick one up from the issue list.',
  },
  reports: {
    title: 'Reports',
    description:
      'Acceptance metrics for working with agents, and the tokens and cost of their runs.',
    tabsLabel: 'Report views',
    tabs: {
      metrics: 'Metrics',
      usage: 'Usage',
    },
  },
  metrics: {
    loadFailed: 'Unable to load metrics',
    allOk: 'All targets met',
    warnSummary: 'Off target: {{count}}',
    thresholdHint: 'Targets are set in Settings → General.',
    definition: 'How {{name}} is calculated',
    status: {
      ok: 'On target',
      warn: 'Off target',
      na: 'No data',
    },
    target: {
      min: 'Target ≥ {{value}}',
      max: 'Target ≤ {{value}}',
    },
    groups: {
      adoption: {
        title: 'Adoption',
        description: 'Whether the team actually works here.',
      },
      aiShare: {
        title: 'AI share',
        description: 'How much of the delivered work agents executed.',
      },
      trust: {
        title: 'Trust',
        description:
          'How often agent suggestions and deliveries are accepted — the basis for turning suggestions into automation.',
      },
      reliability: {
        title: 'Reliability',
        description:
          'Runs, failures and how fast work is claimed. No run may be lost.',
      },
      cost: {
        title: 'Cost',
        description:
          'Tokens and estimated cost, per delivered issue and per agent.',
      },
      humanLoad: {
        title: 'Human load',
        description:
          'How many decisions people are asked for and how fast they answer.',
      },
    },
    items: {
      activeWeeks: 'Active weeks',
      activeDays: 'Active days',
      issuesCreated: 'Issues created',
      activeMembers: 'Active members',
      share: 'Delivered by agents',
      deliveredByAgent: 'Delivered by agents (issues)',
      deliveredTotal: 'Delivered in total',
      proposalAcceptRate: 'Proposal accept rate',
      reviewPassRate: 'Review pass rate',
      approvalApproveRate: 'Approval rate',
      reworkRate: 'Rework rate',
      runs: 'Runs',
      failedRuns: 'Failed runs',
      lostRuns: 'Lost runs',
      claimLatencyP50Ms: 'Claim latency (p50)',
      claimLatencyP95Ms: 'Claim latency (p95)',
      runDurationP50Ms: 'Run duration (p50)',
      estimatedCost: 'Estimated cost',
      costPerDeliveredIssue: 'Cost per delivered issue',
      inputTokens: 'Input tokens',
      outputTokens: 'Output tokens',
      decisionsCreated: 'Decisions asked',
      decisionsResolved: 'Decisions resolved',
      openDecisions: 'Open decisions',
      decisionResolveP50Ms: 'Time to decide (p50)',
    },
    tables: {
      failures: 'Failures by reason',
      byAgent: 'Cost by agent',
      byType: 'Decisions by type',
      reason: 'Reason',
      agent: 'Agent',
      type: 'Type',
      count: 'Count',
      cost: 'Cost',
      empty: 'Nothing in this period.',
    },
  },
  config: {
    title: 'Settings',
    description:
      'Workspace settings, members, workflow templates, labels and the GitHub connection.',
    readOnlyDescription:
      'Workspace settings. Owners and admins make changes; you can read them.',
    tabsLabel: 'Settings sections',
    tabs: {
      general: 'General',
      members: 'Members',
      workflows: 'Workflow templates',
      labels: 'Labels',
      github: 'GitHub',
    },
    adminOnlyTitle: 'Owners and admins only',
    thresholds: {
      title: 'Metric targets',
      description:
        'The targets the acceptance metrics are held to on the Reports page.',
      invalid:
        'Enter numbers of 0 or more; the rates are percentages up to 100.',
      fields: {
        aiShare: 'Delivered by agents, at least',
        proposalAcceptRate: 'Proposal accept rate, at least',
        claimLatencyP50Ms: 'Claim latency (p50), at most',
        lostRuns: 'Lost runs, at most',
        decisionResolveHours: 'Time to decide (p50), at most',
      },
    },
    labels: {
      title: 'Labels',
      description:
        'Labels group issues across projects. Deleting a label removes it from its issues.',
      readOnly:
        'Labels group issues across projects. Owners and admins manage them.',
      loadFailed: 'Unable to load labels',
      emptyTitle: 'No labels yet',
      emptyDescription: 'Create a label to group issues.',
      newName: 'New label name',
      newColor: 'New label color',
      namePlaceholder: 'Label name',
      create: 'Create label',
      created: 'Label "{{name}}" created',
      renamed: 'Label renamed to "{{name}}"',
      recolored: 'Color of "{{name}}" changed',
      deleted: 'Label "{{name}}" deleted',
      duplicate: 'A label with this name already exists.',
      renameLabel: 'Rename {{name}}',
      deleteLabel: 'Delete {{name}}',
      deleteTitle: 'Delete the label "{{name}}"?',
      deleteDescription:
        'It is removed from every issue that has it. This cannot be undone.',
      delete: 'Delete label',
      columns: {
        name: 'Name',
        color: 'Color',
        actions: 'Actions',
      },
    },
  },
  workflows: {
    title: 'Workflow templates',
    description:
      'The statuses an issue moves through and who may move it. Read-only in this version.',
    breadcrumb: 'Workflow template',
    loadFailed: 'Unable to load workflow templates',
    detailLoadFailed: 'Unable to load this workflow template',
    backToList: 'Back to templates',
    empty: 'No workflow templates',
    default: 'Default',
    usedBy: 'Projects using it: {{count}}',
    statusCount: 'Statuses: {{count}}',
    flowTitle: 'Status flow',
    flowDescription:
      'The main line from backlog to done, colored by category, with the side branches beneath.',
    mainLine: 'Main status line',
    sideBranches: 'Side branches',
    matrix: 'Transition matrix',
    matrixDescription:
      'Rows are the current status, columns the next one. Each cell shows who may make the move.',
    fromTo: 'From ↓ / to →',
    approval: 'Approval',
    rulesTitle: 'Rules',
    readOnly: 'Templates cannot be edited yet.',
    any: 'any status',
    listSeparator: ', ',
    rule: '{{actors}} can move {{from}} → {{to}}',
    approvalBy: 'Needs approval by {{roles}}',
    childBatchDoneOn:
      'When a stage of sub-issues is done, the parent issue’s agent is woken up.',
    childBatchDoneOff:
      'Finishing a stage of sub-issues does not wake the parent issue’s agent.',
    actors: {
      user: 'People',
      agent: 'Agents',
      system: 'System',
    },
    approvers: {
      owner: 'the issue owner',
      projectLead: 'the project lead',
      admin: 'an admin',
    },
    categories: {
      unstarted: 'Not started',
      started: 'In progress',
      done: 'Done',
      closed: 'Closed',
    },
  },
  githubSecrets: {
    show: 'Show value',
    hide: 'Hide value',
    generatedHint:
      'Copy this secret now (for example into gh webhook forward --secret). Once saved it is never shown again.',
  },
  inboxActions: {
    accept: 'Accept',
    requestChanges: 'Request changes',
    open: 'Open',
    reply: 'Reply',
    reassign: 'Reassign',
    acceptAll: 'Accept all',
    approve: 'Approve',
    reject: 'Reject',
    openDoc: 'Open document',
    openPr: 'Open PR',
    merge: 'Merge',
    commentPlaceholder: 'Write a comment…',
    commentFor: '{{action}}: {{title}}',
    done: '{{action}}: {{title}}',
    conflict: 'This decision was already made.',
  },
  knowledge: {
    title: 'Knowledge',
    description:
      'Conventions, pitfalls and decisions agents read before they work. People write them; agents propose changes.',
    breadcrumb: 'Document',
    new: 'New document',
    loadFailed: 'Unable to load the knowledge base',
    detailLoadFailed: 'Unable to load this document',
    backToList: 'Back to knowledge',
    emptyTitle: 'No documents yet',
    emptyDescription:
      'Write down what agents should know: coding conventions, how to test, decisions made.',
    noResults: 'No documents match.',
    searchPlaceholder: 'Search documents…',
    searchLabel: 'Search documents',
    workspace: 'Workspace',
    workspaceOnly: 'Workspace documents',
    archived: 'Archived',
    archive: 'Archive',
    unarchive: 'Restore',
    archiveTitle: 'Archive "{{title}}"?',
    archiveDescription: 'Agents stop reading it. You can restore it later.',
    archivedToast: '"{{title}}" archived',
    unarchivedToast: '"{{title}}" restored',
    edit: 'Edit',
    emptyContent: 'This document is empty.',
    sidePanel: 'Document details',
    updatedBy: 'Changed by',
    history: 'Version history',
    noHistory: 'No earlier versions.',
    current: 'Current',
    fromProposal: 'From proposal',
    viewingVersion: 'You are viewing version {{version}}.',
    backToCurrent: 'Back to current',
    note: 'Change note',
    notePlaceholder: 'What changed, for the version history (optional)',
    saveHint: 'Press ⌘Enter to save.',
    saved: 'Saved as version {{version}}',
    conflictTitle: 'Someone else saved this document',
    conflictDescription: 'Your changes were not saved. Your draft is kept.',
    conflictBanner:
      'A newer version was saved after version {{version}}, which you started from. Copy what you need from your draft, then load the latest version.',
    loadLatest: 'Load latest version',
    columns: {
      title: 'Title',
      project: 'Project',
      slug: 'Slug',
      version: 'Version',
      updated: 'Updated',
    },
    form: {
      title: 'New document',
      description:
        'A Markdown document agents can read. Workspace documents apply to every project.',
      project: 'Project',
      projectHint:
        'Workspace documents are for everyone and only owners and admins write them.',
      titleLabel: 'Title',
      titleRequired: 'Enter a title.',
      slug: 'Slug',
      slugHint:
        'How agents refer to the document; lowercase words joined by hyphens.',
      slugTaken: 'A document with this slug already exists here.',
      summary: 'Summary',
      summaryHint:
        'One or two sentences agents see in the index (up to 300 characters).',
      content: 'Content',
      contentPlaceholder: 'Write in Markdown…',
      create: 'Create document',
      created: '"{{title}}" created',
    },
    proposals: {
      title: 'Proposals waiting for you ({{count}})',
      folded: '{{count}} proposals await a decision',
      cardLabel: 'Proposal: {{title}}',
      proposesChange: 'proposes a change to',
      proposesNew: 'proposes a new document',
      new: 'New',
      versionRange: 'Based on v{{base}} · currently v{{current}}',
      stale: 'Outdated',
      staleTitle: 'This proposal is based on an older version',
      staleDescription:
        'The document is now at version {{current}}; this proposal was based on version {{base}}. Accepting replaces the current content with the proposed text.',
      acceptAnyway: 'Accept anyway',
      showContent: 'Show proposed text',
      accept: 'Accept',
      reject: 'Reject',
      confirmReject: 'Reject proposal',
      comment: 'Note for the agent',
      commentPlaceholder: 'Why not? (optional)',
      accepted: 'Proposal "{{title}}" accepted',
      rejected: 'Proposal "{{title}}" rejected',
      alreadyDecided: 'This proposal was already decided.',
    },
  },
};

export type NpIter3Resource = LocaleResource<typeof npIter3EnUS>;

export default npIter3EnUS;
