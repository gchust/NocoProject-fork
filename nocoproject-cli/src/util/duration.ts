/**
 * Parses durations like `2h`, `30m`, `45s`, `1500ms`, `1h30m`; a bare number means seconds.
 * Returns milliseconds, or `fallback` when the input is empty or invalid. `0` means disabled.
 */
export function parseDuration(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const text = input.trim().toLowerCase();
  if (!text) return fallback;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    const unit = match[2];
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    consumed += match[0].length;
  }
  return consumed === text.length ? Math.round(total) : fallback;
}

export function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (input === undefined || input.trim() === '') return fallback;
  const n = Number(input);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
