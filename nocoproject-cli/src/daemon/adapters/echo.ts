/**
 * Echo adapter: launches the bundled fake agent (`dist/echo-agent.js`) with node. It uses
 * the real `nocoproject issue ...` commands with the run token, so it exercises the whole
 * loop without any AI provider. NDJSON events on stdout:
 *   {type:'text',text} {type:'tool_use',id,name,input} {type:'tool_result',id,output,is_error}
 *   {type:'result',session_id,text,usage} {type:'error',message}
 */
import { existsSync } from 'node:fs';
import type { RunUsageInput } from '../../protocol.js';
import { distPath } from '../../util/paths.js';
import { CLI_VERSION } from '../../version.js';
import { launchLineProcess } from './spawn.js';
import { nowIso, type AdapterCapabilities, type AgentAdapter, type AgentEvent, type RunHandle, type RunSpec } from './types.js';

export interface EchoParseState {
  sessionId?: string;
  summary?: string;
  usage?: RunUsageInput;
  errors: string[];
  visible: number;
  sawResult: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function parseEchoLine(line: string, state: EchoParseState, at = nowIso()): AgentEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];
  let events: AgentEvent[] = [];
  switch (msg.type) {
    case 'text':
      events = [{ type: 'text', content: str(msg.text) ?? '', at }];
      break;
    case 'tool_use':
      events = [{ type: 'toolUse', tool: str(msg.name) ?? 'shell', callId: str(msg.id), input: msg.input ?? {}, at }];
      break;
    case 'tool_result':
      events = [{ type: 'toolResult', callId: str(msg.id), output: `${msg.is_error ? '[error] ' : ''}${str(msg.output) ?? ''}`, at }];
      break;
    case 'result': {
      state.sawResult = true;
      state.sessionId = str(msg.session_id);
      state.summary = str(msg.text);
      const u = isObj(msg.usage) ? msg.usage : {};
      state.usage = { provider: 'echo', model: 'echo', inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0) };
      return [];
    }
    case 'error':
      state.errors.push(str(msg.message) ?? 'echo agent error');
      return [{ type: 'error', content: str(msg.message) ?? 'echo agent error', at }];
    default:
      return [];
  }
  state.visible += events.length;
  return events;
}

export class EchoAdapter implements AgentAdapter {
  readonly provider = 'echo' as const;

  async detect(): Promise<{ version: string; path: string } | null> {
    const path = distPath('echo-agent.js');
    return existsSync(path) ? { version: CLI_VERSION, path } : null;
  }

  capabilities(): AdapterCapabilities {
    return { resume: true, steering: false, briefFile: 'AGENTS.md' };
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const state: EchoParseState = { errors: [], visible: 0, sawResult: false };
    const args = [distPath('echo-agent.js'), spec.prompt];
    if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
    return launchLineProcess({
      command: process.execPath,
      args,
      cwd: spec.workDir,
      env: { ...spec.env, NOCOPROJECT_CLI_PATH: distPath('cli.js') },
      logsDir: spec.logsDir,
      onSpawn: (child) => child.stdin?.end(),
      onStdoutLine: (line, ctl) => {
        for (const e of parseEchoLine(line, state)) ctl.emit(e);
      },
      finish: (info) => {
        const failed = info.spawnError !== undefined || info.exitCode !== 0 || !state.sawResult;
        return {
          exitCode: info.exitCode,
          signal: info.signal,
          sessionId: state.sessionId,
          usage: state.usage,
          errorText: failed ? [info.spawnError?.message, ...state.errors, info.stderrTail.trim()].filter(Boolean).join('\n') : undefined,
          stderrTail: info.stderrTail,
          summary: state.summary,
          visibleEvents: state.visible,
        };
      },
    });
  }
}
