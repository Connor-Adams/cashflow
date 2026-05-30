export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/portfolio', apis: ['/api/portfolio'] },
  { page: '/net-worth', apis: ['/api/net-worth'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/calendar', apis: ['/api/calendar'] },
  { page: '/insights', apis: ['/api/insights'] },
  { page: '/audit-log', apis: ['/api/audit-log?limit=1'] },
  { page: '/settings', apis: ['/api/settings/cashflow'] },
];
