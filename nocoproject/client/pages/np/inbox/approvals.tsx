import type { ReactElement } from 'react';
import { Navigate } from 'react-router';

/**
 * Route `/inbox/approvals`: iteration 2's list of approvals waiting for the viewer. Since iteration 3 §E approvals
 * are decisions acted on inline in the inbox, so the old address opens the decisions tab.
 */
export default function ApprovalsRedirect(): ReactElement {
  return <Navigate replace to='/inbox' />;
}
