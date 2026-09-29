import type { ReactElement } from 'react';

import { MyIssuesTab } from './my-issues-tab.js';

/** Tab `/my-issues/owned` (I own): issues whose owner is the viewer. */
export default function MyOwnedIssues(): ReactElement {
  return <MyIssuesTab role='owned' />;
}
