/**
 * The English names of the two runtime types, for briefs and error messages (NP-219, protocol-runtime-types.md §1).
 * The AI plugin is going to be renamed: these names (and the browser's `np.runtimeType.*` locale group) are the only
 * places to change then.
 */
import type { RuntimeType } from './protocol.js';

export const RUNTIME_TYPE_AGENT_NAMES: Readonly<Record<RuntimeType, string>> = {
  computer: 'Computer agent',
  builtin: 'Built-in agent',
};

export const RUNTIME_TYPE_RUNTIME_NAMES: Readonly<Record<RuntimeType, string>> =
  {
    computer: 'Computer runtime',
    builtin: 'Built-in runtime',
  };
