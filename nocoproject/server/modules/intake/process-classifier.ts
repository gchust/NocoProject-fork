/**
 * The process classifier (docs/phase1/iteration-4-contract.md §B): does a new issue start with analysis and a design
 * proposal a human reviews (`design_first`), or go straight to implementation (`direct`)?
 *
 * Heuristic first, in this order:
 *
 * | rule               | result       | when                                                                          |
 * | ------------------ | ------------ | ----------------------------------------------------------------------------- |
 * | `long_description` | design_first | the description has at least 600 characters                                   |
 * | `fix_prefix`       | direct       | the title starts with fix / hotfix / bugfix / typo / 修复 / 改文案, description < 200 |
 * | `keyword`          | design_first | 设计 / 方案 / 架构 / 重构 / 迁移 / 新模块 / 调研, or design / architecture / refactor / migrate / new module / research / investigate / RFC / spike |
 * | `subtasks`         | design_first | 子任务 / 拆分 / 分解 / subtask / break down, or at least three list items in the description |
 * | (none)             | direct       | nothing matched                                                               |
 *
 * Only when no rule matched, and an LLM service is configured, one direct model call decides (the same
 * `AiAgentFactory` the AI intake parser uses, see `server/providers/np.ts`), under a 30 second timeout; a failure,
 * a timeout or an unreadable reply falls back to the heuristic's `direct`. Intake batches use the heuristic only.
 */
import type { IssueProcess } from '../shared/protocol.js';
import type { AiAgentFactory } from './ai-parser.js';

export const PROCESS_CLASSIFY_TIMEOUT_MS = 30_000;
const LONG_DESCRIPTION = 600;
const SHORT_DESCRIPTION = 200;
const AI_DESCRIPTION_LIMIT = 8_000;

export interface ProcessClassifyInput {
  readonly title: string;
  readonly description: string;
}

export type ProcessRule =
  | 'long_description'
  | 'fix_prefix'
  | 'keyword'
  | 'subtasks'
  | 'short_description';

export interface HeuristicDecision {
  readonly process: IssueProcess;
  /** The rule that decided, or null when nothing matched (then the default `direct`). */
  readonly rule: ProcessRule | null;
}

export interface ProcessDecision {
  readonly process: IssueProcess;
  readonly by: 'heuristic' | 'ai';
  readonly rule: ProcessRule | null;
}

const FIX_PREFIX =
  /^\s*(?:\[?(?:fix(?:es|ed)?|hotfix|bugfix|typo)\b|修复|改文案)/iu;
const CHINESE_KEYWORDS = [
  '设计',
  '方案',
  '架构',
  '重构',
  '迁移',
  '新模块',
  '调研',
];
const ENGLISH_KEYWORDS =
  /\b(?:design|architecture|architect|refactor(?:ing)?|migrat(?:e|es|ion|ions)|new module|research|investigat\w*|rfc|spike)\b/iu;
const SUBTASK_WORDS =
  /子任务|拆分|分解|\bsub-?tasks?\b|\bbreak (?:it )?down\b/iu;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)、]|[a-z][.)])\s+\S/u;

function listItems(text: string): number {
  return text.split(/\r?\n/u).filter((line) => LIST_ITEM.test(line)).length;
}

/** The heuristic alone (pure). */
export function classifyHeuristic(
  input: ProcessClassifyInput,
): HeuristicDecision {
  const title = input.title ?? '';
  const description = input.description ?? '';
  const text = `${title}\n${description}`;
  if (description.length >= LONG_DESCRIPTION)
    return { process: 'design_first', rule: 'long_description' };
  if (FIX_PREFIX.test(title) && description.length < SHORT_DESCRIPTION)
    return { process: 'direct', rule: 'fix_prefix' };
  if (
    CHINESE_KEYWORDS.some((word) => text.includes(word)) ||
    ENGLISH_KEYWORDS.test(text)
  )
    return { process: 'design_first', rule: 'keyword' };
  if (SUBTASK_WORDS.test(text) || listItems(description) >= 3)
    return { process: 'design_first', rule: 'subtasks' };
  // A short brief with no design signal is routine work; asking the model would only add latency and doubt.
  if (description.length < SHORT_DESCRIPTION)
    return { process: 'direct', rule: 'short_description' };
  return { process: 'direct', rule: null };
}

/** One binary model call; null when the reply names neither process. */
export interface AiProcessClassifier {
  classify(
    input: ProcessClassifyInput,
    userId: string,
    signal?: AbortSignal,
  ): Promise<IssueProcess | null>;
}

export const PROCESS_SYSTEM_PROMPT = [
  'You decide how a software task in a project tracker starts.',
  'design_first: the agent first analyses the requirement and writes a design proposal that a human reviews before',
  'any code is written. Choose it for large, ambiguous or cross-cutting work: new modules, architecture, refactoring,',
  'data migrations, research, or work that should be split into several sub-tasks.',
  'direct: the agent implements right away. Choose it for small, well-defined changes: bug fixes, copy changes,',
  'small tweaks with a clear expected result.',
  'Reply with one JSON object and nothing else: {"process":"direct"} or {"process":"design_first"}.',
].join('\n');

/** The process named in a reply: `{"process": …}`, or the bare word. */
export function parseProcessReply(content: unknown): IssueProcess | null {
  const blockText = (block: unknown): string => {
    if (typeof block === 'string') return block;
    const inner = (block as { text?: unknown } | null)?.text;
    return typeof inner === 'string' ? inner : '';
  };
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(blockText).join('\n')
        : '';
  const match = /"process"\s*:\s*"(direct|design_first)"/u.exec(text);
  if (match) return match[1] as IssueProcess;
  if (/\bdesign_first\b/u.test(text)) return 'design_first';
  if (/\bdirect\b/u.test(text)) return 'direct';
  return null;
}

export function createAiProcessClassifier(
  factory: AiAgentFactory,
  timeoutMs = PROCESS_CLASSIFY_TIMEOUT_MS,
): AiProcessClassifier {
  return {
    async classify(input, userId, signal) {
      const sessionId = await factory.createSession(
        userId,
        'NocoProject process',
      );
      const agent = await factory.createAgent({
        sessionId,
        userId,
        systemPrompt: PROCESS_SYSTEM_PROMPT,
      });
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const aborted = new Promise<never>((_resolve, reject) => {
        combined.addEventListener('abort', () =>
          reject(new Error('The process classifier timed out.')),
        );
      });
      aborted.catch(() => undefined);
      const result = await Promise.race([
        agent.invoke({
          userMessages: [
            {
              role: 'user',
              content: `<title>\n${input.title}\n</title>\n<description>\n${input.description.slice(0, AI_DESCRIPTION_LIMIT)}\n</description>`,
            },
          ],
          signal: combined,
        }),
        aborted,
      ]);
      return parseProcessReply(result.message?.content);
    },
  };
}

export interface ProcessClassifier {
  /** The heuristic, then (only when no rule matched and `useAi`) the model; never throws. */
  classify(
    input: ProcessClassifyInput,
    options: { readonly userId: string; readonly useAi: boolean },
  ): Promise<ProcessDecision>;
}

export function createProcessClassifier(deps: {
  readonly ai: AiProcessClassifier | null;
  readonly aiConfigured: () => boolean;
}): ProcessClassifier {
  return {
    async classify(input, options) {
      const heuristic = classifyHeuristic(input);
      if (
        heuristic.rule !== null ||
        !options.useAi ||
        !deps.ai ||
        !deps.aiConfigured()
      )
        return { ...heuristic, by: 'heuristic' };
      try {
        const process = await deps.ai.classify(input, options.userId);
        if (process) return { process, by: 'ai', rule: null };
      } catch {
        // Falls back to the heuristic below.
      }
      return { ...heuristic, by: 'heuristic' };
    },
  };
}
