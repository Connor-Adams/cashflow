export interface RouteProbeSpec {
  page: string;
  apis: string[];
}

// SPA routes from frontend/src/App.tsx. Only includes GET calls that fire on
// mount regardless of user state. Routes requiring dynamic params (e.g.
// /portfolio/security/:id, /import/:batchId) are excluded.
export const ROUTE_MANIFEST: RouteProbeSpec[] = [
  { page: '/', apis: ['/api/summary'] },
  { page: '/transactions', apis: ['/api/transactions?limit=1'] },
  { page: '/accounts', apis: ['/api/accounts'] },
  { page: '/recurring', apis: ['/api/recurring'] },
  { page: '/subscriptions', apis: ['/api/subscriptions'] },
  { page: '/budgets', apis: ['/api/budgets'] },
  { page: '/goals', apis: ['/api/goals'] },
  { page: '/net-worth', apis: ['/api/net-worth'] },
  { page: '/reports', apis: ['/api/reports/savings-rate'] },
  { page: '/rules', apis: ['/api/rules'] },
  { page: '/categories', apis: ['/api/categories'] },
  { page: '/contacts', apis: ['/api/contacts'] },
];
