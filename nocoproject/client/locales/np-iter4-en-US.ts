import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject wording added in Phase 1 iteration 4 (`docs/phase1/iteration-4-contract.md`): the unified "new issue"
 * dialog, the design-first process, the project manager page and settings, and the agent form (moved here from
 * `en-US.ts` when it gained the kind and reasoning effort). Merged into `np` by `en-US.ts` after the design groups;
 * every group is new there, so the spread never shadows an earlier one. `np-iter4-zh-CN.ts` is checked against the
 * shape derived from this object.
 */
const npIter4EnUS = {
  agentForm: {
    title: 'New agent',
    description: 'An agent runs one coding tool on one of your runtimes.',
    name: 'Name',
    nameRequired: 'Enter a name.',
    descriptionLabel: 'Description',
    instructions: 'Instructions',
    instructionsPlaceholder:
      'Who this agent is and how it should work. Included in every run.',
    instructionsRequired: 'Enter the instructions.',
    runtime: 'Runtime',
    runtimePlaceholder: 'Choose a runtime',
    runtimeRequired: 'Choose a runtime.',
    noRuntimes: 'No runtime is connected yet.',
    provider: 'Provider',
    providerPlaceholder: 'From the runtime',
    model: 'Model',
    maxConcurrentRuns: 'Max concurrent runs',
    maxInvalid: 'Enter a whole number from 1 to 100.',
    created: 'Agent {{name}} created',
    kind: 'Kind',
    kindHint:
      'A project manager answers questions and writes retrospectives; it never executes issues.',
    kinds: {
      coder: 'Coding',
      manager: 'Project manager',
    },
    reasoningEffort: 'Reasoning effort',
    reasoningDefault: 'Default',
    efforts: {
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      max: 'Max',
    },
    managerNotExecutor: 'A project manager cannot execute issues.',
  },
  newIssue: {
    title: 'New issue',
    tabsLabel: 'How to create',
    tabs: {
      ai: 'AI draft',
      manual: 'Manual',
    },
    requirementLabel: 'Requirements',
    requirementPlaceholder:
      'Describe what is needed, or paste a requirements list or meeting notes',
    parse: 'Draft issues',
    parsing: 'Drafting…',
  },
  process: {
    label: 'Process',
    choices: {
      auto: 'Automatic',
      direct: 'Straight to development',
      design_first: 'Design first',
    },
    hint: 'Design first: the agent analyses and submits a proposal; development starts once you approve it.',
    badge: 'Design first',
    locked:
      'The process can only change while the issue is in backlog or todo.',
  },
  proposal: {
    tag: 'Proposal',
    missing: 'The proposal text is not on this issue yet.',
    summary: 'Proposal summary',
  },
  retrospective: {
    tag: 'Retrospective',
  },
  pm: {
    title: 'Project manager',
    description:
      'Answers questions about progress, issues and metrics across projects, and writes a retrospective when an issue is done.',
    emptyTitle: 'No project manager yet',
    emptyDescription:
      'The project manager is an agent of the project manager kind, chosen in the workspace settings.',
    openSettings: 'Open settings',
    loadFailed: 'Unable to open the conversation with the project manager',
    placeholder: 'Ask the project manager…',
  },
  prMerge: {
    merge: 'Merge',
    mergeFor: 'Merge {{pr}}',
    title: 'Merge {{pr}}?',
    titleGeneric: 'Merge the pull request?',
    checking: 'Checking the pull request on GitHub…',
    method: 'Squash and merge into {{base}}.',
    commitTitle: 'Commit title',
    after: 'Afterwards',
    statusAfter: 'The issue moves to {{status}}.',
    keep: {
      setting: 'The issue status stays as it is (workspace setting).',
      otherPrs: 'The issue status stays: other linked PRs are not merged yet.',
      optedOut: 'The issue status stays: auto-complete is off for this PR.',
      terminal: 'The issue is already closed.',
    },
    confirm: 'Squash and merge',
    merged: 'Merge requested. The issue updates when GitHub reports the merge.',
    failed: 'Unable to merge the pull request',
    changed: 'The pull request has new commits. Check it again before merging.',
    forbiddenToken:
      'The GitHub token cannot merge: it needs write access to Contents and Pull requests.',
    authFailed: 'GitHub rejected the configured token.',
    openSettings: 'Open GitHub settings',
    blocker: {
      closed: 'Closed',
      merged: 'Already merged',
      draft: 'Draft',
      conflicts: 'Has conflicts; update the branch',
      computing: 'GitHub is still checking for conflicts',
      ciPending: 'CI is running',
      ciFailed: 'CI failed',
      ciMissing: 'No CI result',
      notConfigured: 'No GitHub token is configured',
      protected:
        'Branch protection does not allow the merge (review or update the branch)',
    },
    screenshots: 'Screenshots',
    ciRun: 'CI run',
  },
  attachments: {
    title: 'Attachments',
    upload: 'Upload',
    choose: 'Choose, drop or paste files',
    preview: 'Preview',
    download: 'Download',
    remove: 'Remove',
    retry: 'Retry',
    attachTo: 'Attach to',
    needText: 'None of the attached files could be read. Add a description.',
    readStatus: {
      read: 'Read',
      truncated: 'Read in part (too long)',
      empty: 'No text found',
      unsupported: 'Not read: format not supported',
      legacy: 'Not read: save in a newer Office format',
      failed: 'Could not be read',
      skipped: 'Not read: text limit reached',
    },
    added: 'Attachments added',
    removed: 'Attachment removed',
    removeTitle: 'Remove {{filename}}?',
    removeDescription:
      'The file is deleted for everyone who can see this issue.',
    tooLarge: 'The file is larger than the upload limit.',
    uploadFailed: 'Upload failed.',
    stillUploading: 'Attachments are still uploading.',
    fixFailed: 'An attachment failed to upload. Retry or remove it.',
    invalid:
      'An attachment can no longer be used. Remove it and upload it again.',
  },
  pmSettings: {
    agent: 'Project manager agent',
    agentHint: 'Only agents of the project manager kind are listed.',
    none: 'None',
    retrospective: 'Retrospective when an issue is done',
    retrospectiveHint:
      'When an issue an agent executed moves to done, the project manager writes an internal note on it.',
    defaultProcess: 'Default process',
    defaultProcessHint:
      'Used when a new issue does not choose one. Automatic decides from the title and description.',
  },
  // NP-88: email invitations (settings → members) and the page an invitation links to.
  invitations: {
    invite: 'Invite members',
    dialogTitle: 'Invite members',
    dialogDescription:
      'Each address gets an email with a link to set a name and password. The link is valid for 7 days.',
    emails: 'Email addresses',
    emailsHint: 'One per line, or separated by commas or spaces. Up to 50.',
    emailsRequired: 'Enter at least one email address.',
    emailsInvalid: 'Not a valid email address: {{emails}}',
    emailsTooMany: 'Up to 50 addresses at a time.',
    projects: 'Projects',
    projectsPlaceholder: 'Choose projects',
    projectsHint: 'Invitees join these projects as members.',
    noProjects: 'No projects',
    projectRequired: 'Choose at least one project you lead.',
    send: 'Send invitations',
    sent: 'Invitations processed: {{number}}',
    forbidden: 'You cannot invite into these projects.',
    done: 'Done',
    resultsLabel: 'Invitation results',
    link: 'Invitation link',
    linkTitle: 'Forward this link',
    outcome: {
      sent: 'Email sent',
      notSent: 'Email not sent — copy the link',
      added: 'Has an account — added to the projects',
      alreadyMember: 'Already a member',
    },
    title: 'Pending invitations',
    loadFailed: 'Unable to load invitations',
    status: 'Status',
    pending: 'Waiting',
    notSent: 'Email not sent',
    expired: 'Expired',
    invitedBy: 'Invited by',
    expiresAt: 'Expires',
    actions: 'Actions',
    resend: 'Send again',
    resent: 'Invitation sent again to {{email}}',
    revoke: 'Revoke',
    revoked: 'Invitation for {{email}} revoked',
    revokeTitle: 'Revoke the invitation for {{email}}?',
    revokeDescription:
      'The link stops working. You can invite the address again later.',
  },
  invite: {
    title: 'Join NocoProject',
    description: '{{inviter}} invited you to NocoProject.',
    descriptionProjects:
      '{{inviter}} invited you to NocoProject and the projects {{projects}}.',
    loading: 'Opening the invitation…',
    email: 'Email',
    name: 'Name',
    password: 'Password',
    nameRequired: 'Enter your name.',
    passwordTooShort: 'The password needs at least {{min}} characters.',
    submit: 'Join',
    submitting: 'Joining…',
    goToLogin: 'Go to sign in',
    existingAccount:
      'This email already has an account and has been added to the projects. Sign in with your existing password.',
    signedIn:
      'You are signed in as {{name}}. Sign out to accept this invitation.',
    signOut: 'Sign out',
    signOutFailed: 'Unable to sign out. Please try again.',
    errors: {
      notFound: 'This invitation link is not valid. Ask for a new invitation.',
      expired: 'This invitation has expired. Ask for a new invitation.',
      accepted: 'This invitation has already been used. Sign in instead.',
      revoked: 'This invitation has been revoked.',
      password: 'The password does not meet the requirements.',
      accountConflict:
        'An account with this email already exists. Sign in instead.',
      failed: 'Something went wrong. Please try again.',
    },
  },
};

export default npIter4EnUS;
export type NpIter4Resource = LocaleResource<typeof npIter4EnUS>;
