import type { ReactElement } from 'react';

import { MyIssuesTab } from './my-issues-tab.js';

/** Tab `/my-issues/executing` (I execute): issues the viewer executes in person. */
export default function MyExecutingIssues(): ReactElement {
  return <MyIssuesTab role='executing' />;
}
