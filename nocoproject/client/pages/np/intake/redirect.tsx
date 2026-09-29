import type { ReactElement } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';

import { newIssueRedirectTarget } from '../issues/new-issue-model.js';

/**
 * Routes `/intake`, `/issues/intake` and `/projects/:projectId/intake`: batch entry is the AI draft tab of "New
 * issue" since iteration 4 §D, so old links and "Batch add" bookmarks open that tab with the project preselected and any
 * `?batch=` kept.
 */
export default function IntakeRedirect(): ReactElement {
  const location = useLocation();
  const { projectId } = useParams();
  return (
    <Navigate replace to={newIssueRedirectTarget(location.search, projectId)} />
  );
}
