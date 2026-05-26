export type ReconciliationSeverity = 'info' | 'warning' | 'error';

export type ReconciliationCategory =
  | 'missing_slip'
  | 'slip_divergence'
  | 'category_misclass';

/**
 * A single detected reconciliation issue for a tax year.
 * `subjectRef` is a human-readable pointer ("Transaction #1234", "T4 from
 * EMPLOYER INC."); `details` is structured for the UI to render contextually.
 */
export interface ReconciliationFinding {
  category: ReconciliationCategory;
  severity: ReconciliationSeverity;
  subjectRef: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReconciliationReport {
  entityId: number;
  year: number;
  generatedAt: string;
  findings: ReconciliationFinding[];
  counts: Record<ReconciliationCategory, number>;
}
