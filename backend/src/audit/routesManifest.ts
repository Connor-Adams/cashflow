// Keep this manifest in sync with frontend/src/App.tsx route registry.
// When a new SPA route is added, add a corresponding entry here.
export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary/dashboard'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/portfolio', apis: ['/api/portfolio'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/net-worth', apis: ['/api/net-worth/current'] },
  { page: '/calendar', apis: ['/api/calendar/events'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/audit-log', apis: ['/api/audit-log?limit=1'] },
  { page: '/settings', apis: ['/api/accounts'] },
];
