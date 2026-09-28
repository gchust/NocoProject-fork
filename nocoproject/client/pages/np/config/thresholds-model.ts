import { DEFAULT_METRIC_THRESHOLDS } from '../api-iter3.js';
import type { MetricThresholds } from '../types-iter3.js';

/**
 * The metric thresholds form (§C `settings.metricThresholds`): rates are edited as percentages, the resolve time in
 * hours, the claim latency in milliseconds. Values are kept as the typed strings until saved.
 */
export interface ThresholdDraft {
  readonly aiShare: string;
  readonly proposalAcceptRate: string;
  readonly claimLatencyP50Ms: string;
  readonly lostRuns: string;
  readonly decisionResolveHours: string;
}

export const THRESHOLD_FIELDS: readonly (keyof ThresholdDraft)[] = [
  'aiShare',
  'proposalAcceptRate',
  'claimLatencyP50Ms',
  'lostRuns',
  'decisionResolveHours',
];

const HOUR = 3_600_000;

function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function thresholdDraft(
  thresholds: MetricThresholds | undefined,
): ThresholdDraft {
  const value = { ...DEFAULT_METRIC_THRESHOLDS, ...thresholds };
  return {
    aiShare: trim((value.aiShare ?? 0) * 100),
    proposalAcceptRate: trim((value.proposalAcceptRate ?? 0) * 100),
    claimLatencyP50Ms: trim(value.claimLatencyP50Ms ?? 0),
    lostRuns: trim(value.lostRuns ?? 0),
    decisionResolveHours: trim((value.decisionResolveP50Ms ?? 0) / HOUR),
  };
}

/** The thresholds to save, or null while a field is not a number in range (rates 0–100, the rest ≥ 0). */
export function thresholdsFromDraft(
  draft: ThresholdDraft,
): MetricThresholds | null {
  const numbers: Record<string, number> = {};
  for (const field of THRESHOLD_FIELDS) {
    const text = draft[field].trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value) || value < 0) return null;
    if (
      (field === 'aiShare' || field === 'proposalAcceptRate') &&
      value > 100
    ) {
      return null;
    }
    numbers[field] = value;
  }
  return {
    aiShare: numbers.aiShare / 100,
    proposalAcceptRate: numbers.proposalAcceptRate / 100,
    claimLatencyP50Ms: numbers.claimLatencyP50Ms,
    lostRuns: numbers.lostRuns,
    decisionResolveP50Ms: numbers.decisionResolveHours * HOUR,
  };
}
