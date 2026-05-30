// Each entry maps a SPA page (path from App.tsx) to the unconditional GET
// calls it fires on mount. Update this manifest whenever a new page is added
// to frontend/src/App.tsx.
export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary/dashboard'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/recurring', apis: ['/api/recurring'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/net-worth', apis: ['/api/net-worth/current'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/audit-log', apis: ['/api/audit-log'] },
];
