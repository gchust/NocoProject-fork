/**
 * Claude Code adapter.
 *
 * Launch: `claude -p --output-format stream-json --input-format stream-json --verbose
 *          --permission-mode bypassPermissions [--model m] [--effort level] [--resume id]`
 * `--effort` carries the agent's `reasoningEffort` (Claude Code levels: low, medium, high, xhigh, max; `minimal`
 * maps to `low`) and is only passed when `claude --help` lists it.
 * With `--input-format stream-json` the prompt is delivered on stdin as one stream-json
 * user message (a positional prompt is not read in that mode); stdin stays open so we can
 * answer `control_request` frames, and is closed once the `result` event arrives.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReasoningEffort, RunUsageInput } from '../../protocol.js';
import { probeOutput, probeVersion, which } from '../../util/process.js';
import { launchLineProcess } from './spawn.js';
import { nowIso, type AdapterCapabilities, type AgentAdapter, type AgentEvent, type RunHandle, type RunSpec } from './types.js';

export interface ClaudeParseState {
  sessionId?: string;
  model?: string;
  usage?: RunUsageInput;
  resultText?: string;
  resultSubtype?: string;
  isError: boolean;
  sawResult: boolean;
  lastText?: string;
  visible: number;
  errors: string[];
}

export interface ClaudeLineOutcome {
  readonly events: AgentEvent[];
  readonly controlRequest?: { readonly requestId: string; readonly input: unknown };
  readonly done?: boolean;
}

export function newClaudeState(): ClaudeParseState {
  return { isError: false, sawResult: false, visible: 0, errors: [] };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Flattens a tool_result `content` (string or content-block array) into text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) ? (str(b.text) ?? (b.type === 'image' ? '[image]' : JSON.stringify(b))) : String(b)))
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function parseAssistant(msg: Json, state: ClaudeParseState, at: string): AgentEvent[] {
  const message = isObj(msg.message) ? msg.message : {};
  if (!state.model && str(message.model) && message.model !== '<synthetic>') state.model = str(message.model);
  const synthetic = message.model === '<synthetic>';
  const events: AgentEvent[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isObj(block)) continue;
    if (block.type === 'text' && str(block.text)) {
      const text = str(block.text) as string;
      if (synthetic) state.errors.push(text);
      state.lastText = text;
      events.push({ type: 'text', content: text, at });
    } else if (block.type === 'thinking') {
      const text = str(block.thinking) ?? str(block.text);
      if (text) events.push({ type: 'thinking', content: text, at });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'toolUse', tool: str(block.name) ?? 'unknown', callId: str(block.id), input: block.input ?? {}, at });
    }
  }
  return events;
}

function parseUser(msg: Json, at: string): AgentEvent[] {
  const message = isObj(msg.message) ? msg.message : {};
  const events: AgentEvent[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isObj(block) || block.type !== 'tool_result') continue;
    const text = toolResultText(block.content);
    events.push({
      type: 'toolResult',
      callId: str(block.tool_use_id),
      output: block.is_error === true ? `[error] ${text}` : text,
      at,
    });
  }
  return events;
}

function parseResult(msg: Json, state: ClaudeParseState): void {
  state.sawResult = true;
  state.isError = msg.is_error === true || (str(msg.subtype) ?? 'success') !== 'success';
  state.resultSubtype = str(msg.subtype);
  state.resultText = str(msg.result);
  if (str(msg.session_id)) state.sessionId = str(msg.session_id);
  const modelUsage = isObj(msg.modelUsage) ? msg.modelUsage : undefined;
  const model = state.model ?? (modelUsage ? Object.keys(modelUsage)[0] : undefined);
  const usage = isObj(msg.usage) ? msg.usage : undefined;
  if (usage) {
    state.usage = {
      provider: 'claude',
      model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
    };
  }
  if (state.isError) {
    const errs = Array.isArray(msg.errors) ? msg.errors.map((e) => String(e)) : [];
    state.errors.push(...errs, ...(state.resultText ? [state.resultText] : []), ...(state.resultSubtype ? [state.resultSubtype] : []));
  }
}

/** Parses one stream-json line. Pure apart from mutating `state`. */
export function parseClaudeLine(line: string, state: ClaudeParseState, at: string = nowIso()): ClaudeLineOutcome {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (!isObj(msg)) return { events: [] };
  let events: AgentEvent[] = [];
  switch (msg.type) {
    case 'system':
      if (str(msg.session_id)) state.sessionId = str(msg.session_id);
      if (msg.subtype === 'init') {
        if (str(msg.model)) state.model = str(msg.model);
        events = [{ type: 'status', content: `Claude Code session ${state.sessionId ?? ''} started${state.model ? ` (${state.model})` : ''}`.trim(), at }];
      }
      break;
    case 'assistant':
      events = parseAssistant(msg, state, at);
      break;
    case 'user':
      events = parseUser(msg, at);
      break;
    case 'result':
      parseResult(msg, state);
      if (state.isError) events = [{ type: 'error', content: state.errors.join('\n') || 'Claude Code reported an error', at }];
      return { events, done: true };
    case 'control_request': {
      const request = isObj(msg.request) ? msg.request : {};
      const requestId = str(msg.request_id);
      if (requestId) return { events: [], controlRequest: { requestId, input: request.input ?? {} } };
      break;
    }
    default:
      break;
  }
  state.visible += events.filter((e) => e.type !== 'status' && e.type !== 'error').length;
  return { events };
}

/** Claude Code's `--effort` levels for each `reasoningEffort` (it has no `minimal`). */
export const CLAUDE_EFFORT: Readonly<Record<ReasoningEffort, string>> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };

export function buildClaudeArgs(spec: Pick<RunSpec, 'model' | 'resumeSessionId' | 'reasoningEffort'>, opts: { readonly effortFlag?: boolean } = {}): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.reasoningEffort && opts.effortFlag !== false) args.push('--effort', CLAUDE_EFFORT[spec.reasoningEffort]);
  if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
  return args;
}

export function claudeUserMessage(prompt: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`;
}

function controlAllow(requestId: string, input: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } },
  })}\n`;
}

const RESUME_REJECTED = /no conversation found|bound to (another|a different) account|已绑定另外/i;

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private path: string | null = null;
  /** Whether this `claude` accepts `--effort` (from `claude --help`); null until probed. */
  private effortFlag: boolean | null = null;

  constructor(private readonly command = process.env.NOCOPROJECT_CLAUDE_PATH || 'claude') {}

  private async supportsEffort(): Promise<boolean> {
    if (this.effortFlag === null) this.effortFlag = /--effort\b/.test((await probeOutput(this.path ?? this.command, ['--help'])) ?? '');
    return this.effortFlag;
  }

  async detect(): Promise<{ version: string; path: string } | null> {
    const path = which(this.command, [join(homedir(), '.claude', 'local'), join(homedir(), '.local', 'bin')]);
    if (!path) return null;
    const version = await probeVersion(path);
    if (!version) return null;
    this.path = path;
    return { version, path };
  }

  capabilities(): AdapterCapabilities {
    return { resume: true, steering: false, briefFile: 'CLAUDE.md', nativeSkillsDir: '.claude/skills' };
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const state = newClaudeState();
    const effortFlag = spec.reasoningEffort ? await this.supportsEffort() : false;
    return launchLineProcess({
      command: this.path ?? this.command,
      args: buildClaudeArgs(spec, { effortFlag }),
      cwd: spec.workDir,
      env: spec.env,
      logsDir: spec.logsDir,
      onSpawn: (child) => child.stdin?.write(claudeUserMessage(spec.prompt)),
      onStdoutLine: (line, ctl) => {
        const outcome = parseClaudeLine(line, state);
        for (const e of outcome.events) ctl.emit(e);
        if (outcome.controlRequest) ctl.stdin?.write(controlAllow(outcome.controlRequest.requestId, outcome.controlRequest.input));
        if (outcome.done) ctl.stdin?.end();
      },
      finish: (info) => {
        const failed = info.spawnError !== undefined || info.exitCode !== 0 || state.isError || !state.sawResult;
        const errorText = failed
          ? [info.spawnError?.message, ...state.errors, info.stderrTail.trim()].filter(Boolean).join('\n')
          : undefined;
        const resumeRejected = Boolean(spec.resumeSessionId && failed && RESUME_REJECTED.test(errorText ?? ''));
        return {
          exitCode: info.exitCode,
          signal: info.signal,
          sessionId: resumeRejected ? undefined : state.sessionId,
          usage: state.usage,
          errorText,
          stderrTail: info.stderrTail,
          summary: state.resultText ?? state.lastText,
          classifiedFailure: info.spawnError?.code === 'ENOENT' ? 'agentError.missingExecutable' : undefined,
          resumeRejected,
          visibleEvents: state.visible,
        };
      },
    });
  }
}
