import { useState } from 'react';

export type AgentsGrouping = 'list' | 'computer';

const STORAGE_KEY = 'nocoproject:agents-grouping';

function readGrouping(): AgentsGrouping {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'computer'
      ? 'computer'
      : 'list';
  } catch {
    return 'list';
  }
}

/** NP-188: the agents list's flat / by-computer choice, remembered in `localStorage`. */
export function useAgentsGrouping(): [
  AgentsGrouping,
  (next: AgentsGrouping) => void,
] {
  const [grouping, setGrouping] = useState<AgentsGrouping>(readGrouping);
  const change = (next: AgentsGrouping) => {
    setGrouping(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts for this visit.
    }
  };
  return [grouping, change];
}
