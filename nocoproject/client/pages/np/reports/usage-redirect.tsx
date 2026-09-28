import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router';

/** Route `/usage`: iteration 2's usage page, now the 用量 tab of `/reports` (§G). The range and grouping carry over. */
export default function UsageRedirect(): ReactElement {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={{ pathname: '/reports/usage', search: location.search }}
    />
  );
}
