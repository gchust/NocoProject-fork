/**
 * Phase 1 sections of the runtime brief: Project Context, Repositories (with pull requests),
 * Sub-issues and Parent coordination (iteration 1 §I), plus Conversation Mode, Skills and the
 * mode-dependent Workflow (iteration 2 §C, §H, §J). Pure string builders.
 */
import { type ClaimedRunV1, executionModeOf } from '../run-context.js';
import { branchNameFor } from '../repo/naming.js';
import { validSkills } from './skills.js';

export type Phase1BriefInput = Pick<ClaimedRunV1, 'agent' | 'issue' | 'project' | 'session'>;

export function phase1Commands(key: string): string[] {
  return [
    `- \`nocoproject issue create --title "..." [--description-file ./sub.md] [--stage N] [--blocked-by NP-1,NP-2] [--executor self|none|<agentId>] [--priority p] [--label a,b] --json\` — create a sub-issue of ${key}`,
    `- \`nocoproject issue children ${key} --json\` — list its sub-issues (stage, status, how many blockers each waits on)`,
    '- `nocoproject issue dependency add|remove <issue> --blocked-by <other> --json` — manage blocked-by dependencies',
    '- `nocoproject project get --json` — the project and its repositories',
    '- `nocoproject repo checkout <url> [--ref <ref>] [--fresh] --json` — check out a project repository (see Repositories)',
    `- \`nocoproject pr link <url> [--issue ${key}] --json\` — link a pull request you opened to ${key}`,
    `- \`nocoproject pr list [--issue ${key}] --json\` — list the pull requests linked to ${key}`,
  ];
}

export function projectSection(input: Phase1BriefInput): string[] {
  const lines = ['## Project Context', ''];
  const project = input.project;
  if (project) {
    lines.push(`This issue belongs to the project **${project.name}** (id \`${project.id}\`).`, '');
    lines.push(project.description?.trim() || '(no project description)');
  } else {
    lines.push('This issue is not in a project.');
  }
  const parent = input.issue.parent;
  if (parent) {
    const stage = input.issue.stage === null || input.issue.stage === undefined ? '' : ` (stage ${input.issue.stage})`;
    lines.push('', `${input.issue.identifier} is a sub-issue${stage} of ${parent.identifier} "${parent.title}". Read the parent for the overall plan: \`nocoproject issue get ${parent.identifier} --json\`.`);
  }
  return lines;
}

function linkedPullRequests(input: Phase1BriefInput): string[] {
  const prs = input.issue.pullRequests ?? [];
  if (prs.length === 0) return [];
  const lines = ['', `Pull requests already linked to ${input.issue.identifier} (push to their branch to update one instead of opening another):`, ''];
  for (const pr of prs) lines.push(`- #${pr.number} (${pr.state}) ${pr.url}`);
  return lines;
}

export function repositoriesSection(input: Phase1BriefInput): string[] {
  const key = input.issue.identifier;
  const resources = input.project?.resources ?? [];
  const lines = ['## Repositories', ''];
  if (resources.length === 0) {
    lines.push('No repositories are attached to this issue’s project, so `repo checkout` is not available.');
    return [...lines, ...linkedPullRequests(input)];
  }
  lines.push('Project repositories (only these can be checked out):', '');
  for (const r of resources) lines.push(`- \`${r.url}\`${r.defaultRef ? ` (default ref \`${r.defaultRef}\`)` : ''}`);
  const branch = input.session.branchName ?? branchNameFor(input.agent.name, key);
  lines.push(
    '',
    `Check one out with \`nocoproject repo checkout <url> --json\`. It creates a git worktree at \`$NOCOPROJECT_WORKDIR/<repo name>/\` on the branch \`${branch}\` and prints its path; later runs of ${key} resume the same branch. \`--ref <ref>\` picks another base, \`--fresh\` discards this checkout and restarts the branch from the base.`,
    '',
    '- Work and commit only inside that worktree, on that branch. Do not switch branches there and do not touch the shared clone cache under `~/.nocoproject/repos`.',
    '- When the work is ready for review, push with `git push -u origin HEAD`.',
    `- Then open a pull request with \`gh pr create --title "${key}: <summary>"\` and link it with \`nocoproject pr link <url>\` (the URL \`gh pr create\` prints). The branch name already contains ${key}, so the server also links it automatically. Mention the PR in your delivery comment.`,
  );
  const previous = input.session.branchName;
  if (previous) {
    lines.push(`- The previous run of ${key} worked on branch \`${previous}\`${input.session.repoUrl ? ` of \`${input.session.repoUrl}\`` : ''}; \`repo checkout\` resumes it.`);
  }
  return [...lines, ...linkedPullRequests(input)];
}

/** `## Conversation Mode` (session mode only, §J): opens the brief. Empty in task mode. */
export function conversationModeSection(input: Phase1BriefInput): string[] {
  if (executionModeOf(input) !== 'session') return [];
  return [
    '## Conversation Mode',
    '',
    'This issue is in session mode: you are in a live conversation with its owner, and each new comment arrives as your next turn.',
    '',
    '- Reply briefly and conversationally, like a chat message. Answer what was just said; do not write a summary report every turn.',
    '- Your working directory and your session carry over from turn to turn, so continue where you left off instead of starting over.',
    '- Comments posted while you are working are delivered to you as the next turn.',
    '- You do not need to move the issue to `in_review` when you finish a turn; the owner changes the status.',
    '',
  ];
}

/** `## Workflow`: the task-mode delivery loop, or the conversational loop in session mode. */
export function workflowSection(input: Phase1BriefInput): string[] {
  if (executionModeOf(input) === 'session') {
    return [
      '## Workflow',
      '',
      '1. Read the new comment(s) quoted in this turn’s prompt. Read the issue and earlier comments only when you need more context.',
      '2. If the issue is still `todo`, set it to `in_progress` once you start producing work.',
      '3. Reply with a short comment using `comment add`, in the triggering thread (`--parent <rootId>`).',
      '4. Leave the status alone after replying; the owner decides when the issue is done. If you are stuck, say what you need in your reply.',
    ];
  }
  return [
    '## Workflow',
    '',
    '1. Read the issue first.',
    '2. Catch up on the comments, especially the thread you were asked in.',
    '3. As soon as you start producing work, set the status to `in_progress`.',
    '4. Deliver your result as a comment with `comment add`, replying to the triggering thread with `--parent <rootId>`.',
    '5. After delivering, set the status to `in_review`. If you are stuck, set `blocked` and leave a comment explaining what you need.',
    '6. If you were only asked a question, answer it with a comment and do not change the status.',
  ];
}

/** `## Skills` (§H): name, description and path of every attached skill. Empty when there are none. */
export function skillsSection(input: Phase1BriefInput): string[] {
  const skills = validSkills(input.agent.skills);
  if (skills.length === 0) return [];
  const lines = [
    '## Skills',
    '',
    'Your owner attached these skills. Each one is a folder with a `SKILL.md` (instructions) and optional supporting files, rebuilt for every run. When a task matches a skill’s description, read its `SKILL.md` first and follow it; skip skills that are not relevant.',
    '',
  ];
  for (const s of skills) {
    const description = s.description.replace(/\s+/g, ' ').trim() || '(no description)';
    lines.push(`- **${s.name}** — ${description} \`${s.path}\``);
  }
  if (input.agent.provider === 'claude') lines.push('', 'Claude Code also discovers the same skills natively under `.claude/skills/`.');
  lines.push('');
  return lines;
}

function delegationLine(input: Phase1BriefInput): string {
  const targets = input.agent.delegationTargets ?? [];
  if (targets.length === 0) return 'You have no delegation list, so naming any other agent always creates a proposal.';
  const list = targets.map((t) => `${t.name} (\`${t.id}\`)`).join(', ');
  return `Your delegation list (these start without approval): ${list}.`;
}

export function subIssuesSection(input: Phase1BriefInput): string[] {
  const key = input.issue.identifier;
  const auto = input.issue.autoExecuteSubtasks === true;
  return [
    '## Sub-issues',
    '',
    'Split work into sub-issues only when it is genuinely separable: independent parts, parts for other agents, or ordered phases. Do small tasks yourself.',
    '',
    `- \`nocoproject issue create --title "..." --description-file ./sub.md --json\` creates a sub-issue of ${key}. Its owner is ${key}'s owner.`,
    '- `--stage N` puts sub-issues into ordered batches: a sub-issue does not start until every sibling with a lower stage is done.',
    '- `--blocked-by NP-1,NP-2` makes it wait for specific issues; it starts on its own once they are done.',
    `- \`--executor self\` asks for you to execute it. Auto-execute sub-issues is **${auto ? 'on' : 'off'}** for ${key}: ${
      auto
        ? 'you become the executor and it runs automatically once it is unblocked.'
        : 'it becomes a proposal that the owner must accept before it runs.'
    }`,
    `- \`--executor <agentId>\` proposes another agent; the owner must accept it unless that agent is in your delegation list. ${delegationLine(input)}`,
    '- `--executor none` (the default) leaves it unassigned for a human.',
    '- Never @-mention other agents to hand off work; create sub-issues instead.',
    `- After creating sub-issues, post a comment on ${key} that lists them and explains the plan, and keep ${key} \`in_progress\` while they run: you are woken when a batch finishes.`,
  ];
}

export function parentCoordinationSection(key: string): string[] {
  return [
    '## Parent coordination',
    '',
    `When you are woken because a batch of ${key}'s sub-issues finished:`,
    '',
    `1. Run \`nocoproject issue children ${key} --json\` and read the finished sub-issues (\`issue get\`, \`issue comment list\`) for their results.`,
    '2. Adjust the plan if needed: create follow-up sub-issues, add or remove dependencies.',
    '3. Later stages start on their own once unblocked; do not re-create them. Post a short progress comment.',
    `4. When every sub-issue is done, check the combined result, post a summary comment on ${key} and set it to \`in_review\`.`,
  ];
}
