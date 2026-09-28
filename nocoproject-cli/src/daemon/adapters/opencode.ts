/**
 * OpenCode adapter (verified against OpenCode 1.18.32).
 *
 * Launch: `opencode run --format json --auto --thinking --print-logs --log-level WARN
 *          --dir <workDir> [--session <id>] [--model provider/model] [--variant <effort>] <prompt>`
 * (`--variant` is OpenCode's provider-specific reasoning effort; passed as the agent's `reasoningEffort`)
 * (cwd is also the workDir and PWD is reset: OpenCode otherwise takes its project dir from PWD)
 *
 * `--format json` prints one JSON object per line: `step_start`, `text`, `reasoning`
 * (only with --thinking), `tool_use` (emitted once the tool completed or errored, with
 * input + output), `step_finish` (token usage) and `error`. Every line carries `sessionID`.
 * Without `--auto`, permission prompts are auto-rejected in non-interactive mode.
 * OpenCode retries provider errors (e.g. usage limits) indefinitely and prints nothing to
 * stdout meanwhile, so we watch `--print-logs` stderr for fatal provider errors and stop early.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunUsageInput } from '../../protocol.js';
import { probeVersion, which } from '../../util/process.js';
import { launchLineProcess } from './spawn.js';
import { nowIso, type AdapterCapabilities, type AgentAdapter, type AgentEvent, type RunHandle, type RunSpec } from './types.js';

export interface OpenCodeParseState {
  sessionId?: string;
  lastText?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; seen: boolean };
  errors: string[];
  visible: number;
}

export function newOpenCodeState(): OpenCodeParseState {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, seen: false }, errors: [], visible: 0 };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function isoFrom(ts: unknown, fallback: string): string {
  return typeof ts === 'number' ? new Date(ts).toISOString() : fallback;
}

function toolEvents(part: Json, at: string): AgentEvent[] {
  const st = isObj(part.state) ? part.state : {};
  const tool = str(part.tool) ?? 'unknown';
  const callId = str(part.callID);
  const events: AgentEvent[] = [{ type: 'toolUse', tool, callId, input: st.input ?? {}, at }];
  if (st.status === 'error') events.push({ type: 'toolResult', tool, callId, output: `[error] ${str(st.error) ?? 'tool failed'}`, at });
  else events.push({ type: 'toolResult', tool, callId, output: str(st.output) ?? JSON.stringify(st.output ?? ''), at });
  return events;
}

function errorMessage(error: unknown): string {
  if (!isObj(error)) return String(error ?? 'OpenCode error');
  const data = isObj(error.data) ? error.data : {};
  return str(data.message) ?? str(error.message) ?? str(error.name) ?? JSON.stringify(error);
}

/** Parses one `opencode run --format json` line. Pure apart from mutating `state`. */
export function parseOpenCodeLine(line: string, state: OpenCodeParseState): AgentEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];
  if (str(msg.sessionID)) state.sessionId = str(msg.sessionID);
  const at = isoFrom(msg.timestamp, nowIso());
  const part = isObj(msg.part) ? msg.part : {};
  let events: AgentEvent[] = [];
  switch (msg.type) {
    case 'text': {
      const text = str(part.text);
      if (text) {
        state.lastText = text;
        events = [{ type: 'text', content: text, at }];
      }
      break;
    }
    case 'reasoning': {
      const text = str(part.text);
      if (text) events = [{ type: 'thinking', content: text, at }];
      break;
    }
    case 'tool_use':
      events = toolEvents(part, at);
      break;
    case 'step_finish': {
      const tokens = isObj(part.tokens) ? part.tokens : {};
      const cache = isObj(tokens.cache) ? tokens.cache : {};
      state.tokens.input += num(tokens.input);
      state.tokens.output += num(tokens.output) + num(tokens.reasoning);
      state.tokens.cacheRead += num(cache.read);
      state.tokens.cacheWrite += num(cache.write);
      state.tokens.seen = true;
      break;
    }
    case 'error': {
      const message = errorMessage(msg.error);
      state.errors.push(message);
      return [{ type: 'error', content: message, at }];
    }
    default:
      break;
  }
  state.visible += events.length;
  return events;
}

export function openCodeUsage(state: OpenCodeParseState, model: string | undefined): RunUsageInput | undefined {
  if (!state.tokens.seen) return undefined;
  return {
    provider: 'opencode',
    model,
    inputTokens: state.tokens.input,
    outputTokens: state.tokens.output,
    cacheReadTokens: state.tokens.cacheRead,
    cacheWriteTokens: state.tokens.cacheWrite,
  };
}

export function buildOpenCodeArgs(spec: Pick<RunSpec, 'model' | 'resumeSessionId' | 'prompt' | 'workDir' | 'reasoningEffort'>): string[] {
  const args = ['run', '--format', 'json', '--auto', '--thinking', '--print-logs', '--log-level', 'WARN', '--dir', spec.workDir];
  if (spec.resumeSessionId) args.push('--session', spec.resumeSessionId);
  if (spec.model) args.push('--model', spec.model);
  if (spec.reasoningEffort) args.push('--variant', spec.reasoningEffort);
  args.push(spec.prompt);
  return args;
}

/** Provider errors OpenCode would retry forever but that will never succeed. */
const FATAL_STDERR = /usage limit|insufficient.?(quota|balance)|quota exceeded|credit balance|payment required|\b401\b|\b403\b|unauthori[sz]ed|invalid.{0,12}api.?key|authentication|model.{0,20}not found|ProviderModelNotFound/i;
const RESUME_REJECTED = /session not found/i;
/** After a JSON `error` event, give OpenCode this long to exit (it sometimes lingers). */
const ERROR_EXIT_GRACE_MS = 10_000;

export function fatalStderrLine(chunk: string): string | undefined {
  for (const line of chunk.split('\n')) {
    if (!/level=ERROR/.test(line)) continue;
    const m = line.match(/error\.error="([^"]*)"/) ?? line.match(/message="([^"]*)"/);
    const text = m?.[1] ?? line;
    if (FATAL_STDERR.test(text)) return text;
  }
  return undefined;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly provider = 'opencode' as const;
  private path: string | null = null;

  constructor(private readonly command = process.env.NOCOPROJECT_OPENCODE_PATH || 'opencode') {}

  async detect(): Promise<{ version: string; path: string } | null> {
    const path = which(this.command, [join(homedir(), '.opencode', 'bin')]);
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
    const state = newOpenCodeState();
    let errorTimer: NodeJS.Timeout | undefined;
    return launchLineProcess({
      command: this.path ?? this.command,
      args: buildOpenCodeArgs(spec),
      cwd: spec.workDir,
      env: spec.env,
      logsDir: spec.logsDir,
      onSpawn: (child) => child.stdin?.end(),
      onStdoutLine: (line, ctl) => {
        if (errorTimer) clearTimeout(errorTimer);
        const events = parseOpenCodeLine(line, state);
        for (const e of events) ctl.emit(e);
        if (events.some((e) => e.type === 'error')) errorTimer = setTimeout(() => void ctl.kill(), ERROR_EXIT_GRACE_MS);
      },
      onStderr: (chunk, ctl) => {
        const fatal = fatalStderrLine(chunk);
        if (fatal && !state.errors.includes(fatal)) {
          state.errors.push(fatal);
          ctl.emit({ type: 'error', content: fatal, at: nowIso() });
          void ctl.kill();
        }
      },
      finish: (info) => {
        if (errorTimer) clearTimeout(errorTimer);
        const failed = info.spawnError !== undefined || info.exitCode !== 0 || state.errors.length > 0;
        const stderrErrors = info.stderrTail
          .split('\n')
          .filter((l) => /level=ERROR|^Error|error:/i.test(l))
          .slice(-5)
          .join('\n');
        const errorText = failed ? [info.spawnError?.message, ...state.errors, stderrErrors].filter(Boolean).join('\n') : undefined;
        const resumeRejected = Boolean(spec.resumeSessionId && failed && RESUME_REJECTED.test(`${errorText}\n${info.stderrTail}`));
        return {
          exitCode: info.exitCode,
          signal: info.signal,
          sessionId: resumeRejected ? undefined : state.sessionId,
          usage: openCodeUsage(state, spec.model),
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
