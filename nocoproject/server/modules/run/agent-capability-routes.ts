import type { AgentCapability } from '../shared/protocol.capabilities.js';
const routes: readonly [string, RegExp, AgentCapability][] = [
  ['GET', /^\/context$/, 'context.read'],
  [
    'GET',
    /^\/issues\/[^/]+(?:\/(?:comments|children|pull-requests|checklists))?$/,
    'context.read',
  ],
  [
    'GET',
    /^\/issues\/[^/]+\/attachments\/[^/]+\/(?:content|text)$/,
    'context.read',
  ],
  ['GET', /^\/knowledge(?:\/[^/]+)?$/, 'context.read'],
  ['GET', /^\/workflows(?:\/[^/]+)?$/, 'context.read'],
  [
    'GET',
    /^\/pm\/(?:projects|issues|inbox|metrics|knowledge|agents|runs|pull-requests)(?:\/[^/]+)?$/,
    'workspace.read',
  ],
  ['GET', /^\/pm\/runs\/[^/]+\/events$/, 'workspace.read'],
  // NP-183: the project manager acting in the asker's name (conversation runs only, checked by the service).
  ['POST', /^\/pm\/act$/, 'member.act'],
  ['POST', /^\/pm\/conversation\/title$/, 'member.act'],
  ['GET', /^\/pm\/plans(?:\/[^/]+)?$/, 'member.act'],
  ['POST', /^\/pm\/plans(?:\/[^/]+\/discard)?$/, 'member.act'],
  ['POST', /^\/issues$/, 'subtask.create'],
  ['POST', /^\/issues\/[^/]+\/comments$/, 'comment.create'],
  // NP-214: one comment attachment per request.
  ['POST', /^\/issues\/[^/]+\/uploads$/, 'attachment.upload'],
  ['POST', /^\/issues\/[^/]+\/status$/, 'issue.status.write'],
  ['POST', /^\/issues\/[^/]+\/design-proposal$/, 'design.propose'],
  ['POST', /^\/issues\/[^/]+\/pull-requests$/, 'pullRequest.link'],
  ['POST', /^\/issues\/[^/]+\/dependencies$/, 'dependency.write'],
  ['DELETE', /^\/issues\/[^/]+\/dependencies(?:\/[^/]+)?$/, 'dependency.write'],
  [
    'PATCH',
    /^\/issues\/[^/]+\/checklists\/[^/]+\/items\/[^/]+$/,
    'checklist.write',
  ],
  ['POST', /^\/knowledge\/proposals$/, 'knowledge.propose'],
  ['POST', /^\/workflows\/proposals$/, 'workflow.propose'],
];
export function routeCapability(
  method: string,
  path: string,
): AgentCapability | undefined {
  const relative =
    (path.includes('/np/agent') ? path.split('/np/agent')[1] : path)?.replace(
      /\/$/,
      '',
    ) ?? '';
  return routes.find(
    ([verb, pattern]) => verb === method && pattern.test(relative),
  )?.[2];
}
