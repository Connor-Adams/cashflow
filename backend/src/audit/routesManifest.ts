export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/portfolio', apis: ['/api/portfolio'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/budgets', apis: ['/api/budgets'] },
  { page: '/subscriptions', apis: ['/api/subscriptions'] },
  { page: '/forecast', apis: ['/api/forecast'] },
  { page: '/money-leaks', apis: ['/api/money-leaks'] },
  { page: '/planned', apis: ['/api/planned-events'] },
  { page: '/calendar', apis: ['/api/calendar/events'] },
  { page: '/recurring', apis: ['/api/recurring'] },
  { page: '/settings/imports', apis: ['/api/import/history'] },
  { page: '/settings/jobs', apis: ['/api/jobs'] },
];
