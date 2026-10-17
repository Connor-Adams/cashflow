import { useEffect, useRef, useState } from 'react';

interface StarterScenarioOptions {
  /** Identifies the scenario list, e.g. `${entityId}:${year}`. One attempt per key. */
  key: string;
  loading: boolean;
  empty: boolean;
  create: () => Promise<unknown>;
}

/**
 * Auto-creates a starter scenario when a year's scenario list loads empty, so the
 * baseline materialises and there is something to edit immediately.
 *
 * Attempts at most once per key. It used to re-fire whenever the POST settled
 * with the list still empty, so a failing POST retried forever and the failure
 * only reached the console. Returns the failure message for the current key.
 */
export function useStarterScenario({ key, loading, empty, create }: StarterScenarioOptions): string | null {
  const attempted = useRef<Set<string>>(new Set());
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (loading || !empty || attempted.current.has(key)) return;
    attempted.current.add(key);
    create().catch((err: unknown) => {
      setFailure({ key, message: err instanceof Error ? err.message : String(err) });
    });
  }, [key, loading, empty, create]);

  return failure?.key === key ? failure.message : null;
}
