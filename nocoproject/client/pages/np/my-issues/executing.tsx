import type { ReactElement } from 'react';

import { MyIssuesTab } from './my-issues-tab.js';

/** Tab `/my-issues/executing` (我执行的): issues the viewer executes in person. */
export default function MyExecutingIssues(): ReactElement {
  return <MyIssuesTab role='executing' />;
}
