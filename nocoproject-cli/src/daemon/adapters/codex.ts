/**
 * Codex adapter (verified against codex-cli 0.154.0, `codex exec`; no app-server needed).
 *
 * Launch (new session, cwd = workDir):
 *   codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C <workDir> [-m model] <prompt>
 * Resume:
 *   codex exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m model] <sessionId> <prompt>
 * Both add `-c model_reasoning_effort="<effort>"` when the agent has a `reasoningEffort` (codex 0.154 accepts
 * none / minimal / low / medium / high / xhigh / max).
 * (`exec resume` accepts neither `-s` nor `-C`; the bypass flag is accepted by both. Agents need
 * network access and write access outside the workDir — the repo cache — so no sandbox.)
 * stdin is closed right away: with a piped stdin Codex appends it to the prompt.
 *
 * `--json` prints one JSONL event per line (captured in tests/fixtures/codex):
 *   {type:'thread.started', thread_id}            → session id (a UUID, used for resume)
 *   {type:'turn.started'}
 *   {type:'item.started'|'item.updated'|'item.completed', item:{id, type, ...}}
 *       item.type: agent_message{text} reasoning{text} command_execution{command, aggregated_output,
 *       exit_code, status} file_change{changes[], status} mcp_tool_call{server, tool, arguments,
 *       result, error, status} web_search{query} todo_list{items[]} error{message} (a warning)
 *   {type:'turn.completed', usage:{input_tokens, cached_input_tokens, cache_write_input_tokens,
 *       output_tokens, reasoning_output_tokens}}
 *   {type:'turn.failed', error:{message}}  {type:'error', message}
 * Codex logs unrelated MCP / login noise (including "401") on stderr even for successful runs,
 * so stderr is only used for the error text when the JSON stream carries no error.
 */
import type { RunUsageInput } from '../../protocol.js';
import { probeVersion, which } from '../../util/process.js';
import { launchLineProcess } from './spawn.js';
import { nowIso, type AdapterCapabilities, type AgentAdapter, type AgentEvent, type RunHandle, type RunSpec } from './types.js';

export interface CodexParseState {
  sessionId?: string;
  lastText?: string;
  usage: { input: number; cached: number; cacheWrite: number; output: number; seen: boolean };
  /** Item ids whose toolUse was already emitted on item.started. */
  started: Set<string>;
  errors: string[];
  turnCompleted: boolean;
  turnFailed: boolean;
  visible: number;
}

export function newCodexState(): CodexParseState {
  return { usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, seen: false }, started: new Set(), errors: [], turnCompleted: false, turnFailed: false, visible: 0 };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Codex error messages are often a JSON body; turn `{"error":{"code","message"}}` into `code: message`. */
export function codexErrorText(message: string): string {
  try {
    const parsed = JSON.parse(message) as unknown;
    const err = isObj(parsed) && isObj(parsed.error) ? parsed.error : isObj(parsed) ? parsed : undefined;
    const text = err ? str(err.message) : undefined;
    const code = err ? str(err.code) ?? str(err.type) : undefined;
    if (text) return code ? `${code}: ${text}` : text;
  } catch {
    /* not JSON */
  }
  return message;
}

interface ToolView {
  readonly tool: string;
  readonly input: unknown;
}

function toolView(item: Json): ToolView | undefined {
  switch (item.type) {
    case 'command_execution':
      return { tool: 'shell', input: { command: str(item.command) ?? '' } };
    case 'file_change':
      return { tool: 'apply_patch', input: { changes: item.changes ?? [] } };
    case 'mcp_tool_call':
      return { tool: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, input: item.arguments ?? {} };
    case 'web_search':
      return { tool: 'web_search', input: { query: str(item.query) ?? '' } };
    default:
      return undefined;
  }
}

function toolOutput(item: Json): string {
  switch (item.type) {
    case 'command_execution': {
      const out = str(item.aggregated_output) ?? '';
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      return failed ? `[error] exit ${String(item.exit_code ?? 'unknown')}\n${out}` : out;
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c) => (isObj(c) ? `${str(c.kind) ?? 'update'} ${str(c.path) ?? ''}` : String(c))).join('\n');
      return item.status === 'failed' ? `[error] patch failed\n${files}` : files || 'patch applied';
    }
    case 'mcp_tool_call': {
      if (item.error) return `[error] ${isObj(item.error) ? (str(item.error.message) ?? JSON.stringify(item.error)) : String(item.error)}`;
      return typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
    }
    default:
      return item.status === 'failed' ? '[error] failed' : 'done';
  }
}

function todoText(item: Json): string {
  const items = Array.isArray(item.items) ? item.items : [];
  return items.map((t) => (isObj(t) ? `${t.completed ? '[x]' : '[ ]'} ${str(t.text) ?? ''}` : String(t))).join('\n');
}

function parseItem(kind: string, item: Json, state: CodexParseState, at: string): AgentEvent[] {
  const id = str(item.id);
  const view = toolView(item);
  if (view) {
    const events: AgentEvent[] = [];
    if (kind === 'item.started' || (kind === 'item.completed' && !(id && state.started.has(id)))) {
      if (id) state.started.add(id);
      events.push({ type: 'toolUse', tool: view.tool, callId: id, input: view.input, at });
    }
    if (kind === 'item.completed') events.push({ type: 'toolResult', tool: view.tool, callId: id, output: toolOutput(item), at });
    return events;
  }
  if (kind !== 'item.completed') return [];
  switch (item.type) {
    case 'agent_message': {
      const text = str(item.text);
      if (!text) return [];
      state.lastText = text;
      return [{ type: 'text', content: text, at }];
    }
    case 'reasoning': {
      const text = str(item.text);
      return text ? [{ type: 'thinking', content: text, at }] : [];
    }
    case 'todo_list':
      return [{ type: 'status', content: `Plan:\n${todoText(item)}`, at }];
    case 'error':
      return [{ type: 'status', content: `Codex warning: ${codexErrorText(str(item.message) ?? '')}`, at }];
    default:
      return [];
  }
}

function recordUsage(usage: unknown, state: CodexParseState): void {
  if (!isObj(usage)) return;
  state.usage.input += num(usage.input_tokens);
  state.usage.cached += num(usage.cached_input_tokens);
  state.usage.cacheWrite += num(usage.cache_write_input_tokens);
  state.usage.output += num(usage.output_tokens);
  state.usage.seen = true;
}

/** Records an error once (Codex repeats the same message in `error` and `turn.failed`). */
function pushError(message: string, state: CodexParseState, at: string): AgentEvent[] {
  if (state.errors.includes(message)) return [];
  state.errors.push(message);
  return [{ type: 'error', content: message, at }];
}

/** Parses one `codex exec --json` line. Pure apart from mutating `state`. */
export function parseCodexLine(line: string, state: CodexParseState, at: string = nowIso()): AgentEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];
  let events: AgentEvent[] = [];
  switch (msg.type) {
    case 'thread.started':
      state.sessionId = str(msg.thread_id) ?? state.sessionId;
      return [{ type: 'status', content: state.sessionId ? `Codex session ${state.sessionId} started` : 'Codex session started', at }];
    case 'turn.completed':
      state.turnCompleted = true;
      recordUsage(msg.usage, state);
      return [];
    case 'turn.failed':
      state.turnFailed = true;
      return pushError(codexErrorText(isObj(msg.error) ? (str(msg.error.message) ?? 'turn failed') : 'turn failed'), state, at);
    case 'error':
      return pushError(codexErrorText(str(msg.message) ?? 'Codex error'), state, at);
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      if (isObj(msg.item)) events = parseItem(msg.type, msg.item, state, at);
      break;
    default:
      return [];
  }
  state.visible += events.filter((e) => e.type !== 'status' && e.type !== 'error').length;
  return events;
}

/** OpenAI-style usage counts cached tokens inside input_tokens; report them separately. */
export function codexUsage(state: CodexParseState, model: string | undefined): RunUsageInput | undefined {
  if (!state.usage.seen) return undefined;
  return {
    provider: 'codex',
    model,
    inputTokens: Math.max(0, state.usage.input - state.usage.cached),
    outputTokens: state.usage.output,
    cacheReadTokens: state.usage.cached,
    cacheWriteTokens: state.usage.cacheWrite,
  };
}

const COMMON_FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];

export function buildCodexArgs(spec: Pick<RunSpec, 'model' | 'resumeSessionId' | 'prompt' | 'workDir' | 'reasoningEffort'>): string[] {
  const model = spec.model ? ['-m', spec.model] : [];
  if (spec.reasoningEffort) model.push('-c', `model_reasoning_effort="${spec.reasoningEffort}"`);
  if (spec.resumeSessionId) return ['exec', 'resume', ...COMMON_FLAGS, ...model, spec.resumeSessionId, spec.prompt];
  return ['exec', ...COMMON_FLAGS, '-C', spec.workDir, ...model, spec.prompt];
}

const RESUME_REJECTED = /no rollout found|thread\/resume failed|session not found|no (such )?(session|thread|conversation) found/i;
/** stderr lines that are never about this run (MCP servers, login refresh, stdin notice). */
const STDERR_NOISE = /rmcp::|codex_login::|Reading additional input from stdin|^\s*[{}"]|^\s*$/;

export function codexStderrErrors(stderr: string): string {
  return stderr
    .split('\n')
    .filter((l) => !STDERR_NOISE.test(l))
    .slice(-10)
    .join('\n')
    .trim();
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  private path: string | null = null;

  constructor(private readonly command = process.env.NOCOPROJECT_CODEX_PATH || 'codex') {}

  async detect(): Promise<{ version: string; path: string } | null> {
    const path = which(this.command, ['/opt/homebrew/bin', '/usr/local/bin']);
    if (!path) return null;
    const version = await probeVersion(path);
    if (!version) return null;
    this.path = path;
    return { version, path };
  }

  capabilities(): AdapterCapabilities {
    return { resume: true, steering: false, briefFile: 'AGENTS.md' };
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const state = newCodexState();
    return launchLineProcess({
      command: this.path ?? this.command,
      args: buildCodexArgs(spec),
      cwd: spec.workDir,
      env: spec.env,
      logsDir: spec.logsDir,
      onSpawn: (child) => child.stdin?.end(),
      onStdoutLine: (line, ctl) => {
        for (const e of parseCodexLine(line, state)) ctl.emit(e);
      },
      finish: (info) => {
        const failed = info.spawnError !== undefined || info.exitCode !== 0 || state.turnFailed || !state.turnCompleted;
        const stderrErrors = codexStderrErrors(info.stderrTail);
        const jsonErrors = state.errors.join('\n');
        const errorText = failed ? [info.spawnError?.message, jsonErrors || stderrErrors].filter(Boolean).join('\n') || undefined : undefined;
        const resumeRejected = Boolean(spec.resumeSessionId && failed && !state.turnCompleted && RESUME_REJECTED.test(`${errorText ?? ''}\n${info.stderrTail}`));
        return {
          exitCode: info.exitCode,
          signal: info.signal,
          sessionId: resumeRejected ? undefined : state.sessionId,
          usage: codexUsage(state, spec.model),
          errorText,
          stderrTail: info.stderrTail,
          summary: state.lastText,
          classifiedFailure: info.spawnError?.code === 'ENOENT' ? 'agentError.missingExecutable' : undefined,
          resumeRejected,
          visibleEvents: state.visible,
        };
      },
    });
  }
}
