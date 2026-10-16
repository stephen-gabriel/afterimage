import { useSearchParams } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

export function useUrlState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const get = useCallback((key: string): string | null => {
    return searchParams.get(key);
  }, [searchParams]);

  const set = useCallback((key: string, value: string | null) => {
    setSearchParams((prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  }, [setSearchParams]);

  const setMultiple = useCallback((updates: Record<string, string | null>) => {
    setSearchParams((prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      });
      return next;
    });
  }, [setSearchParams]);

  const tab = useMemo(() => searchParams.get('tab') ?? 'status', [searchParams]);
  const runId = useMemo(() => searchParams.get('run'), [searchParams]);
  const inspectId = useMemo(() => searchParams.get('inspect'), [searchParams]);
  const changeType = useMemo(() => searchParams.get('change'), [searchParams]);

  return {
    tab,
    setTab: (t: string) => set('tab', t),
    runId,
    setRunId: (id: string | null) => set('run', id),
    inspectId,
    setInspectId: (id: string | null) => set('inspect', id),
    changeType,
    setChangeType: (t: string | null) => set('change', t),
    get,
    set,
    setMultiple,
  };
}