// SPA page → API calls made on mount.
// Keep in sync with frontend/src/App.tsx route registry.
// Adding a new SPA page = add one entry here.
export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/net-worth', apis: ['/api/net-worth'] },
  { page: '/portfolio', apis: ['/api/portfolio/daily-snapshot'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/calendar', apis: ['/api/calendar'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/audit-log', apis: ['/api/audit-log?limit=1'] },
  { page: '/settings/display', apis: ['/api/preferences'] },
  { page: '/settings/jobs', apis: ['/api/jobs'] },
  { page: '/notifications', apis: ['/api/notifications?limit=1'] },
];
