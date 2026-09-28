import type { ModelPrice } from '../types.js';

/**
 * The model price table of the NocoProject settings (iteration 2 §I): US dollars per million tokens, matched against
 * a run's model by glob (`claude-*`). Kept as text while editing so a half-typed number is not lost.
 */

export const PRICE_FIELDS = [
  'inputPerM',
  'outputPerM',
  'cacheReadPerM',
  'cacheWritePerM',
] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

export interface PriceDraft {
  readonly key: string;
  readonly provider: string;
  readonly model: string;
  readonly inputPerM: string;
  readonly outputPerM: string;
  readonly cacheReadPerM: string;
  readonly cacheWritePerM: string;
}

let seed = 0;
export function priceDraft(price?: ModelPrice): PriceDraft {
  seed += 1;
  return {
    key: `price-${seed}`,
    provider: price?.provider ?? '',
    model: price?.model ?? '',
    inputPerM: price ? String(price.inputPerM) : '',
    outputPerM: price ? String(price.outputPerM) : '',
    cacheReadPerM: price ? String(price.cacheReadPerM) : '',
    cacheWritePerM: price ? String(price.cacheWritePerM) : '',
  };
}

function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export type PriceProblem = 'modelRequired' | 'invalidNumber';

export function priceProblems(draft: PriceDraft): PriceProblem[] {
  const problems: PriceProblem[] = [];
  if (!draft.model.trim()) problems.push('modelRequired');
  if (PRICE_FIELDS.some((field) => parsePrice(draft[field]) === null)) {
    problems.push('invalidNumber');
  }
  return problems;
}

/** The drafts as `ModelPrice[]`, or null while any row has a problem. Empty numbers count as 0. */
export function pricesFromDrafts(
  drafts: readonly PriceDraft[],
): ModelPrice[] | null {
  if (drafts.some((draft) => priceProblems(draft).length > 0)) return null;
  return drafts.map((draft) => ({
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    inputPerM: parsePrice(draft.inputPerM) ?? 0,
    outputPerM: parsePrice(draft.outputPerM) ?? 0,
    cacheReadPerM: parsePrice(draft.cacheReadPerM) ?? 0,
    cacheWritePerM: parsePrice(draft.cacheWritePerM) ?? 0,
  }));
}
