import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject wording added by the design pass (`nocosolution/guidelines/NocoSolution 前端规范.md`): the inbox detail pane, decisions with
 * their content, the live run indicator, the composer tabs and the project page. Merged into `np` by `en-US.ts`
 * after the iteration 3 groups; every group is new, so the spread never shadows an earlier one. `np-design-zh-CN.ts`
 * is checked against the shape derived from this object.
 */
const npDesignEnUS = {
  inboxPane: {
    all: 'All',
    emptyAll: 'Nothing here',
    nothingSelected: 'Select an item',
    back: 'Back to the list',
    openIssue: 'Open issue',
    recent: 'Latest activity',
    keyMove: 'move',
    keyArchive: 'archive',
    keyOpen: 'open',
  },
  decision: {
    titles: {
      review_requested: 'Delivery to accept',
      agent_blocked: 'Agent blocked',
      approval_pending: 'Status change to approve',
      proposal_pending: 'Executor proposals to confirm',
      knowledge_proposal: 'Knowledge change proposed',
      pr_review: 'Pull request ready to merge',
      design_review: 'Design proposal to review',
    },
    actions: {
      review_requested: {
        accept: 'Accept',
        requestChanges: 'Request changes',
      },
      agent_blocked: {
        reply: 'Reply',
        reassign: 'Reassign',
      },
      approval_pending: {
        approve: 'Approve',
        reject: 'Reject',
      },
      proposal_pending: {
        acceptAll: 'Accept all',
      },
      knowledge_proposal: {
        accept: 'Accept',
        reject: 'Reject',
        openDoc: 'Open document',
      },
      pr_review: {
        openPr: 'Open PR',
      },
      design_review: {
        approve: 'Approve for development',
        requestChanges: 'Send back',
      },
    },
    section: {
      title: 'Waiting for you',
      viewInInbox: 'View in inbox',
      doneWith: '{{action}} — done',
    },
    delivery: {
      note: 'delivery note',
      blockedNote: 'why it is blocked',
      noNote: 'The agent left no comment on this issue.',
      runFailed: 'Last run failed: {{reason}}',
      runResult: 'Last run: {{summary}}',
      runDone: 'Last run finished {{when}}.',
    },
    approval: {
      change: 'Change',
      requester: 'Requested by',
      approvers: 'Approvers',
      since: 'Requested',
    },
    knowledge: {
      document: 'Document',
      reason: 'Why',
      summary: 'Summary',
      against: 'Compared with the current version (v{{version}})',
      showDiff: 'Show changes',
      showFull: 'Show full text',
      gone: 'This proposal has already been decided.',
      diffCaption: 'lines changed',
      noChange: 'The proposed text is the same as the current version.',
      unchanged: '{{count}} unchanged lines',
      added: 'Added:',
      removed: 'Removed:',
    },
  },
  issueAdd: {
    label: 'Add',
    subtask: 'Sub-issue',
    dependency: 'Blocker',
    pullRequest: 'Pull request',
    attachment: 'Attachment',
    none: 'none',
  },
  live: {
    working: '{{name}} is working',
    workingFor: '{{name}} is working · {{minutes}} min',
    queued: '{{name}} is queued',
  },
  composer: {
    comment: 'Comment',
    note: 'Note',
    notePlaceholder: 'Write a note…',
    quickSend: 'to send',
    sendNote: 'Add note',
  },
  projectPage: {
    tabs: {
      label: 'Project sections',
      overview: 'Overview',
      issues: 'Issues',
      knowledge: 'Knowledge',
    },
    numbers: 'Key numbers',
    stats: {
      total: 'Issues',
      started: 'In progress',
      review: 'In review',
      done: 'Done',
    },
    distribution: 'By status',
    noIssues: 'No issues yet.',
    documents: 'Documents',
    noDocuments: 'Write down this project’s conventions for agents to read.',
    archived: 'Archived',
    openInList: 'Open in the issue list',
  },
};

export default npDesignEnUS;
export type NpDesignResource = LocaleResource<typeof npDesignEnUS>;
