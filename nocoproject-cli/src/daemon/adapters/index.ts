import type { AgentProvider } from '../../protocol.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { EchoAdapter } from './echo.js';
import { OpenCodeAdapter } from './opencode.js';
import type { AgentAdapter } from './types.js';

export * from './types.js';

/** Providers registered by default; `echo` only when explicitly requested. */
export const DEFAULT_PROVIDERS: readonly AgentProvider[] = ['claude', 'opencode', 'codex'];

export function createAdapter(provider: string): AgentAdapter | null {
  switch (provider) {
    case 'claude':
      return new ClaudeAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'echo':
      return new EchoAdapter();
    default:
      return null;
  }
}

export interface DetectedAdapter {
  readonly adapter: AgentAdapter;
  readonly version: string;
  readonly path: string;
}

/** Detects the requested providers; unknown or missing tools are skipped. */
export async function detectAdapters(providers: readonly string[] = DEFAULT_PROVIDERS): Promise<{
  detected: DetectedAdapter[];
  missing: string[];
}> {
  const detected: DetectedAdapter[] = [];
  const missing: string[] = [];
  for (const provider of providers) {
    const adapter = createAdapter(provider);
    const found = adapter ? await adapter.detect() : null;
    if (adapter && found) detected.push({ adapter, ...found });
    else missing.push(provider);
  }
  return { detected, missing };
}
