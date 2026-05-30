/**
 * Declarative map of SPA page → on-mount API GET calls.
 *
 * UPDATE THIS FILE when a new SPA route is added or an existing page's
 * primary mount-call changes. See frontend/src/App.tsx for the route
 * registry. Note: keep entries to unconditional GET-on-mount calls only —
 * conditional or user-state-dependent calls are out of scope.
 */

export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

// Verified against frontend/src/App.tsx and page component useEffect hooks.
export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary/dashboard', '/api/summary/monthly'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/portfolio', apis: ['/api/portfolio'] },
  { page: '/net-worth', apis: ['/api/net-worth/current'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/rules', apis: ['/api/rules'] },
  { page: '/audit-log', apis: ['/api/audit-log'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/calendar', apis: ['/api/planned-events'] },
  { page: '/recurring', apis: ['/api/recurring'] },
  { page: '/subscriptions', apis: ['/api/subscriptions'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/settings', apis: ['/api/household'] },
];
