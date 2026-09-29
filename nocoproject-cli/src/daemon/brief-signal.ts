/**
 * The turn-prompt lines of a `signal` trigger (protocol.phase2-signals.ts): an outside system reported that the
 * issue's linked object needs its executor, and a rule the workspace configured woke this agent. The daemon knows no
 * source: the server sends the title, the link and the rendered instruction. Pure string builder.
 */
import type { ClaimedRunV1 } from '../run-context.js';

type PromptInput = Pick<ClaimedRunV1, 'triggers'>;

/** The lines a `signal` trigger adds to the turn prompt. */
export function signalLines(trigger: PromptInput['triggers'][number], quote: (text: string) => string): string[] {
  const signal = trigger.signal;
  if (!signal) return ['[SIGNAL] Something linked to this issue needs your attention; read the issue to find out what.'];
  const link = signal.url ? ` — ${signal.url}` : '';
  const lines = [
    `[SIGNAL] ${signal.title || signal.kind}${link} (\`${signal.kind}\`).`,
    'A rule the workspace configured woke you for this; it will not wake you again for the same occurrence, and it stops after a few attempts in a row.',
  ];
  const instruction = signal.instruction?.trim();
  if (instruction) lines.push('Instruction:', quote(instruction));
  return lines;
}
